import { CFG } from "../config.js";
import { LayerProvider } from "../layers/provider-factories.js";
import { gmCancel, gmGet, gmJsonGet } from "../utils/http.js";
import { _escHtml } from "../utils/html.js";
import { utfGridCellToLatLng } from "../utils/tile-geometry.js";

/* -- Geocaching.com (public tile API) -----------------------------------
 *
 * Renders caches from Groundspeak's PUBLIC tile-based map endpoints.
 * No login, no session cookie, no API key. Two endpoints in play:
 *
 *   1. `tiles{s}.geocaching.com/map.info?x&y&z` — UTFGrid (Mapbox
 *      spec): a 64x64 char grid + a keys[] + data{} where each
 *      non-empty cell encodes a single cache as `{i: GC<code>,
 *      n: <name>}`. The KEY STRING is itself the cell's grid
 *      coordinates as `(cx, cy)` — verified by reverse-decoding
 *      multiple tiles, holds 1966/1966 across the Brisbane z=12
 *      sample — so we extract position directly from the key
 *      without scanning the grid string.
 *
 *   2. `tiles01.geocaching.com/map.details?i=GC<code>` — per-cache
 *      detail JSON: difficulty, terrain, container, type id, owner,
 *      favourite points, archived/available flags. Fetched lazily
 *      on marker click (avoids one extra HTTP per visible cache on
 *      load).
 *
 * Lat/lng comes from `utfGridCellToLatLng(z, tx, ty, cx, cy)`. Cell
 * precision = tile/64: z=10 ~600 m, z=12 ~150 m, z=14 ~38 m, z=16
 * ~10 m. We gate the layer at minZoom=10 (12 visible tiles in a
 * desktop viewport, ~one round-trip per pan via subdomain rotation)
 * to keep the request cost predictable.
 *
 * Cross-tile deduplication: a cache that straddles two tiles will
 * appear in both UTFGrids; we key markers by GC code so the second
 * sighting is a no-op.
 */
export class GeocachingLayerProvider extends LayerProvider {
	create() {
		const MIN_ZOOM    = 10;
		// Groundspeak's UTFGrid is served at z=10..13 reliably. z=14
		// works only for the densest urban tiles; z=15+ returns 204
		// (the original client over-zoomed z=13 cells on the client
		// side). At zooms above FETCH_MAX_Z we drop to z=13 parent
		// tiles so markers keep rendering as the user zooms in.
		const FETCH_MAX_Z = 13;
		const DEBOUNCE_MS = 500;
		// Visible-tile count is ~viewport_px/256 REGARDLESS of zoom, so
		// a desktop viewport (1600x1000) needs up to ~40 tiles to cover
		// it and even a 1366x768 laptop needs ~28. The cap is purely a
		// runaway-guard for pathological cases (huge external monitor,
		// or fetch-zoom logic regressing); set well above any real
		// viewport. Per-tile UTFGrid cache + 4-way subdomain rotation
		// keep the per-pan request burst reasonable. (Was 16 — far too
		// low; silently rendered nothing at the layer's own MIN_ZOOM.)
		const MAX_TILES   = 64;

		// Type id → single-letter marker glyph + colour. The IDs are
		// Groundspeak's; the labels are picked to fit inside a 20px
		// divIcon. Default falls through to "G" / Traditional green.
		const TYPE_LABELS = {
			2:"T", 3:"M", 8:"?", 5:"L", 6:"E", 11:"C",
			137:"E", 1858:"W", 4:"V", 13:"C",
		};
		const TYPE_COLOR = {
			2:"#1f8e3e", 3:"#fcb900", 8:"#1e3fae",
			5:"#5b2a86", 6:"#d33a3a", 11:"#444",
			137:"#7d5a2a", 1858:"#2aa198",
			4:"#888",    13:"#d33a3a",
		};

		// Cached per-cache details (from map.details) so the second
		// marker click on a cache doesn't re-fetch. Persists across
		// pans because the cache GC codes don't change.
		const detailsCache = new Map();
		// Cached per-tile UTFGrid responses so pan-back doesn't re-
		// fetch. Keyed by "z/x/y" with a soft cap (LRU-ish: oldest
		// drops on overflow).
		const tileCache = new Map();
		const TILE_CACHE_MAX = 64;
		let subdomainIdx = 0;

		function nextSubdomain() {
			const list = CFG.GEOCACHING_TILE_SUBDOMAINS;
			const s = list[subdomainIdx % list.length];
			subdomainIdx++;
			return s;
		}

		function visibleTiles(map) {
			const z = Math.min(Math.floor(map.getZoom()), FETCH_MAX_Z);
			const b = map.getBounds();
			const n = Math.pow(2, z);
			const lngToTx = (lng) =>
				Math.floor(((lng + 180) / 360) * n);
			const latToTy = (lat) => {
				const r = (lat * Math.PI) / 180;
				return Math.floor(
					((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n,
				);
			};
			const yMin = Math.max(0, latToTy(b.getNorth()));
			const yMax = Math.min(n - 1, latToTy(b.getSouth()));
			// Longitude: a view crossing the antimeridian has west > east
			// (e.g. Fiji: west=178, east=-178), which with a single
			// clamped range produced xMin > xMax → an empty loop → zero
			// caches with no hint. Normalise into wrapped column indices
			// instead: iterate the x range modulo n.
			const xStart = lngToTx(b.getWest());
			let xCount = lngToTx(b.getEast()) - xStart + 1;
			if (xCount <= 0) xCount += n;       // crossed the antimeridian
			xCount = Math.min(xCount, n);
			const tiles = [];
			for (let i = 0; i < xCount; i++) {
				const x = ((xStart + i) % n + n) % n;
				for (let y = yMin; y <= yMax; y++) {
					tiles.push({ z, x, y });
				}
			}
			return tiles;
		}

		// ZOOM-STAGED VISUALS. Groundspeak's map.png raster (real
		// per-type icons) only exists natively to z=FETCH_MAX_Z; past
		// that, Leaflet CSS-stretches the bitmap and the icons inside
		// it blow up blurry. So:
		//   z10..13 — raster icons visible (native, crisp); the
		//             markers are TRANSPARENT hit-areas over them.
		//   z14+    — raster hidden (tile layer maxZoom); the markers
		//             become VISIBLE constant-size pins, coloured by
		//             cache type once details are known (eager-fetched
		//             under a budget — cache counts are small at these
		//             zooms — or on click).
		// Hit-area is 28px (40px on touch-primary, where a fat-finger
		// miss would land on the map and add a waypoint).
		// IS_TOUCH also gates the click behaviour: on touch there's no
		// hover to preview the cache stats, so a tap opens an info popup
		// (with a "View listing" button) instead of jumping straight to
		// geocaching.com. On desktop, hover shows the tooltip and a click
		// opens the listing as before.
		const IS_TOUCH = L.Browser.mobile ||
			(window.matchMedia &&
			 window.matchMedia("(hover: none)").matches);
		const HIT_PX = IS_TOUCH ? 40 : 28;
		function buildHitIcon() {
			return L.divIcon({
				className: "dw-geo-icon",
				html: `<div style="width:${HIT_PX}px;height:${HIT_PX}px;` +
					`background:transparent;cursor:pointer;"></div>`,
				iconSize:   [HIT_PX, HIT_PX],
				iconAnchor: [HIT_PX / 2, HIT_PX / 2],
			});
		}

		// Visible pin for z14+ — 20px circle, single-letter type
		// glyph, favourites badge. Generic green "G" until details
		// resolve the real type.
		function buildPinIcon(typeId, fill, opacity, favs) {
			const label = TYPE_LABELS[typeId] || "G";
			const favBadge = favs > 0
				? `<div style="position:absolute;top:-6px;right:-8px;` +
				  `background:#d33;color:#fff;font:bold 9px/1 sans-serif;` +
				  `padding:2px 4px;border-radius:8px;border:1px solid #fff;` +
				  `white-space:nowrap;box-shadow:0 0 2px rgba(0,0,0,.45);` +
				  `pointer-events:none;">♥${favs > 99 ? "99+" : favs}</div>`
				: "";
			const html =
				`<div style="position:relative;width:20px;height:20px;` +
				`overflow:visible;cursor:pointer;">` +
				`<div style="background:${fill};color:#fff;opacity:${opacity};` +
				`width:20px;height:20px;border-radius:50%;` +
				`display:flex;align-items:center;justify-content:center;` +
				`font:bold 11px/1 sans-serif;border:1px solid #222;` +
				`box-shadow:0 0 1px rgba(0,0,0,.6);">${label}</div>` +
				favBadge + `</div>`;
			return L.divIcon({
				className: "dw-geo-icon",
				html,
				iconSize:   [20, 20],
				iconAnchor: [10, 10],
			});
		}

		// Pin matching whatever details we already have for a cache.
		function pinForCode(code) {
			const row = detailsCache.get(code);
			if (!row) return buildPinIcon(2, TYPE_COLOR[2], 1, 0);
			const typeId = (row.type && row.type.value) || 2;
			const disabled = !row.available;
			return buildPinIcon(
				typeId,
				disabled ? "#888" : (TYPE_COLOR[typeId] || "#1f8e3e"),
				disabled ? 0.6 : 1,
				parseInt(row.fp, 10) || 0,
			);
		}

		const GeoLayer = L.Layer.extend({
			initialize() {
				this._group    = null;
				this._tiles    = null;
				this._debounce = null;
				this._gen      = 0;
				this._inflight = new Set();
				this._byCode   = new Map();
				// Incremental render bookkeeping: each visible tile keeps
				// its own sub-group + the codes it owns, so a pan only drops
				// tiles that left the viewport and renders tiles that newly
				// entered — markers already on screen stay put (no full
				// teardown/rebuild). _pinMode tracks the z<=13 hit-area vs
				// z14+ pin mode; when it flips every tile must rebuild
				// (icons change), so the cache is invalidated then only.
				this._tileGroups = new Map();
				this._pinMode    = null;
			},

			onAdd(map) {
				// Visual tiles sit just below the transparent hit-area
				// markers so a click lands on the marker, not the raster.
				if (!map.getPane("dwGeocachingTilePane")) {
					map.createPane("dwGeocachingTilePane");
					map.getPane("dwGeocachingTilePane").style.zIndex = "440";
				}
				if (!map.getPane("dwGeocachingPane")) {
					map.createPane("dwGeocachingPane");
					map.getPane("dwGeocachingPane").style.zIndex = "445";
				}
				// Groundspeak's rendered cache-icon raster. The <img>
				// requests ALSO warm the server-side tiles, which is what
				// makes the map.info UTFGrid (fetched below) return data.
				// map.png works with any Referer, so a plain L.tileLayer
				// is fine — and it auto-mirrors into 3D as a terrain
				// drape via _syncOverlays.
				this._tiles = L.tileLayer(CFG.GEOCACHING_PUBLIC_PNG, {
					pane:          "dwGeocachingTilePane",
					subdomains:    CFG.GEOCACHING_TILE_SUBDOMAINS,
					minZoom:       MIN_ZOOM,
					maxNativeZoom: FETCH_MAX_Z,
					// Hide the raster past its native zoom instead of
					// CSS-stretching it — overzoomed bitmap icons blow
					// up big and blurry. z14+ uses crisp DOM pins (see
					// the zoom-staged visuals note above).
					maxZoom:       FETCH_MAX_Z,
					tileSize:      256,
					// map.png sends NO Access-Control-Allow-Origin, so
					// a CORS-enabled <img> (crossOrigin:true) fails its
					// check in a real browser and renders NOTHING —
					// every other raster endpoint we use serves ACAO;
					// this one doesn't. We never read these pixels, so
					// a plain <img> is correct. (The e2e harness can't
					// catch this class of bug: it launches Chromium
					// with --disable-web-security, which masks CORS —
					// the same blind spot that hid the Strava
					// crossOrigin breakage.)
					crossOrigin:   false,
					attribution:   'Caches © <a href="https://www.geocaching.com" target="_blank" rel="noreferrer">Geocaching.com</a>',
				}).addTo(map);
				this._group = L.layerGroup().addTo(map);
				this._fetchSoon();
				map.on("moveend zoomend", this._onViewChange, this);
			},

			onRemove(map) {
				clearTimeout(this._debounce);
				this._debounce = null;
				map.off("moveend zoomend", this._onViewChange, this);
				for (const h of this._inflight) gmCancel(h);
				this._inflight.clear();
				if (this._tiles) {
					this._tiles.remove();
					this._tiles = null;
				}
				if (this._group) {
					this._group.remove();
					this._group = null;
				}
				this._tileGroups.clear();
				this._byCode.clear();
			},

			_onViewChange() { this._fetchSoon(); },

			_fetchSoon() {
				clearTimeout(this._debounce);
				this._debounce =
					setTimeout(() => this._fetch(), DEBOUNCE_MS);
			},

			_fetch() {
				const map = this._map;
				if (!map || !this._group) return;
				if (map.getZoom() < MIN_ZOOM) {
					this._group.clearLayers();
					this._tileGroups.clear();
					this._byCode.clear();
					return;
				}

				const myGen = ++this._gen;
				for (const h of this._inflight) gmCancel(h);
				this._inflight.clear();

				const tiles = visibleTiles(map);
				if (tiles.length > MAX_TILES) {
					// Zoomed-out edge case (shouldn't happen with
					// MIN_ZOOM=10 in normal viewports) — bail rather
					// than fan out an unreasonable number of requests.
					return;
				}

				// Pin mode (z14+) vs hit-area mode (z<=13) changes the icon
				// every marker uses. When it flips we can't reuse rendered
				// tiles — wipe and rebuild. Otherwise we keep them.
				const pinMode = map.getZoom() > FETCH_MAX_Z;
				if (this._pinMode !== pinMode) {
					this._group.clearLayers();
					this._tileGroups.clear();
					this._byCode.clear();
					this._pinMode = pinMode;
				}

				// Incremental diff: drop tiles that scrolled out of view,
				// keep the ones still visible, fetch/render only the new
				// ones. Each cache lives in exactly one UTFGrid tile (its
				// lat/lng maps to a single slippy cell at the fetch zoom),
				// so removing a tile cleanly removes only its own markers.
				const visKeys = new Set(
					tiles.map((t) => `${t.z}/${t.x}/${t.y}`));
				for (const [key, rec] of this._tileGroups) {
					if (visKeys.has(key)) continue;
					this._group.removeLayer(rec.group);
					for (const code of rec.codes) this._byCode.delete(code);
					this._tileGroups.delete(key);
				}

				for (const t of tiles) {
					const key = `${t.z}/${t.x}/${t.y}`;
					if (this._tileGroups.has(key)) continue; // already shown
					const cached = tileCache.get(key);
					if (cached) {
						this._renderTile(t, cached);
						continue;
					}
					this._fetchTile(t, myGen, key);
				}
			},

			_fetchTile(t, myGen, key) {
				// allowWarm=true on the first attempt: if the tile is
				// cold (HTTP 204), warm it via a map.png GET and retry
				// map.info ONCE. Warm tiles cost a single request.
				this._getInfo(t, myGen, key, true);
			},

			_tileUrl(template, t) {
				return template
					.replace("{s}", nextSubdomain())
					.replace("{x}", String(t.x))
					.replace("{y}", String(t.y))
					.replace("{z}", String(t.z));
			},

			_getInfo(t, myGen, key, allowWarm) {
				const url = this._tileUrl(CFG.GEOCACHING_PUBLIC_INFO, t);
				const handle = gmJsonGet(url, {
					headers: {
						"Accept":  "application/json",
						"Referer": "https://www.geocaching.com/play/map",
					},
					timeout: 15000,
				}, (err, data, raw) => {
					this._inflight.delete(handle);
					if (myGen !== this._gen || !this._group) return;

					if (!err && data) {
						tileCache.set(key, data);
						if (tileCache.size > TILE_CACHE_MAX) {
							const first = tileCache.keys().next().value;
							tileCache.delete(first);
						}
						this._renderTile(t, data);
						return;
					}
					// HTTP 204 (empty body, gmJsonGet surfaces it as an
					// "http 204" error) means the tile is cold. Warm it
					// once, then retry. Any other error: give up quietly.
					const status = raw && raw.status;
					if (status === 204 && allowWarm) {
						this._warmThenRetry(t, myGen, key);
					}
				});
				this._inflight.add(handle);
			},

			_warmThenRetry(t, myGen, key) {
				// A plain GET of the PNG triggers server-side tile
				// generation (HEAD does not). We discard the image —
				// only the side effect of warming the UTFGrid matters.
				const url = this._tileUrl(CFG.GEOCACHING_PUBLIC_PNG, t);
				const warm = gmGet(url, {
					headers: { "Referer": "https://www.geocaching.com/play/map" },
					timeout: 15000,
				}, () => {
					this._inflight.delete(warm);
					if (myGen !== this._gen || !this._group) return;
					// Retry info regardless of the PNG's HTTP result;
					// allowWarm=false so a still-cold tile doesn't loop.
					this._getInfo(t, myGen, key, false);
				});
				this._inflight.add(warm);
			},

			_renderTile(t, grid) {
				if (!this._group) return;
				if (!grid || !Array.isArray(grid.keys)) return;
				const tileKey = `${t.z}/${t.x}/${t.y}`;
				// Already on screen (e.g. a late fetch resolving for a tile
				// that's still visible) — don't double-render.
				if (this._tileGroups.has(tileKey)) return;
				// z14+: the raster is hidden (past native zoom), so
				// markers carry the visible pin. z<=13: transparent
				// hit-areas over the raster icons.
				const pinMode = !!this._map &&
					this._map.getZoom() > FETCH_MAX_Z;
				// Per-tile sub-group: removed wholesale when the tile
				// scrolls out of view (see _fetch's incremental diff).
				const tileGroup = L.layerGroup();
				const tileCodes = [];
				const newCodes = [];
				const data = grid.data || {};
				for (const k of grid.keys) {
					if (!k) continue;
					const m = /^\((\d+),\s*(\d+)\)$/.exec(k);
					if (!m) continue;
					const cx = +m[1], cy = +m[2];
					// data[k] is an ARRAY — Groundspeak stacks
					// multiple caches in the same grid cell. Iterate
					// every entry so multi-cache cells all render.
					// Accept the bare-object shape defensively in
					// case the schema flips back.
					const raw = data[k];
					const entries = Array.isArray(raw)
						? raw
						: raw && raw.i ? [raw] : [];
					for (const entry of entries) {
						if (!entry || !entry.i) continue;
						const code = entry.i;
						// Validate the GC code at the SOURCE — it's an
						// untrusted UTFGrid value that flows into URLs
						// (geocaching.com/geocache/${code}), tooltips,
						// and _dwData. A crafted/MITM'd tile could
						// otherwise smuggle a path/scheme/markup payload.
						// Real codes are GC + base31 (no 0/O/1/I/L/S/U).
						if (!/^GC[0-9A-Z]+$/.test(code)) continue;
						if (this._byCode.has(code)) continue;
						newCodes.push(code);

						const [lat, lon] =
							utfGridCellToLatLng(t.z, t.x, t.y, cx, cy);
						const name = entry.n || code;
						const marker = L.marker([lat, lon], {
							icon: pinMode ? pinForCode(code) : buildHitIcon(),
							pane:        "dwGeocachingPane",
							interactive: true,
						}).bindTooltip(
							`<b>${_escHtml(name)}</b>` +
							`<br><span class="dw-cad-sub">${_escHtml(code)}` +
							` · <i>click for details</i></span>`,
							{ className: "dw-flight-tip", sticky: true },
						);

						// 3D mirror metadata used by Mode3DController to
						// project a clickable dot over the terrain drape.
						// Type/colour fields populate on first details
						// fetch (UTFGrid only carries code + name).
						marker._dwData = {
							kind:  "geocache",
							code,
							name,
							color: TYPE_COLOR[2],
							url:   `https://www.geocaching.com/geocache/${code}`,
						};

						// Keep taps on the cache icon OURS — and handle the
						// click with a RAW listener on the icon itself.
						// Leaflet 1.x delivers marker clicks by
						// delegation from the map container, so the DOM
						// event must bubble all the way up before
						// `marker.on("click")` would fire — and at the
						// container, dynamic.watch's own listeners see
						// it too, which on mobile reads as "add a
						// waypoint here" (or, on long-press, opens the
						// add-point/GPS menu), making cache details
						// unreachable on touch. A raw icon-level
						// listener fires FIRST, stops the bubble dead,
						// and calls our handler directly; Leaflet's
						// delegated path simply never runs (no double
						// fire). disableClickPropagation kills the
						// pointerdown/touchstart family (site long-
						// press timer + drag-start); contextmenu stop
						// covers the synthesized long-press menu.
						marker.on("add", () => {
							const el = marker._icon;
							if (!el || el._dwStopWired) return;
							el._dwStopWired = true;
							L.DomEvent.disableClickPropagation(el);
							L.DomEvent.on(el, "click", (ev) => {
								L.DomEvent.stop(ev);
								this._onClick(marker, code);
							});
							L.DomEvent.on(el, "contextmenu touchend",
								L.DomEvent.stopPropagation);
						});
						marker.addTo(tileGroup);
						this._byCode.set(code, marker);
						tileCodes.push(code);
					}
				}

				tileGroup.addTo(this._group);
				this._tileGroups.set(tileKey, { group: tileGroup, codes: tileCodes });

				// Pin mode: colour the pins by real cache type without
				// waiting for a click. Budgeted — at z14+ a view holds
				// few caches, but a dense z13-parent tile can carry
				// hundreds; never fan out more than the budget per
				// render pass (the rest stay generic green until
				// clicked).
				if (pinMode) {
					let budget = 40;
					for (const code of newCodes) {
						if (detailsCache.has(code)) continue;
						if (budget-- <= 0) break;
						this._fetchDetails(code, (row) => {
							const mk = this._byCode.get(code);
							if (!row || !mk) return;
							this._applyDetails(mk, code, row, { open: false });
						});
					}
				}
			},

			// Fetch + cache map.details for one cache. cb(row|null) —
			// null means error or no data (caller decides fallback).
			_fetchDetails(code, cb) {
				const url = CFG.GEOCACHING_PUBLIC_DETAILS + code;
				gmJsonGet(url, {
					headers: {
						"Accept":  "application/json",
						"Referer": "https://www.geocaching.com/play/map",
					},
					timeout: 10000,
				}, (err, data) => {
					if (err || !data || data.status !== "success") {
						cb(null);
						return;
					}
					const row = (data.data && data.data[0]) || null;
					if (row) detailsCache.set(code, row);
					cb(row);
				});
			},

			_onClick(marker, code) {
				// Touch: show the stats popup (no hover to preview them);
				// the listing opens from a button inside it. Desktop: the
				// hover tooltip already previews stats, so a click goes
				// straight to the listing.
				const showOpts = IS_TOUCH
					? { open: false, popup: true }
					: { open: true };
				const cached = detailsCache.get(code);
				if (cached) {
					this._applyDetails(marker, code, cached, showOpts);
					return;
				}
				this._fetchDetails(code, (row) => {
					if (!row) {
						// Details unavailable (archived/private/error) —
						// open the cache page; Groundspeak has its own
						// UI for those states.
						window.open(
							`https://www.geocaching.com/geocache/${code}`,
							"_blank", "noopener,noreferrer");
						return;
					}
					this._applyDetails(marker, code, row, showOpts);
				});
			},

			// Pull the display fields out of a map.details row once, so the
			// tooltip and the touch popup format identically.
			_detailFields(row) {
				const typeId = (row.type && row.type.value) || 2;
				return {
					typeId,
					disabled: !row.available,
					favs: parseInt(row.fp, 10) || 0,
					premium: !!row.subrOnly,
					name: row.name || "",
					diff: (row.difficulty && row.difficulty.value)
						|| (row.difficulty && row.difficulty.text) || "?",
					terr: (row.terrain && row.terrain.value)
						|| (row.terrain && row.terrain.text) || "?",
					size: (row.container && row.container.text) || "",
					owner: (row.owner && row.owner.text) || "",
					typeText: (row.type && row.type.text) || "",
				};
			},

			// Touch-only: an anchored popup with the cache stats + a button
			// to open the full geocaching.com listing. Tapping the icon no
			// longer jumps straight to the (often paywalled) listing.
			_openDetailPopup(marker, code, row) {
				if (!this._map) return;
				const f = this._detailFields(row);
				const el = document.createElement("div");
				el.className = "dw-geo-pop";
				el.innerHTML =
					`<div class="dw-geo-pop-hd"><b>${_escHtml(f.name || code)}</b>` +
					(f.disabled ? ` <i>(disabled)</i>` : "") +
					(f.premium ? ` <span class="dw-geo-pmo">\u{1F512} Premium</span>` : "") +
					`</div>` +
					`<div class="dw-geo-pop-sub">${_escHtml(code)} · D ${_escHtml(String(f.diff))} / T ${_escHtml(String(f.terr))}` +
					(f.size ? " · " + _escHtml(String(f.size)) : "") +
					(f.favs ? ` · ♥ ${f.favs}` : "") +
					(f.typeText ? " · " + _escHtml(f.typeText) : "") +
					`</div>` +
					(f.owner ? `<div class="dw-geo-pop-owner">by ${_escHtml(f.owner)}</div>` : "") +
					(f.premium ? `<div class="dw-geo-pop-note">Full listing needs geocaching.com Premium</div>` : "") +
					`<button type="button" class="dw-geo-pop-open">View full listing ↗</button>`;
				// Keep clicks inside the popup OURS — otherwise the button
				// tap bubbles to the map container and the site reads it as
				// "add a waypoint here" (same hazard as the icon tap).
				L.DomEvent.disableClickPropagation(el);
				el.querySelector(".dw-geo-pop-open").addEventListener("click", (ev) => {
					L.DomEvent.stop(ev);
					window.open(`https://www.geocaching.com/geocache/${code}`,
						"_blank", "noopener,noreferrer");
				});
				marker.closeTooltip && marker.closeTooltip();
				L.popup({ className: "dw-geo-popup", offset: [0, -6], autoPan: true })
					.setLatLng(marker.getLatLng())
					.setContent(el)
					.openOn(this._map);
			},

			_applyDetails(marker, code, row, opts) {
				const typeId = (row.type && row.type.value) || 2;
				const color = TYPE_COLOR[typeId] || "#1f8e3e";
				const disabled = !row.available;
				const fill = disabled ? "#888" : color;
				const favs = parseInt(row.fp, 10) || 0;
				// Recolour the pin only when pins are the visible
				// symbol (z14+); below that the map.png raster is the
				// visual and the marker stays a transparent hit-area.
				if (this._map && this._map.getZoom() > FETCH_MAX_Z &&
					marker.setIcon) {
					marker.setIcon(pinForCode(code));
				}

				const name  = row.name || code;
				const diff  = (row.difficulty && row.difficulty.value)
					|| (row.difficulty && row.difficulty.text) || "?";
				const terr  = (row.terrain && row.terrain.value)
					|| (row.terrain && row.terrain.text) || "?";
				const size  = (row.container && row.container.text) || "";
				const owner = (row.owner && row.owner.text) || "";
				const typeText = (row.type && row.type.text) || "";
				// `subrOnly` = Premium-Member-Only. The public tile API
				// returns these caches' basic metadata anonymously (it's
				// shown below); only geocaching.com's listing PAGE
				// paywalls them. We surface the data in-app and flag it
				// so the marker isn't just a dead-end paywall link.
				const premium = !!row.subrOnly;

				marker._dwData = Object.assign(marker._dwData || {}, {
					color: fill, disabled, label: TYPE_LABELS[typeId] || "G",
					diff, terr, size, owner, favs,
					typeText, premium,
				});

				if (marker.setTooltipContent) {
					marker.setTooltipContent(
						`<b>${_escHtml(name)}</b>` +
						(disabled ? " <i>(disabled)</i>" : "") +
						(premium ? ` <span class="dw-geo-pmo" title="Premium Member Only on geocaching.com — basic info shown here">\u{1F512} Premium</span>` : "") +
						`<br><span class="dw-cad-sub">` +
						`${_escHtml(code)} · D ${diff} / T ${terr}` +
						(size ? " · " + _escHtml(String(size)) : "") +
						(favs ? ` · ♥ ${favs}` : "") +
						(typeText ? " · " + _escHtml(typeText) : "") +
						(owner ? "<br>by " + _escHtml(owner) : "") +
						(premium ? `<br><i>Full listing needs geocaching.com Premium</i>` : "") +
						`</span>`);
				}

				// Open the cache page only on an actual click — the
				// eager pin-colouring path enriches silently.
				if (opts && opts.open) {
					window.open(
						`https://www.geocaching.com/geocache/${code}`,
						"_blank", "noopener,noreferrer");
				}
				// Touch: surface the stats in an anchored popup instead.
				if (opts && opts.popup) {
					this._openDetailPopup(marker, code, row);
				}
			},

			getAttribution() {
				return 'Caches © <a href="https://www.geocaching.com" target="_blank" rel="noreferrer">Geocaching.com</a>';
			},
		});

		return new GeoLayer();
	}
}

