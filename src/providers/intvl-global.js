import { CFG } from "../config.js";
import { LayerProvider } from "../layers/provider-factories.js";
import { gmCancel, gmGet } from "../utils/http.js";
import { _safeColor } from "../utils/html.js";
import { pointInRing, intvlActivityTime, intvlAgo, intvlArea } from "../utils/intvl.js";
import { mvtDecode, prepareLayers } from "../utils/mvt.js";

/* -- INTVL Global Map (public Mapbox Vector Tile pyramid) ------------
 *
 * Renders the INTVL app's public global territory map: every cell
 * owned by whoever last ran a closed loop around it. URL pattern
 * (`/single-player/run/{z}/{x}/{y}.pbf`) reverse-engineered from
 * v3.4.3 APK; CFG.INTVL_TILES_BASE carries the resolved base and
 * CFG.INTVL_TILES_MAX_NATIVE_Z carries the actual native max zoom (11).
 *
 * Tile contents: MVT layer `territories` with POLYGON features whose
 * props are { runId, activityId, colour, currentArea (m²), startTime
 * (integer day count against a custom ~1977-09-03 app epoch, i.e. 2802
 * days behind the Unix day number — see
 * CFG.INTVL_START_TIME_EPOCH_OFFSET_DAYS) }. Extent 4096.
 *
 * Renderer: per Leaflet tile, fetch the .pbf, run mvtDecode →
 * prepareLayers, paint each polygon's fill onto a canvas (no library).
 * The old auth-gated "your runs only" layer was removed in 7.9.5 —
 * unknown overlay names in localStorage are silently skipped by the
 * restorer, so no migration is needed.
 */

// ------ INTVL Global Map layer ---------------------------------------

// Stable cache key for a Leaflet tile coord. Used in both the renderer
// (to stash the prepared layer) and the hover-identify (to look it up
// again), so a helper avoids any chance of drift between the two.
const tileKey = (z, x, y) => `${z}/${x}/${y}`;

/* -- INTVL hover formatting helpers ----------------------------------
 *
 * The public tiles ship only { runId, activityId, colour, currentArea,
 * startTime } — deliberately anonymised: there is NO username/userId in
 * the data and NO public way to resolve one. Confirmed by enumerating
 * the INTVL tRPC router at https://www.intvl.com.au/api/trpc — every
 * run/user lookup (run.getRun, user.getRun, user.byId,
 * user.byIdProfileImage, …) requires BOTH a Clerk login AND a `userId`
 * the tiles never carry, so runId/activityId cannot be turned into a
 * name without an authed session that already knows the owner. So we
 * make the data we DO have as useful as possible instead.
 *
 * One bonus: most activityIds are cuid v1 (`c` + 8 base36 chars of
 * creation-time ms + counter/fingerprint/random). Decoding that recovers
 * the precise time-of-day the run was recorded — `startTime` itself is
 * only day-resolution. Older rows use a different id scheme; we sanity-
 * check the decoded date and silently skip when it isn't a sane cuid. */
export class IntvlGlobalTilesLayerProvider extends LayerProvider {
	create() {
		const TILE_PX = 256;
		const FILL_ALPHA = 0.55;

		const IntvlGlobalGrid = L.GridLayer.extend({
			onAdd(map) {
				if (!map.getPane("dwIntvlGlobalPane")) {
					map.createPane("dwIntvlGlobalPane");
					map.getPane("dwIntvlGlobalPane").style.zIndex = "404";
					// Pane is non-interactive so the underlying map
					// still receives waypoint clicks. The hover-identify
					// listens on the map's mousemove directly.
					map.getPane("dwIntvlGlobalPane").style.pointerEvents = "none";
				}
				L.GridLayer.prototype.onAdd.call(this, map);

				// Hover-identify: debounced mousemove → ray-cast against
				// the cached, pre-decoded polygons of the tile under the
				// cursor. Reusing the prepared per-tile feature list (the
				// same one the renderer drew from) means no MVT decode
				// in the hot path.
				//
				// Skip wiring on touch-primary devices. Browsers synthesise
				// `mousemove` during touch-drag panning, which makes every
				// pan run identify and pop a tooltip; the tooltip then
				// lingers because `mouseout` doesn't fire on touch-end.
				// `(hover: none)` is the standards-track "no hover capability"
				// signal; we fall back to Leaflet's UA-based mobile flag.
				const noHover = L.Browser.mobile ||
					(window.matchMedia && window.matchMedia("(hover: none)").matches);
				this._tooltip = L.tooltip({
					sticky:    true,
					opacity:   0.95,
					className: "dw-intvl-tip",
					direction: noHover ? "auto" : "right",
					offset:    [12, 0],
				});
				this._hoverDebounce = null;
				this._lastFeatKey   = null;

				if (!noHover) {
					this._onMove = (e) => {
						// Leaflet occasionally fires mousemove from layer
						// cascade events (e.g. when a layer add triggers
						// re-projection) without a real latlng — guard so
						// the debounced identify call never blows up.
						if (!e?.latlng) return;
						clearTimeout(this._hoverDebounce);
						const latlng = e.latlng;
						this._hoverDebounce = setTimeout(
							() => this._identifyHover(latlng), 60);
					};
					this._onLeave = () => {
						clearTimeout(this._hoverDebounce);
						this._clearTooltip();
					};
					map.on("mousemove", this._onMove);
					map.on("mouseout",  this._onLeave);
				} else {
					const container = map.getContainer();
					this._press = null;
					this._onPressDown = (event) => {
						if (event.target && event.target.closest && event.target.closest(
							".leaflet-control,.leaflet-popup,.leaflet-marker-icon,.leaflet-interactive")) return;
						if (event.pointerType !== "touch" || event.isPrimary === false) {
							this._cancelPress(); return;
						}
						this._cancelPress();
						this._clearTooltip();
						const press = this._press = {
							pointerId: event.pointerId, x: event.clientX, y: event.clientY,
							latlng: map.mouseEventToLatLng(event), active: false, timer: null,
						};
						press.timer = setTimeout(() => {
							if (this._press !== press || !this._map) return;
							this._identifyHover(press.latlng);
							press.active = !!(this._tooltip && this._tooltip._map);
						}, 550);
					};
					this._onPressMove = (event) => {
						const press = this._press;
						if (!press || press.pointerId !== event.pointerId) return;
						if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10) {
							this._cancelPress();
						}
					};
					this._onPressEnd = (event) => {
						const press = this._press;
						if (!press || press.pointerId !== event.pointerId) return;
						clearTimeout(press.timer);
						if (press.active) {
							this._suppressPressClick = {
								x: event.clientX, y: event.clientY, until: Date.now() + 800,
							};
						}
						this._press = null;
					};
					this._onPressCancel = () => this._cancelPress();
					this._onPressClick = (event) => {
						const suppress = this._suppressPressClick;
						if (!suppress || Date.now() > suppress.until ||
							Math.hypot(event.clientX - suppress.x, event.clientY - suppress.y) > 16) return;
						this._suppressPressClick = null;
						event.preventDefault();
						event.stopImmediatePropagation();
					};
					this._onPressContext = (event) => {
						const press = this._press;
						if (press) clearTimeout(press.timer);
						this._identifyHover(map.mouseEventToLatLng(event));
						const identified = !!(this._tooltip && this._tooltip._map);
						if (press) press.active = identified;
						if (identified) {
							this._suppressPressClick = {
								x: event.clientX, y: event.clientY, until: Date.now() + 800,
							};
							event.preventDefault();
							event.stopImmediatePropagation();
						}
					};
					this._onPressDragStart = () => {
						this._cancelPress();
						this._clearTooltip();
					};
					container.addEventListener("pointerdown", this._onPressDown, true);
					container.addEventListener("pointermove", this._onPressMove, true);
					container.addEventListener("pointerup", this._onPressEnd, true);
					container.addEventListener("pointercancel", this._onPressCancel, true);
					container.addEventListener("click", this._onPressClick, true);
					container.addEventListener("contextmenu", this._onPressContext, true);
					map.on("dragstart zoomstart", this._onPressDragStart);
				}

				// Free a tile's prepared feature data when Leaflet
				// evicts the tile from its cache. Without this the
				// Map grows unbounded — every panned-away tile leaks
				// its prepared features (200-500 polygons each, with
				// nested vertex arrays) for the rest of the session.
				this._onTileUnload = (e) => {
					// Abort the in-flight pbf fetch so a fast pan doesn't
					// keep streaming bytes for tiles Leaflet has already
					// discarded — biggest win on flaky mobile networks.
					if (e.tile && e.tile._dwHandle) {
						gmCancel(e.tile._dwHandle);
						e.tile._dwHandle = null;
					}
					if (!this._tileFeatures) return;
					const c = e.coords;
					this._tileFeatures.delete(tileKey(c.z, c.x, c.y));
				};
				this.on("tileunload", this._onTileUnload);
			},

			onRemove(map) {
				clearTimeout(this._hoverDebounce);
				this._cancelPress();
				if (this._onMove) {
					map.off("mousemove", this._onMove);
					map.off("mouseout",  this._onLeave);
				}
				if (this._onPressDown) {
					const container = map.getContainer();
					container.removeEventListener("pointerdown", this._onPressDown, true);
					container.removeEventListener("pointermove", this._onPressMove, true);
					container.removeEventListener("pointerup", this._onPressEnd, true);
					container.removeEventListener("pointercancel", this._onPressCancel, true);
					container.removeEventListener("click", this._onPressClick, true);
					container.removeEventListener("contextmenu", this._onPressContext, true);
					map.off("dragstart zoomstart", this._onPressDragStart);
				}
				this.off("tileunload", this._onTileUnload);
				this._clearTooltip();
				this._tooltip = null;
				this._tileFeatures && this._tileFeatures.clear();
				L.GridLayer.prototype.onRemove.call(this, map);
			},

			_cancelPress() {
				if (this._press) clearTimeout(this._press.timer);
				this._press = null;
			},

			_clearTooltip() {
				if (this._tooltip && this._tooltip._map) this._tooltip.remove();
				this._lastFeatKey = null;
			},

			createTile(coords, done) {
				const canvas = L.DomUtil.create("canvas", "leaflet-tile");
				// Internal canvas resolution is multiplied by devicePixelRatio
				// so the polygon edges stay crisp on HiDPI displays. CSS size
				// stays at TILE_PX (256px logical) — Leaflet places the tile
				// at logical-pixel coordinates and the browser samples the
				// higher-resolution backing store.
				const dpr = Math.max(1, window.devicePixelRatio || 1);
				canvas.width  = TILE_PX * dpr;
				canvas.height = TILE_PX * dpr;
				canvas.style.width  = TILE_PX + "px";
				canvas.style.height = TILE_PX + "px";
				const ctx = canvas.getContext("2d");
				ctx.scale(dpr, dpr);

				// Leaflet caps `coords.z` to maxNativeZoom and scales the
				// canvas in CSS for over-zoom, so we just fetch at
				// coords.z directly — no manual sub-tile cropping needed.
				const url =
					`${CFG.INTVL_TILES_BASE}/${coords.z}/${coords.x}/${coords.y}.pbf`;

				canvas._dwHandle = gmGet(url, {
					responseType: "arraybuffer",
					timeout: 15000,
				}, (err, r) => {
					canvas._dwHandle = null;
					// 404 (no coverage) and network errors both render empty —
					// caller relies on a canvas-shaped tile either way.
					if (err || r.status !== 200 || !r.response) {
						safeDone(); return;
					}
					try {
						const layers   = mvtDecode(r.response);
						const prepared = prepareLayers(layers, FILL_ALPHA);
						this._renderTile(ctx, prepared, TILE_PX);
						if (!this._tileFeatures) this._tileFeatures = new Map();
						this._tileFeatures.set(
							tileKey(coords.z, coords.x, coords.y), prepared);
					} catch (e) {
						console.warn("[CustomTiles] INTVL global decode:", e);
					}
					safeDone();
				});
				// Guard against the case where a rapid layer-toggle (or
				// 3D mode hide/show) evicts the tile after the request
				// fired but before it resolved. Leaflet's _tileReady
				// then null-derefs the tile element. Wrap done() so
				// the unmount race doesn't surface as a runtime error.
				function safeDone() {
					try { done(null, canvas); }
					catch (e) {
						// Only swallow the specific null-tile race; rethrow others.
						if (!String(e?.message || "").includes("style")) throw e;
					}
				}

				return canvas;
			},

			_renderTile(ctx, prepared, tilePx) {
				ctx.clearRect(0, 0, tilePx, tilePx);
				// No explicit clip — canvas clips naturally at its bounds.
				// Features are pre-sorted by startTime ASC so older claims
				// paint first and the latest claim ends up on top —
				// resolves "last runner owns it" consistently within each
				// tile. Adjacent tile seams can still show colour breaks
				// when the server didn't include the same polygons in
				// both tiles (server-side MVT generation quirk); fill
				// alone, with no per-polygon stroke, makes those
				// transitions read as natural colour boundaries rather
				// than emphasised outlines. Nonzero winding rule (canvas
				// default) matches MVT's outer-CW / inner-CCW convention.
				for (const layer of prepared) {
					const scale = tilePx / layer.extent;
					for (const f of layer.features) {
						ctx.beginPath();
						for (const ring of f.rings) {
							if (ring.length < 3) continue;
							let started = false;
							for (const [tx, ty] of ring) {
								const px = tx * scale, py = ty * scale;
								if (!started) { ctx.moveTo(px, py); started = true; }
								else ctx.lineTo(px, py);
							}
							ctx.closePath();
						}
						ctx.fillStyle = f.fillStyle;
						ctx.fill();
					}
				}
			},

			_identifyHover(latlng) {
				if (!this._tileFeatures || !this._tileFeatures.size) return;
				const map = this._map;
				if (!map || !this._tooltip) return;
				const z       = map.getZoom();
				const cappedZ = Math.min(z, CFG.INTVL_TILES_MAX_NATIVE_Z);

				// Project to pixel coords at the FETCH zoom — that's the
				// zoom the cached tile data is keyed at.
				const proj   = map.project(latlng, cappedZ);
				const tileX  = Math.floor(proj.x / TILE_PX);
				const tileY  = Math.floor(proj.y / TILE_PX);

				const prepared = this._tileFeatures.get(
					tileKey(cappedZ, tileX, tileY));
				if (!prepared) { this._clearTooltip(); return; }

				for (const layer of prepared) {
					// Convert the click point ONCE from canvas pixels to
					// MVT-extent coords (0..extent). Then per-feature
					// bbox tests and the ray-cast work directly on the
					// raw stored rings — no per-vertex Array allocation,
					// no per-ring `.map()`. With ~200 features per tile
					// at z=11 this drops hover work from O(rings·verts)
					// to O(features) for the common case where the
					// cursor is outside the feature's bbox.
					const scaleInv = layer.extent / TILE_PX;
					const ex = (proj.x - tileX * TILE_PX) * scaleInv;
					const ey = (proj.y - tileY * TILE_PX) * scaleInv;

					// Walk newest-first (reverse of paint order): the
					// topmost rendered polygon is the "owner" at this point.
					for (let fi = layer.features.length - 1; fi >= 0; fi--) {
						const f = layer.features[fi];
						if (ex < f.mnX || ex > f.mxX ||
						    ey < f.mnY || ey > f.mxY) continue;

						let inside = false;
						for (const ring of f.rings) {
							if (ring.length < 3) continue;
							if (pointInRing(ex, ey, ring)) inside = !inside;
						}
						if (!inside) continue;

						const featKey = tileKey(cappedZ, tileX, tileY) + "/" + fi;
						if (featKey === this._lastFeatKey) {
							this._tooltip.setLatLng(latlng);
							return;
						}
						this._lastFeatKey = featKey;

						const area = intvlArea(f.props.currentArea);

						// Captured date from startTime (day-resolution) —
						// startTime is an integer day count against a custom
						// app epoch (~1977-09-03), not the Unix epoch, so
						// shift it onto the Unix day number first. See
						// CFG.INTVL_START_TIME_EPOCH_OFFSET_DAYS.
						let dayDate = null;
						if (typeof f.props.startTime === "number") {
							const unixDay = f.props.startTime +
								CFG.INTVL_START_TIME_EPOCH_OFFSET_DAYS;
							dayDate = new Date(unixDay * 86400 * 1000);
						}
						// Precise recorded time from the activityId cuid, when
						// decodable — recovers the time-of-day startTime lacks.
						const actDate = intvlActivityTime(f.props.activityId);
						const fmtDay = (d) => d.toLocaleDateString(undefined,
							{ day: "numeric", month: "short", year: "numeric" });
						const fmtDateTime = (d) => d.toLocaleString(undefined, {
							day: "numeric", month: "short", year: "numeric",
							hour: "numeric", minute: "2-digit",
						});

						let whenLine;
						if (actDate) {
							whenLine = `Recorded ${fmtDateTime(actDate)}` +
								` <span class="dw-cad-sub">(${intvlAgo(actDate)})</span>`;
						} else if (dayDate) {
							whenLine = `Captured ${fmtDay(dayDate)}` +
								` <span class="dw-cad-sub">(${intvlAgo(dayDate)})</span>`;
						} else {
							whenLine = "Capture date unknown";
						}

						const swatch =
							`<span style="display:inline-block;width:10px;` +
							`height:10px;background:${_safeColor(f.colour, "#3b82f6")};` +
							`border:1px solid #444;vertical-align:middle"></span>`;
						// The public tiles carry no username/userId and there's
						// no public way to resolve one (see intvlActivityTime
						// comment), so the runId/activityId are dead weight in a
						// hover — show only what's actually meaningful: the
						// territory's colour, area, and when it was claimed.
						const html =
							`<b>${swatch} ${area}</b> territory<br>` +
							`${whenLine}`;
						this._tooltip.setLatLng(latlng).setContent(html);
						if (!this._tooltip._map) this._tooltip.addTo(map);
						return;
					}
				}
				this._clearTooltip();
			},

			getAttribution() {
				return 'Global territories © <a href="https://www.intvl.com.au" target="_blank" rel="noreferrer">INTVL</a>';
			},
		});

		const layer = new IntvlGlobalGrid({
			tileSize: TILE_PX,
			minZoom: 4,
			maxNativeZoom: CFG.INTVL_TILES_MAX_NATIVE_Z,
			maxZoom: 25,
			opacity: 1,
			pane: "dwIntvlGlobalPane",
		});
		// 3D mirror: same PBF tileset, decoded natively by Mapbox.
		// Source-layer "territories" carries polygons with a
		// `colour` string property (no leading #). CloudFront
		// serves CORS-allowed PBFs, so Mapbox can fetch directly —
		// no addProtocol indirection needed (which is good because
		// some Mapbox builds dynamic.watch loads don't expose
		// addProtocol at all).
		layer._dwMb3DStyle = {
			sources: {
				src: {
					type: "vector",
					tiles: [`${CFG.INTVL_TILES_BASE}/{z}/{x}/{y}.pbf`],
					minzoom: 0,
					maxzoom: CFG.INTVL_TILES_MAX_NATIVE_Z,
				},
			},
			layers: [{
				id: "fill",
				type: "fill",
				source: "src",
				"source-layer": "territories",
				paint: {
					// INTVL features already store `#RRGGBB` (with the
					// leading hash). Mapbox's `to-color` reads that
					// directly; do NOT concat another `#` or every
					// feature comes back as `##RRGGBB` and the entire
					// expression throws "could not parse color".
					"fill-color": ["case",
						["has", "colour"], ["to-color", ["get", "colour"]],
						"#888",
					],
					"fill-opacity": 0.55,
					"fill-emissive-strength": 0.85,
				},
			}],
		};
		return layer;
	}
}
