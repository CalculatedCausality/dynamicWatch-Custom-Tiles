import { CFG } from "../config.js";
import {
	DW_TILE_PREFIX,
	DW_TRANSPARENT_PNG,
	_dwMbLayers,
	_dwTileBlobs,
	_dwTileEvict,
	_dwTileFailed,
	_dwTileFailedRecently,
	_dwTileInflight,
	dwMbProtocolHandler,
	dwTileSentinel,
	hasDwMbProtocol,
	setDwMbHasProtocol,
} from "../bridge/mapbox-tile-bridge.js";
import { _escHtml, esc, _safeColor } from "../utils/html.js";
import { intvlActivityTime, intvlAgo, intvlArea } from "../utils/intvl.js";

const pageWin = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;

/* -- 3D Mode (Mapbox GL JS terrain overlay) ---------------------------
 *
 * Toggle that lazily loads mapbox-gl-js, mounts a Mapbox canvas inside
 * Leaflet's mapPane (above the now-hidden tile pane, below all the
 * overlay/marker panes so dynamic.watch's routes + waypoints continue
 * to render on top), enables `mapbox.terrain-rgb` as the DEM source,
 * and mirrors the currently-active Leaflet basemap as a Mapbox raster
 * layer draped over the terrain. Viewport syncs both directions so
 * pans inside Leaflet (e.g. dragging a waypoint) update the 3D view,
 * and pans inside the 3D view update Leaflet's logical state.
 *
 * Overlays that are Leaflet-rendered (vectors, GeoJSON, custom canvas
 * tiles like INTVL) still float in 2D pixel space — they don't track
 * the terrain. To make them follow the 3D surface they'd need to be
 * re-implemented as Mapbox sources; see the scope-2 path in the
 * README's roadmap for that.
 */

// dynamic.watch already ships its own Mapbox public token (for route
// thumbnails, 3D Preview, etc.); we scrape it instead of embedding
// one. Order: react-prop blob → any string in the page HTML → an
// inert placeholder (Mapbox GL JS requires *some* non-empty token at
// init even when no Mapbox-hosted tiles are requested).
function pickMapboxToken() {
	if (pageWin.mapboxgl?.accessToken && /^pk\./.test(pageWin.mapboxgl.accessToken)) {
		return pageWin.mapboxgl.accessToken;
	}
	try {
		const html = document.documentElement.outerHTML;
		const m = html.match(/pk\.eyJ[A-Za-z0-9._-]{30,}/);
		if (m) return m[0];
	} catch (_) {}
	return "pk.no-mapbox-tiles-needed";
}

function ensureMapboxLoaded() {
	const win = pageWin;
	if (win.mapboxgl) return Promise.resolve(win.mapboxgl);
	if (!ensureMapboxLoaded._p) {
		ensureMapboxLoaded._p = new Promise((resolve, reject) => {
			// CSS first so the canvas sizing rules are in place before
			// the script fires its DOM construction.
			if (!document.getElementById("dw-mb-css")) {
				const link = document.createElement("link");
				link.id = "dw-mb-css";
				link.rel = "stylesheet";
				link.href = `https://api.mapbox.com/mapbox-gl-js/v${CFG.MAPBOX_GL_VERSION}/mapbox-gl.css`;
				document.head.appendChild(link);
			}
			const script = document.createElement("script");
			script.src = `https://api.mapbox.com/mapbox-gl-js/v${CFG.MAPBOX_GL_VERSION}/mapbox-gl.js`;
			script.onload = () => {
				if (win.mapboxgl) {
					// Silence telemetry. The borrowed token is URL-restricted
					// to dynamic.watch, so events.mapbox.com rejects every
					// beacon with a CORS error — harmless but spammy. Nulling
					// EVENTS_URL stops the library from firing them at all.
					try {
						if (win.mapboxgl.config) win.mapboxgl.config.EVENTS_URL = null;
						if (typeof win.mapboxgl.setTelemetryEnabled === "function") win.mapboxgl.setTelemetryEnabled(false);
					} catch (e) { /* best-effort */ }
					// Register `dw://` so raster sources backed by our
					// custom Leaflet fetchers (Stamen, ArcGIS Exports,
					// QLD Roads/Historical, INTVL) can flow through Mapbox.
					// Firefox's userscript sandbox wraps closures into
					// XPCNativeWrappers that the page-context Mapbox
					// can't call — so we use `exportFunction` (when
					// available) to expose a page-callable shim that
					// bounces back into our sandbox handler. On Chrome /
					// Tampermonkey's "main world" mode this is a no-op
					// and the raw function works directly.
					try {
						if (typeof win.mapboxgl.addProtocol === "function") {
							const handler = typeof exportFunction === "function"
								? exportFunction(dwMbProtocolHandler, win, { allowCrossOriginArguments: true })
								: dwMbProtocolHandler;
							win.mapboxgl.addProtocol("dw", handler);
							setDwMbHasProtocol(true);
						} else {
							console.info(
								"[CustomTiles] mapboxgl.addProtocol unavailable in this build " +
								"(v" + (win.mapboxgl.version || "?") + " — Mapbox v3 dropped it); " +
								"Stamen / QLD Historical / Garmin Heatmap render in 3D via the " +
								"transformRequest blob bridge instead.");
						}
					} catch (e) {
						console.warn("[CustomTiles] addProtocol failed:", e.message);
					}
					resolve(win.mapboxgl);
				}
				else reject(new Error("mapboxgl global missing after load"));
			};
			script.onerror = () => reject(new Error("script tag load failed"));
			document.head.appendChild(script);
		});
	}
	return ensureMapboxLoaded._p;
}

export class Mode3DController {
	constructor(app) {
		this._app = app;
		this._active = false;
		this._loading = false;
		this._mbMap = null;
		this._mbContainer = null;
		this._handler3DMove = null;
		this._baseTracker = null;
	}

	isActive() { return this._active || this._loading; }

	enable(map) {
		if (this._active || this._loading) return;
		// Defensive cleanup of any leftover state from a prior
		// session that didn't fully tear down (fast-toggle race).
		const stale = document.getElementById("dw-mb-container");
		if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
		this._loading = true;
		// Generation counter — every enable starts a new "session"
		// and every disable bumps the gen so any in-flight async
		// path (e.g. mapbox-gl.js still loading from a previous
		// enable, layer fetches, deferred mounts) checks `myGen
		// !== this._gen` and bails. This is what makes rapid
		// stress-toggling stable: superseded enables/disables
		// silently no-op rather than racing each other to mount
		// or tear down DOM the other side is already touching.
		this._gen = (this._gen || 0) + 1;
		const myGen = this._gen;
		ensureMapboxLoaded().then((mapboxgl) => {
			if (myGen !== this._gen) return;  // superseded
			this._loading = false;
			this._mount(map);
			this._initMbMap(map, mapboxgl);
			this._wireMarkerCache(map);
			this._wireSync(map);
			this._wireBasemapTracker(map);
			this._active = true;
			console.info("[CustomTiles] 3D Mode enabled");
		}).catch((e) => {
			if (myGen !== this._gen) return;
			this._loading = false;
			console.error(
				"[CustomTiles] 3D Mode: failed to load mapbox-gl-js:",
				e.message);
		});
	}

	disable(map) {
		if (this._loading) {
			// Bump gen so the in-flight enable's `.then` bails,
			// reset _loading so the NEXT click on the toggle can
			// proceed (without this, the controller stays stuck
			// in "loading" forever and isActive() keeps returning
			// true — exactly the rapid-toggle stuck state the
			// stress test was hitting).
			this._gen = (this._gen || 0) + 1;
			this._loading = false;
			const stale = document.getElementById("dw-mb-container");
			if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
			return;
		}
		if (!this._active) return;
		clearTimeout(this._dwReloadTimer);
		this._unwireBasemapTracker(map);
		this._unwireSync(map);
		this._unwireMarkerObserver();
		this._unwireMarkerCache(map);
		this._unpatchLeafletProjection();
		if (this._mbMap) {
			try { this._mbMap.remove(); } catch (_) {}
			this._mbMap = null;
		}
		// `_popup` + `_hoverBound` reference the destroyed mbMap;
		// drop them so the next enable() creates fresh ones.
		this._popup = null;
		this._hoverBound = null;
		// Cancel any pending getter-retry timer that was scheduled
		// while 3D was active (would otherwise fire after we've
		// already torn the controller down and call into a null
		// `_mbMap`).
		if (this._pendingRetry) {
			clearTimeout(this._pendingRetry);
			this._pendingRetry = null;
		}
		this._pendingRetryCount = 0;
		this._unmount(map);
		this._active = false;
		console.info("[CustomTiles] 3D Mode disabled");
	}

	_mount(map) {
		this._hiddenPanes = [];
		this._hideHiddenable(map);
		// Mount the Mapbox container ONCE per enable. Previously
		// this happened inside `_hideHiddenable` which is also
		// called from `_baseTracker` and `_syncOverlaysImpl` on
		// every layer event — so a second/third dw-mb-container
		// could end up in DOM with the same id while
		// `this._mbContainer` only tracked the most recent one.
		// On disable, `_unmount` removed the tracked div but the
		// older one (still parenting the live Mapbox canvas)
		// leaked. On re-enable, a fresh container went IN FRONT
		// of the leaked one — and the leaked Leaflet panes /
		// list items on top of it intercepted pointer events,
		// which is what made the camera "unable to be moved".
		// Cleanup is now strictly enable→mount, disable→unmount.
		if (!document.getElementById("dw-mb-container")) {
			const root = map.getContainer();
			const div = document.createElement("div");
			div.id = "dw-mb-container";
			div.style.cssText =
				"position:absolute;top:0;left:0;width:100%;height:100%;" +
				// `z-index: 200` lifts us above Leaflet's tilePane
				// (z-index 200 too — equal beats nothing) and below
				// the marker / popup panes (600+) so user-clickable
				// UI still works.
				"z-index:200;pointer-events:auto;";
			if (root.firstChild) root.insertBefore(div, root.firstChild);
			else root.appendChild(div);
			this._mbContainer = div;
		} else {
			this._mbContainer = document.getElementById("dw-mb-container");
		}
	}

	// Walk all panes and hide the ones we shouldn't render in 3D.
	// Idempotent — call from `_mount` AND from every resync so
	// panes created AFTER 3D was enabled (user toggles INTVL or
	// flips a custom-canvas layer mid-session) get hidden too.
	_hideHiddenable(map) {
		// Inject a global CSS rule with `!important` so even if
		// Leaflet (or dynamic.watch) resets pane.style.opacity
		// inline during a setView / animation, the hidden panes
		// stay invisible. Without `!important`, the route SVG in
		// overlayPane and the basemap tiles in tilePane briefly
		// flash through the Mapbox canvas mid-motion — that's the
		// "route shows as 2D while in motion before snapping" bug.
		// The class `dw-3d-active` is added to the leaflet root in
		// the mount block below; removed on `disable`.
		if (!document.getElementById("dw-3d-hide-styles")) {
			const css = document.createElement("style");
			css.id = "dw-3d-hide-styles";
			css.textContent = `
				.dw-3d-active .leaflet-tile-pane,
				.dw-3d-active .leaflet-overlay-pane,
				.dw-3d-active .leaflet-shadow-pane,
				.dw-3d-active .leaflet-tooltip-pane,
				.dw-3d-active [class*="leaflet-pane"][class*="dw"] {
					opacity: 0 !important;
				}
			`;
			document.head.appendChild(css);
		}
		map.getContainer().classList.add("dw-3d-active");
		this._hiddenPanes ??= [];
		const tracked = new Set(this._hiddenPanes.map(p => p.name));
		const hide = (name) => {
			if (tracked.has(name)) return;
			const pane = map.getPane(name);
			if (!pane) return;
			this._hiddenPanes.push({ name, prev: pane.style.opacity });
			pane.style.opacity = "0";
			tracked.add(name);
		};
		hide("tilePane");
		hide("overlayPane");
		hide("shadowPane");
		// Hide tooltipPane — every layer with hover-identify
		// (Cadastre, QPWS, INTVL) drops its tooltip here, and in
		// 3D they all fire on every mousemove regardless of which
		// hidden pane the tile data lives in, so the user ends up
		// seeing multiple stacked popovers for the same hover. The
		// Mapbox-side popups for ported layers (INTVL, geocaches,
		// flights, vessels) render through the Mapbox canvas, not
		// tooltipPane, so they still show. `popupPane` stays
		// visible so click-driven popups (Cadastre Sales link,
		// Street View, etc.) keep working.
		hide("tooltipPane");
		for (const key of Object.keys(map._panes || {})) {
			if (key.startsWith("dw")) hide(key);
		}
	}

	_unmount(map) {
		// Belt + braces: remove every dw-mb-container in the DOM,
		// not just the one we tracked. If anything (a stale enable
		// from a prior session, an external script, etc.) left a
		// stray container behind, we don't want it leaking past
		// disable and intercepting pointer events on the next
		// enable.
		for (const el of document.querySelectorAll("#dw-mb-container")) {
			el.parentNode?.removeChild(el);
		}
		this._mbContainer = null;
		map.getContainer().classList.remove("dw-3d-active");
		for (const entry of (this._hiddenPanes || [])) {
			const pane = map.getPane(entry.name);
			if (pane) pane.style.opacity = entry.prev || "";
		}
		this._hiddenPanes = null;
		// Clear our `!important` transform overrides so Leaflet's
		// normal repositioning takes effect again. Without this,
		// the markers would stay frozen at their last 3D position
		// even after the user toggles 3D off.
		map.eachLayer((lyr) => {
			if (!(lyr instanceof L.Marker)) return;
			const el = lyr._icon || lyr.getElement?.();
			if (el) el.style.removeProperty("transform");
		});
		// Force Leaflet to re-emit positions so the cleared
		// transforms get repopulated by Leaflet's flat projection.
		try { map.fire("viewreset"); } catch (_) {}
	}

	_initMbMap(map, mapboxgl) {
		// Mapbox Terrain-DEM v1 — Mapbox's current global DEM
		// (replaces the legacy `mapbox.terrain-rgb`). Higher
		// effective resolution than AWS Terrarium, especially in
		// blended/lidar regions, and tiles serve as 512px WebP so
		// fewer requests per visible area. Using the `mapbox://`
		// URL form lets Mapbox GL JS fetch the TileJSON and
		// inject the access_token automatically — no addProtocol
		// needed, which is critical for the build dynamic.watch
		// ships (no addProtocol export). If the borrowed page
		// token doesn't have terrain-dem-v1 scope, fall back via
		// the `error` listener wired below.
		const sources = {
			"mapbox-dem": {
				type: "raster-dem",
				url: "mapbox://mapbox.mapbox-terrain-dem-v1",
				tileSize: 512,
				maxzoom: 14,
			},
		};
		// Solid background layer FIRST so the canvas always has a
		// non-transparent fill. Without this, when no basemap is
		// detected (custom-createTile layers, or before the raster
		// loads) the canvas stays transparent and Leaflet's default
		// `#ddd` container background bleeds through — grey screen.
		const layers = [
			{ id: "bg", type: "background", paint: { "background-color": "#c8c4b8" } },
		];
		const base = this._activeBaseTiles(map);
		if (base) {
			sources["active-base"] = {
				type: "raster",
				tiles: base.tiles,
				tileSize: 256,
				maxzoom: base.maxzoom,
			};
			layers.push({
				id: "active-base",
				type: "raster",
				source: "active-base",
				paint: { "raster-fade-duration": 0 },
			});
		} else {
			console.info(
				"[CustomTiles] 3D Mode: no URL-template basemap on map; " +
				"showing bare terrain. Switch to Google Hybrid / QLD Globe " +
				"/ MapTiler for draped imagery.");
		}
		layers.push({
			id: "sky",
			type: "sky",
			paint: { "sky-type": "atmosphere" },
		});

		const c = map.getCenter();
		const z = map.getZoom();
		const mbMap = new mapboxgl.Map({
			container: this._mbContainer,
			accessToken: pickMapboxToken(),
			style: {
				version: 8,
				sources,
				layers,
				// Mapbox's default font CDN — required so any symbol
				// layer we later add (distance labels, geocache code
				// pins, plane callsigns) can render text. The borrowed
				// token has access; if it ever rotates to a fonts-
				// restricted scope, the text layers silently 404 and
				// glyphs stay empty, but other layers still render.
				glyphs: "mapbox://fonts/mapbox/{fontstack}/{range}.pbf",
			},
			center: [c.lng, c.lat],
			zoom: Math.max(0, z - 1),  // Mapbox zoom is offset 1 below Leaflet
			pitch: 60,                  // Tilt for the actual 3D effect
			bearing: 0,
			antialias: true,
			attributionControl: false,
			// Mapbox owns gestures while 3D is on: drag pans, scroll
			// zooms, right-drag (or ctrl+drag) rotates/pitches.
			// Leaflet's edit controls are hidden anyway (overlay +
			// marker panes opacity 0), so there's no conflict.
			interactive: true,
			dragRotate: true,
			touchPitch: true,
			// Bridge for GM-fetcher-backed raster sources (Stamen,
			// QLD Historical, Garmin) — intercepts our sentinel tile
			// URLs and serves blobs fetched via GM_xmlhttpRequest.
			// Replaces the dead dw:// addProtocol path on Mapbox v3.
			transformRequest: (url, resourceType) =>
				this._dwTransformRequest(url, resourceType),
		});
		mbMap.on("style.load", () => {
			mbMap.setTerrain({ source: "mapbox-dem", exaggeration: 1.5 });
			// Belt-and-braces resize: even with the right parent,
			// Mapbox's first layout pass occasionally beats CSS
			// settling on slower runs. Force a recomputation.
			try { mbMap.resize(); } catch (_) {}
			// Mirror every active Leaflet overlay tile-layer as a
			// Mapbox raster source so toggling layers in 2D shows
			// up draped on the 3D terrain. Then render every
			// Leaflet vector / marker shape (National Parks,
			// Geocaches, Flights, Vessels, OIM Power / Telecoms /
			// Water) as Mapbox GeoJSON layers. Route + waypoints
			// go on top last, then wire hover-popups for the
			// feature layers (INTVL, geocaches, flights, vessels).
			this._syncOverlays(map, mbMap);
			this._renderLeafletShapes(map, mbMap);
			this._renderRoute(map, mbMap);
			this._wireHoverPopups(mapboxgl, mbMap);
			// Initial marker sync — overrides Leaflet's flat-
			// projection positioning with Mapbox's tilted one so
			// the waypoint dots land on the correct terrain pixel
			// from the first frame, not after the user starts panning.
			this._syncMarkersToMapbox(map, mbMap);
			// Watch markerPane for any subsequent style mutations
			// (drag, zoom, programmatic setLatLng) so we re-sync
			// without depending on a Mapbox `move` event to fire.
			this._wireMarkerObserver(map, mbMap);
			// Watch the route's SVG path for in-place `setLatLngs`
			// updates (waypoint added / removed / re-routed) so the
			// 3D-rendered line stays in lock-step.
			this._wireRoutePathObserver(map, mbMap);
		});
		this._mbMap = mbMap;
		// Reset per-session caches: a fresh Mapbox instance has
		// no layers yet, so any "skip if signature matches" path
		// MUST run on its first call.
		this._wiredClick   = new Set();
		this._lastRouteSig = null;
		// Reset move-state flags so a previous session that
		// disabled mid-move can't leave the new session thinking
		// it's already moving (which would suppress marker sync
		// and keep markerPane hidden).
		this._isMoving = false;
		this._markerPanePrevVis = null;
		this._syncRequested = false;
		// Patch Leaflet's flat (Point → LatLng) methods to route
		// through Mapbox's terrain-aware unproject — fixes clicks
		// landing at the wrong terrain spot AND keeps dragged
		// marker latLngs honest.
		this._patchLeafletProjection(map);
		// Debug hooks: every reference console snippets need to
		// introspect the 3D state without re-deriving anything.
		//   _dwMb        — the Mapbox GL Map instance
		//   _dwMbBase    — the basemap spec mirrored from Leaflet
		//   _dwMap       — the Leaflet map (not exposed by dw)
		//   _dw3D        — this controller (so we can call methods)
		//   _dwRegistry  — the dw:// fetcher registry
		try {
			pageWin._dwMb        = mbMap;
			pageWin._dwMbBase    = base;
			pageWin._dwMap       = map;
			pageWin._dw3D        = this;
			pageWin._dwRegistry  = _dwMbLayers;
		} catch (_) {}
	}

	// Extract dynamic.watch's route polyline(s) + waypoint markers
	// from Leaflet, return as GeoJSON. Walks every layer on the map
	// — picks up the SVG path Leaflet uses for the route line plus
	// every L.Marker (start/end/insert points + distance labels) by
	// reading their `_latlngs` / `getLatLng()` directly. Marker
	// colour is sniffed from the icon's CSS class (`circle red` →
	// red, `circle lightgreen` → start, `dist-marker` → numbered).
	_extractRouteGeojson(map) {
		const lineFeatures = [];
		const pointFeatures = [];
		map.eachLayer((lyr) => {
			if (lyr instanceof L.Polyline && !(lyr instanceof L.Polygon)) {
				const latlngs = lyr.getLatLngs?.();
				if (!latlngs) return;
				const flat = (Array.isArray(latlngs[0]) ? latlngs.flat(Infinity) : latlngs)
					.filter(p => p && typeof p.lat === "number");
				if (flat.length < 2) return;
				lineFeatures.push({
					type: "Feature",
					geometry: { type: "LineString", coordinates: flat.map(p => [p.lng, p.lat]) },
					properties: {
						color: lyr.options?.color || "#9400D3",
						weight: Math.min(lyr.options?.weight || 5, 8),
					},
				});
			} else if (lyr instanceof L.Marker) {
				const p = lyr.getLatLng?.();
				if (!p) return;
				const el = lyr.getElement?.() || lyr._icon;
				const cls = el?.className || "";
				let color = null, radius = 9, label = "";
				if (cls.includes("dist-marker")) {
					color = "#9400D3"; radius = 7;
					label = (el.textContent || el.title || "").trim();
				} else if (cls.includes("lightgreen")) color = "#7fd14b";
				else if (cls.includes(" red"))        color = "#ff3030";
				else if (cls.includes(" blue"))       color = "#3b82f6";
				else if (cls.includes(" white"))      color = "#ffffff";
				else if (cls.includes("transparent")) return;
				else return;  // Skip non-route markers (Flights, Marine, Geocaches, etc.)
				pointFeatures.push({
					type: "Feature",
					geometry: { type: "Point", coordinates: [p.lng, p.lat] },
					properties: { color, radius, label },
				});
			}
		});
		return {
			line:   { type: "FeatureCollection", features: lineFeatures },
			points: { type: "FeatureCollection", features: pointFeatures },
		};
	}

	// Run `fn` as soon as the Mapbox style is ready, guarded so a
	// callback scheduled while 3D was active never fires after
	// disable(). Mapbox flips `isStyleLoaded()` to false transiently
	// whenever a source/layer is added (base swap, overlay mirror),
	// and several of our sync entry points run right after such a
	// mutation. The OLD code guarded those entry points with an
	// early `return` on `!isStyleLoaded` — which silently DROPPED the
	// work with no retry. That was the root cause of both:
	//   • shape overlays enabled before 3D never mirroring, and
	//   • base-layer switches not updating the 3D imagery when made
	//     before the previous layer finished rendering.
	// Deferring to the next `idle` (with a timeout fallback in case
	// idle never fires) makes the work happen instead of vanish.
	_runWhenStyleReady(mb, fn) {
		const go = () => {
			if (this._active && this._mbMap === mb && mb.getStyle?.()) fn();
		};
		if (mb.isStyleLoaded && mb.isStyleLoaded()) { go(); return; }
		let fired = false;
		const once = () => { if (fired) return; fired = true; go(); };
		try { mb.once("idle", once); } catch (_) {}
		setTimeout(once, 1200);
	}

	// Walk every L.Path / L.Marker on the map, group by pane, and
	// render each group as one or more Mapbox GeoJSON layers. This
	// is how Geocaches, Live Flights, Marine Vessels, National
	// Parks, OIM Power / Telecoms / Water all get into 3D —
	// they're all Leaflet shapes underneath. Live-data panes
	// (Flights/Vessels) refresh by replacing their child layers,
	// which fires layeradd/layerremove → our debounced _fullResync
	// picks it up within 40 ms.
	_renderLeafletShapes(map, mbMap) {
		if (!mbMap.isStyleLoaded || !mbMap.isStyleLoaded()) {
			// Style isn't ready (e.g. _syncOverlays just added raster
			// sources at 3D init). Defer instead of dropping, so
			// overlays already active when 3D toggled on still mirror.
			// Dedup so rapid re-entry registers only one deferral.
			if (!this._shapesRetryPending) {
				this._shapesRetryPending = true;
				this._runWhenStyleReady(mbMap, () => {
					this._shapesRetryPending = false;
					this._renderLeafletShapes(map, mbMap);
				});
			}
			return;
		}
		const byPane = new Map();
		const bucket = (pane) => {
			let b = byPane.get(pane);
			if (!b) { b = { lines: [], polygons: [], points: [] }; byPane.set(pane, b); }
			return b;
		};
		// Recursive walker — `map.eachLayer` only iterates direct
		// children of the map, NOT the contents of L.LayerGroup /
		// L.FeatureGroup containers. Power / Telecoms / Water all
		// wrap their per-feature L.Polyline/Polygon/Marker
		// instances inside a feature group, so without the
		// recursion we'd see only the (empty-shaped) wrapper and
		// miss every actual feature.
		const visit = (lyr) => {
			if (lyr instanceof L.LayerGroup) {
				lyr.eachLayer(visit);
				return;
			}
			handle(lyr);
		};
		const handle = (lyr) => {
			const opts = lyr.options || {};
			const pane = opts.pane;
			if (!pane) return;
			// Skip the default panes — those are handled elsewhere
			// (tile pane = base imagery, overlay pane = route SVG,
			// marker pane = waypoints, mapPane = container only).
			if (pane === "tilePane" || pane === "overlayPane" ||
				pane === "markerPane" || pane === "mapPane" ||
				pane === "tooltipPane" || pane === "popupPane" ||
				pane === "shadowPane") return;

			if (lyr instanceof L.Polygon) {
				const ll = lyr.getLatLngs();
				if (!ll || !ll.length) return;
				// L.Polygon nesting:
				//   [LatLng,…]                — simple polygon, one ring
				//   [[LatLng,…],[LatLng,…]]    — polygon with holes
				//   [[[LatLng,…],…],…]         — multipolygon
				const isLatLng = (x) => x && typeof x.lat === "number";
				let coordinates, type;
				if (isLatLng(ll[0])) {
					coordinates = [ll.map(p => [p.lng, p.lat])];
					coordinates[0].push(coordinates[0][0]);
					type = "Polygon";
				} else if (isLatLng(ll[0]?.[0])) {
					coordinates = ll.map(ring => {
						const c = ring.map(p => [p.lng, p.lat]);
						c.push(c[0]);
						return c;
					});
					type = "Polygon";
				} else {
					coordinates = ll.map(poly => poly.map(ring => {
						const c = ring.map(p => [p.lng, p.lat]);
						c.push(c[0]);
						return c;
					}));
					type = "MultiPolygon";
				}
				bucket(pane).polygons.push({
					type: "Feature",
					geometry: { type, coordinates },
					properties: {
						color:       opts.color       || "#888",
						fillColor:   opts.fillColor   || opts.color || "#888",
						fillOpacity: opts.fillOpacity != null ? opts.fillOpacity : 0.25,
						opacity:     opts.opacity     != null ? opts.opacity : 0.9,
						weight:      opts.weight      || 1,
					},
				});
			} else if (lyr instanceof L.Polyline) {
				const ll = lyr.getLatLngs();
				if (!ll || !ll.length) return;
				const flat = (Array.isArray(ll[0]) ? ll.flat(Infinity) : ll)
					.filter(p => p && typeof p.lat === "number");
				if (flat.length < 2) return;
				bucket(pane).lines.push({
					type: "Feature",
					geometry: { type: "LineString", coordinates: flat.map(p => [p.lng, p.lat]) },
					properties: {
						color:   opts.color   || "#888",
						opacity: opts.opacity != null ? opts.opacity : 1,
						weight:  opts.weight  || 2,
					},
				});
			} else if (lyr instanceof L.CircleMarker || lyr instanceof L.Circle) {
				const p = lyr.getLatLng?.();
				if (!p) return;
				bucket(pane).points.push({
					type: "Feature",
					geometry: { type: "Point", coordinates: [p.lng, p.lat] },
					properties: {
						color:  opts.fillColor || opts.color || "#888",
						radius: opts.radius     || 5,
					},
				});
			} else if (lyr instanceof L.Marker) {
				const p = lyr.getLatLng?.();
				if (!p) return;
				const el  = lyr.getElement?.() || lyr._icon;
				const cls = el?.className || "";
				// `_dwData` is the per-layer hook (geocaches +
				// future planes/vessels). When present it overrides
				// the per-pane defaults so 3D dots match the 2D
				// colour-coding (e.g. found-cache grey vs available
				// type colour) and carry whatever url/code the
				// click handler needs to open the right page.
				const dwData = lyr._dwData || null;
				const paneColor = {
					dwGeocachingPane: "#2da44e",
					dwFlightsPane:    "#0066ff",
					dwMarinePane:     "#00a3c9",
					dwWazePane:       "#33ccff",
					dwInfraPane:      "#F0A500",
					dwTelecomPane:    "#7C3AED",
					dwWaterPane:      "#0EA5E9",
				}[pane] || "#888";
				bucket(pane).points.push({
					type: "Feature",
					geometry: { type: "Point", coordinates: [p.lng, p.lat] },
					properties: {
						color:  dwData?.color || paneColor,
						radius: dwData?.radius || 5,
						label:  dwData?.label || "",
						url:    dwData?.url   || "",
						kind:   dwData?.kind  || "",
						// Full data for hover popups. Mapbox JSON-
						// serialises feature properties, so primitives
						// only — booleans + strings + numbers.
						name:    dwData?.name  || "",
						code:    dwData?.code  || "",
						diff:    dwData?.diff,
						terr:    dwData?.terr,
						favs:    dwData?.favs,
						size:    dwData?.size  || "",
						owner:   dwData?.owner || "",
						found:   !!dwData?.found,
						dnf:     !!dwData?.dnf,
						className: cls,
					},
				});
			}
		};
		map.eachLayer(visit);

		// Two-pass drop. Several shape sources have multiple
		// dependent layers (point + label, polygon fill + outline),
		// and Mapbox throws if you try to drop a source while a
		// layer still uses it.
		const oldIds = this._shapeIds || [];
		for (const id of oldIds) {
			try { if (mbMap.getLayer(id)) mbMap.removeLayer(id); } catch (_) {}
		}
		for (const id of oldIds) {
			try { if (mbMap.getSource(id)) mbMap.removeSource(id); } catch (_) {}
		}
		this._shapeIds = [];

		const beforeId = mbMap.getLayer("dw-route-line") ? "dw-route-line" :
			(mbMap.getLayer("sky") ? "sky" : undefined);

		for (const [pane, b] of byPane) {
			if (b.polygons.length) {
				const id = `dw-shapes-poly-${pane}`;
				mbMap.addSource(id, {
					type: "geojson",
					data: { type: "FeatureCollection", features: b.polygons },
				});
				mbMap.addLayer({
					id, type: "fill", source: id,
					paint: {
						"fill-color":   ["coalesce", ["get", "fillColor"], "#888"],
						"fill-opacity": ["coalesce", ["get", "fillOpacity"], 0.25],
					},
				}, beforeId);
				this._shapeIds.push(id);
				const outlineId = id + "-outline";
				mbMap.addLayer({
					id: outlineId, type: "line", source: id,
					paint: {
						"line-color":   ["coalesce", ["get", "color"], "#888"],
						"line-width":   ["coalesce", ["get", "weight"], 1],
						"line-opacity": ["coalesce", ["get", "opacity"], 0.9],
						"line-emissive-strength": 1,
					},
				}, beforeId);
				this._shapeIds.push(outlineId);
			}
			if (b.lines.length) {
				const id = `dw-shapes-line-${pane}`;
				mbMap.addSource(id, {
					type: "geojson",
					data: { type: "FeatureCollection", features: b.lines },
				});
				mbMap.addLayer({
					id, type: "line", source: id,
					layout: { "line-cap": "round", "line-join": "round" },
					paint: {
						"line-color":   ["coalesce", ["get", "color"], "#888"],
						"line-width":   ["coalesce", ["get", "weight"], 2],
						"line-opacity": ["coalesce", ["get", "opacity"], 1],
						"line-emissive-strength": 1,
					},
				}, beforeId);
				this._shapeIds.push(id);
			}
			if (b.points.length) {
				const id = `dw-shapes-point-${pane}`;
				mbMap.addSource(id, {
					type: "geojson",
					data: { type: "FeatureCollection", features: b.points },
				});
				mbMap.addLayer({
					id, type: "circle", source: id,
					paint: {
						"circle-radius":       ["coalesce", ["get", "radius"], 5],
						"circle-color":        ["coalesce", ["get", "color"], "#888"],
						"circle-stroke-width": 1,
						"circle-stroke-color": "#ffffff",
						"circle-emissive-strength": 1,
					},
				}, beforeId);
				this._shapeIds.push(id);
				// Add a single-letter type label (caches show G/M/T/etc.,
				// drone-style; flights/vessels carry empty labels so the
				// symbol layer renders nothing for them).
				const labelId = id + "-label";
				mbMap.addLayer({
					id: labelId, type: "symbol", source: id,
					filter: ["all", ["has", "label"], ["!=", ["get", "label"], ""]],
					layout: {
						"text-field":            ["get", "label"],
						"text-font":             ["Open Sans Bold", "Arial Unicode MS Bold"],
						"text-size":             9,
						"text-allow-overlap":    true,
						"text-ignore-placement": true,
					},
					paint: {
						"text-color":             "#ffffff",
						"text-halo-color":        "#000",
						"text-halo-width":        1,
						"text-emissive-strength": 1,
					},
				}, beforeId);
				this._shapeIds.push(labelId);
				// One click handler per circle layer that opens
				// whatever URL the source feature carries. Wire it
				// once per source — Mapbox dedups by (layer, type).
				if (!this._wiredClick) this._wiredClick = new Set();
				if (!this._wiredClick.has(id)) {
					this._wiredClick.add(id);
					mbMap.on("click", id, (e) => {
						const url = e.features?.[0]?.properties?.url;
						// Only open https — the url comes from serialised
						// feature properties (external _dwData); a
						// non-https scheme (javascript:/data:) must never
						// reach window.open.
						if (url && /^https:\/\//i.test(url)) {
							window.open(url, "_blank", "noopener,noreferrer");
						}
					});
					mbMap.on("mouseenter", id, () => {
						mbMap.getCanvas().style.cursor = "pointer";
					});
					mbMap.on("mouseleave", id, () => {
						mbMap.getCanvas().style.cursor = "";
					});
				}
			}
		}
	}

	// Add Mapbox sources + layers for the route + waypoints. Idempotent
	// — safe to call multiple times; existing layers/sources are
	// dropped first. Uses `*-emissive-strength: 1` so the line and
	// points stay vivid against the 3D-lit terrain.
	// Mapbox-side hover popups for the feature layers we render —
	// INTVL territories (vector fill), geocaches / flights /
	// vessels (point circles). Wires `mousemove`/`mouseleave` per
	// layer ID; each layer's formatter pulls the right fields out
	// of the feature properties. Idempotent — if popups are
	// already set up, just rebinds the formatters.
	_wireHoverPopups(mapboxgl, mbMap) {
		if (!this._popup) {
			this._popup = new mapboxgl.Popup({
				closeButton:  false,
				closeOnClick: false,
				className:    "dw-mb-popup",
				offset:       12,
			});
		}
		const popup = this._popup;
		const bind = (layerId, fmt) => {
			if (!mbMap.getLayer(layerId)) return;
			if (!this._hoverBound) this._hoverBound = new Set();
			if (this._hoverBound.has(layerId)) return;
			this._hoverBound.add(layerId);
			mbMap.on("mousemove", layerId, (e) => {
				if (!e.features?.length) return;
				const html = fmt(e.features[0]);
				if (!html) return;
				popup.setLngLat(e.lngLat).setHTML(html).addTo(mbMap);
				mbMap.getCanvas().style.cursor = "pointer";
			});
			mbMap.on("mouseleave", layerId, () => {
				popup.remove();
				mbMap.getCanvas().style.cursor = "";
			});
		};

		// INTVL territories — currentArea (m²), startTime (day
		// offset), colour, activityId (cuid → precise time).
		bind("dw-cust-0-fill", (f) => {
			const p = f.properties || {};
			const swatch = p.colour
				? `<span style="display:inline-block;width:12px;height:12px;background:${_safeColor(p.colour, "#3b82f6")};border:1px solid #888;vertical-align:middle;margin-right:6px;"></span>`
				: "";
			const area = p.currentArea != null ? intvlArea(p.currentArea) : "?";
			const dt   = p.activityId ? intvlActivityTime(p.activityId) : null;
			const ago  = dt ? intvlAgo(dt) : "";
			return `${swatch}<b>${area}</b>` +
				(ago ? `<br><span style="font-size:11px;color:#666">${ago}</span>` : "");
		});

		// Geocaches — name, code, D/T, size, favs, owner.
		bind("dw-shapes-point-dwGeocachingPane", (f) => {
			const p = f.properties || {};
			if (!p.name && !p.code) return "";
			const lines = [`<b>${_escHtml(p.name || p.code)}</b>` +
				(p.found ? " ✓" : p.dnf ? " ✗" : "")];
			const meta = [];
			if (p.code) meta.push(_escHtml(p.code));
			if (p.diff != null && p.terr != null) meta.push(esc`D ${p.diff} / T ${p.terr}`);
			if (p.size) meta.push(_escHtml(String(p.size)));
			if (p.favs) meta.push(`♥ ${p.favs}`);
			if (meta.length) lines.push(
				`<span style="font-size:11px;color:#666">${meta.join(" · ")}</span>`);
			if (p.owner) lines.push(
				`<span style="font-size:11px;color:#666">by ${_escHtml(p.owner)}</span>`);
			return lines.join("<br>");
		});

		// Flights — currently just a placeholder dot; richer data
		// would come from the layer provider attaching _dwData.
		bind("dw-shapes-point-dwFlightsPane", (f) => {
			const p = f.properties || {};
			return _escHtml(p.label || p.name || "Aircraft");
		});

		// Marine vessels — same placeholder.
		bind("dw-shapes-point-dwMarinePane", (f) => {
			const p = f.properties || {};
			return _escHtml(p.label || p.name || "Vessel");
		});

		// Waze alerts — provider attaches _dwData.name (type + street).
		bind("dw-shapes-point-dwWazePane", (f) => {
			const p = f.properties || {};
			return _escHtml(p.name || p.label || "Waze report");
		});
	}

	_renderRoute(map, mbMap) {
		// Don't gate on `isStyleLoaded()` — Mapbox sometimes
		// returns false INSIDE the very `style.load` callback that
		// called us. `mbMap.once("style.load", ...)` then schedules
		// a handler that never fires (style.load already fired),
		// and the route line silently never gets added. Same race
		// already fixed for `_syncOverlays`. Probe via `getStyle()`
		// which returns truthy as soon as the style object exists,
		// and re-poll on the next frame if not.
		if (!mbMap.getStyle?.()) {
			requestAnimationFrame(() => this._renderRoute(map, mbMap));
			return;
		}
		const { line } = this._extractRouteGeojson(map);
		// Cheap content-equality check — skip the source-remove +
		// re-add cycle if nothing about the geometry changed.
		// Per feature we hash: coord count + first coord + last
		// coord + mid coord. Catches every kind of in-place edit
		// (waypoint add/remove changes counts; midpoint drag
		// changes the mid; endpoint drag changes first/last)
		// without serialising every coord.
		const sig = line.features.map((f) => {
			const c = f.geometry.coordinates;
			const n = c.length;
			if (!n) return "0";
			const fst = c[0],   lst = c[n - 1], mid = c[n >> 1];
			return `${n}:${fst[0]},${fst[1]}|${mid[0]},${mid[1]}|${lst[0]},${lst[1]}`;
		}).join(";");
		if (sig === this._lastRouteSig) return;
		this._lastRouteSig = sig;
		// Only the line layer is Mapbox-rendered now — the
		// waypoint dots + distance numbers come from Leaflet's
		// markerPane (which we no longer hide in 3D mode) so
		// drag-to-edit keeps working. Avoid double-rendering by
		// dropping the dw-route-points / dw-route-labels layers.
		for (const id of ["dw-route-line", "dw-route-points", "dw-route-labels"]) {
			try { if (mbMap.getLayer(id)) mbMap.removeLayer(id); } catch (_) {}
		}
		for (const id of ["dw-route-line", "dw-route-points"]) {
			try { if (mbMap.getSource(id)) mbMap.removeSource(id); } catch (_) {}
		}
		const beforeId = mbMap.getLayer("sky") ? "sky" : undefined;
		mbMap.addSource("dw-route-line", { type: "geojson", data: line });
		mbMap.addLayer({
			id: "dw-route-line", type: "line", source: "dw-route-line",
			layout: { "line-cap": "round", "line-join": "round" },
			paint: {
				"line-color":   ["coalesce", ["get", "color"], "#9400D3"],
				"line-width":   ["coalesce", ["get", "weight"], 6],
				"line-opacity": 0.9,
				"line-emissive-strength": 1,
			},
		}, beforeId);
	}

	// Hook layer-internal events that should trigger a re-sync.
	// Used by QLD Historical's `capturechange` (scrubber moved) so
	// the 3D mirror swaps to the new mosaicRule URL. Idempotent —
	// listeners are tracked per (layer, event) pair so we don't
	// double-hook on repeat syncs.
	_wireReloadEvents(map, mbMap) {
		if (!this._reloadHooks) this._reloadHooks = new WeakSet();
		map.eachLayer((lyr) => {
			const events = lyr._dwMb3DReloadOn;
			if (!events || !events.length) return;
			if (this._reloadHooks.has(lyr)) return;
			this._reloadHooks.add(lyr);
			const handler = () => {
				if (!this._mbMap) return;
				this._fullResync(map, this._mbMap);
			};
			for (const evt of events) {
				try { lyr.on(evt, handler); } catch (_) {}
			}
		});
	}

	// Inspect a single L.TileLayer and return a Mapbox-ready
	// raster-source spec, or null if it can't be mirrored. Handles
	// subdomain substitution per the layer's own options.subdomains
	// (Google uses "0123", OSM uses "abc", etc.) and the {r} retina
	// flag MapTiler-style templates expose.
	_layerToMbSpec(lyr) {
		if (!lyr) return null;
		const opts = lyr.options || {};
		const paneEl = opts.pane ? lyr._map?.getPane(opts.pane) : null;
		const zIndex = parseInt(paneEl?.style.zIndex || "200", 10) || 200;
		// Authoritative base/overlay split via the layer control's
		// own registry. Falls back to a pane heuristic (default
		// tilePane → base) if the control isn't reachable yet.
		let isBase = !opts.pane || opts.pane === "tilePane";
		const ctrl = this._app?._ctrl;
		if (ctrl?._layers) {
			const entry = ctrl._layers.find((l) => l.layer === lyr);
			if (entry) isBase = !entry.overlay;
		}
		const base = {
			maxzoom: opts.maxNativeZoom || opts.maxZoom || 22,
			opacity: typeof opts.opacity === "number" ? opts.opacity : 1,
			zIndex,
			isBase,
		};
		// Layers that publish a full Mapbox style spec (INTVL
		// vector, future OIM vector ports) are added separately by
		// _syncOverlays' custom-style walker — skip the raster
		// path so we don't add a redundant (and wrongly-shaped)
		// raster source too.
		if (lyr._dwMb3DStyle) return null;
		// Getter form — evaluated at every sync so token-aware
		// URLs (QLD Roads, QLD Globe — tokens rotate every few
		// hours) always reflect the current credential. Empty /
		// nullish return drops the layer for this sync; the
		// pending flag triggers a 3s retry from _syncOverlays so
		// the layer pops into 3D once the dependency resolves.
		if (typeof lyr._dwMb3DGetUrl === "function") {
			const url = lyr._dwMb3DGetUrl();
			if (url) return { ...base, url };
			this._hadPendingGetter = true;
			return null;
		}
		// Static Mapbox-native URL template (`{z}/{x}/{y}` or
		// `{bbox-epsg-3857}`). For layers whose URL doesn't depend
		// on anything that changes mid-session.
		if (lyr._dwMb3DUrl) {
			return { ...base, url: lyr._dwMb3DUrl };
		}
		// GM-fetcher-backed layers (Stamen Origin-spoof, QLD
		// Historical async catalog, Garmin canvas composite). On a
		// Mapbox build with addProtocol we'd use dw://; since v3 has
		// none, emit the sentinel template that the map's
		// transformRequest bridge serves from GM-fetched blobs.
		if (lyr._dwMbKey) {
			const url = hasDwMbProtocol()
				? `dw://${lyr._dwMbKey}/{z}/{x}/{y}.png`
				: dwTileSentinel(lyr._dwMbKey);
			return { ...base, url };
		}
		// Plain L.TileLayer with a `{z}/{x}/{y}` URL template.
		if (!(lyr instanceof L.TileLayer)) return null;
		const url = lyr._url;
		if (typeof url !== "string" || url.length < 5) return null;
		if (!/\{z\}/.test(url)) return null;
		if (!/\{[xy]\}/.test(url)) return null;
		const subs = opts.subdomains;
		const sub = Array.isArray(subs) ? subs[0] :
			(typeof subs === "string" && subs.length ? subs[0] : "a");
		let cleaned = url.replace(/\{s\}/g, sub).replace(/\{r\}/g, "@2x");
		if (/\{[^}]+\}/.test(cleaned.replace(/\{[xyz]\}/g, ""))) return null;
		return { ...base, url: cleaned };
	}

	// --- transformRequest bridge (see DW_TILE_PREFIX block) ----------
	// Called by Mapbox for every resource request. Non-sentinel URLs
	// pass through untouched; sentinel tile URLs are served from the
	// GM-fetched blob cache (or a transparent placeholder while the
	// fetch is in flight).
	_dwTransformRequest(url, resourceType) {
		if (!url || url.lastIndexOf(DW_TILE_PREFIX, 0) !== 0) {
			return { url };
		}
		// https://dwtile.local/<key>/<z>/<x>/<y>.png[?r=N]
		const path = url.slice(DW_TILE_PREFIX.length).split("?")[0];
		const m = path.match(/^([^/]+)\/(\d+)\/(\d+)\/(\d+)/);
		if (!m) return { url: DW_TRANSPARENT_PNG };
		const key = m[1], z = +m[2], x = +m[3], y = +m[4];
		const cacheKey = `${key}/${z}/${x}/${y}`;
		const blob = _dwTileBlobs.get(cacheKey);
		if (blob) return { url: blob };
		if (!_dwTileFailedRecently(cacheKey)) this._dwWarmTile(key, z, x, y, cacheKey);
		return { url: DW_TRANSPARENT_PNG };
	}

	// Fire the registered GM fetcher for a sentinel tile, cache the
	// resulting blob, and debounce a source reload so Mapbox
	// re-requests it (now served from cache). Failures are remembered
	// so a permanently-404 tile doesn't loop.
	_dwWarmTile(key, z, x, y, cacheKey) {
		if (_dwTileInflight.has(cacheKey) || _dwTileBlobs.has(cacheKey)) return;
		const fetcher = _dwMbLayers.get(key);
		if (!fetcher) { _dwTileFailed.set(cacheKey, Date.now()); return; }
		_dwTileInflight.add(cacheKey);
		Promise.resolve()
			.then(() => fetcher(z, x, y))
			.then((ab) => {
				_dwTileInflight.delete(cacheKey);
				if (!ab) { _dwTileFailed.set(cacheKey, Date.now()); return; }
				_dwTileFailed.delete(cacheKey);
				const blobUrl = URL.createObjectURL(
					new Blob([ab], { type: "image/png" }));
				_dwTileBlobs.set(cacheKey, blobUrl);
				_dwTileEvict();
				this._dwTilesDirty = true;
				this._scheduleTileReload();
			})
			.catch(() => {
				_dwTileInflight.delete(cacheKey);
				_dwTileFailed.set(cacheKey, Date.now());
				// A completed fetch (even a failure) may be the last one
				// blocking a deferred reload — re-evaluate.
				if (this._dwTilesDirty) this._scheduleTileReload();
			});
	}

	// Draw newly-warmed blobs by re-requesting each sentinel-backed
	// raster source's tiles (a cache-busting `?r=N` forces Mapbox to
	// treat them as new; transformRequest strips the query when
	// matching, so the blob cacheKey is stable).
	//
	// CRITICAL: a `setTiles` puts the source back into "loading", which
	// flips `isStyleLoaded()` false until the (fast, local) blobs load.
	// Other 3D sync paths gate on isStyleLoaded, so reloading on every
	// tile completion would keep the style perpetually unloaded during
	// a warm storm. So we DEFER the reload until the warm storm drains
	// (no fetches in flight), then reload once. New tiles requested
	// after that (edge pans, the reload re-requesting) warm + schedule
	// the next drain-reload, so it stays progressive across views while
	// each individual view settles cleanly.
	_scheduleTileReload() {
		clearTimeout(this._dwReloadTimer);
		this._dwReloadTimer = setTimeout(() => {
			const mb = this._mbMap;
			if (!this._active || !mb || !mb.getStyle?.()) return;
			if (_dwTileInflight.size > 0) { this._scheduleTileReload(); return; }
			if (!this._dwTilesDirty) return;
			this._dwTilesDirty = false;
			const sources = mb.getStyle().sources || {};
			const r = (this._dwReloadCounter = (this._dwReloadCounter || 0) + 1);
			for (const [id, src] of Object.entries(sources)) {
				const t = src && src.tiles && src.tiles[0];
				if (src.type !== "raster" || !t ||
					t.lastIndexOf(DW_TILE_PREFIX, 0) !== 0) continue;
				const base = t.split("?")[0];
				const s = mb.getSource(id);
				if (s && s.setTiles) {
					try { s.setTiles([`${base}?r=${r}`]); } catch (_) {}
				}
			}
		}, 300);
	}

	// Find the active base layer (lowest-z TileLayer in default
	// tilePane). Used by the basemap-tracker swap path.
	_activeBaseTiles(map) {
		let found = null;
		map.eachLayer((lyr) => {
			if (found) return;
			const spec = this._layerToMbSpec(lyr);
			if (!spec || !spec.isBase) return;
			found = { tiles: [spec.url], maxzoom: spec.maxzoom };
		});
		return found;
	}

	// Walk every active TileLayer and return all that can be
	// mirrored, sorted by pane z-index (ascending = bottom-up draw
	// order in Mapbox).
	_extractOverlayLayers(map) {
		const overlays = [];
		map.eachLayer((lyr) => {
			const spec = this._layerToMbSpec(lyr);
			if (!spec || spec.isBase) return;
			overlays.push(spec);
		});
		overlays.sort((a, b) => a.zIndex - b.zIndex);
		return overlays;
	}

	// Drop every previously-mirrored overlay, then re-add the
	// currently active ones. Called on layeradd/layerremove so
	// toggling a Leaflet layer mirrors live into the 3D scene.
	_syncOverlays(map, mbMap) {
		// Standalone entry — `_fullResync` calls the same code but
		// owns the `_hadPendingGetter` reset because it ALSO calls
		// `_activeBaseTiles` (which can set the flag). Re-zero it
		// here only when invoked directly (e.g. from style.load).
		if (!this._inFullResync) this._hadPendingGetter = false;
		return this._syncOverlaysImpl(map, mbMap);
	}

	_syncOverlaysImpl(map, mbMap) {
		if (!mbMap) return;
		// Don't gate on `isStyleLoaded()` — Mapbox sometimes
		// returns false *inside* the style.load callback (race
		// between event dispatch and the internal flag). Instead
		// wrap the actual addSource/addLayer calls in try/catch
		// and re-run on next animation frame if Mapbox isn't ready.
		if (!mbMap.getStyle?.()) {
			requestAnimationFrame(() => this._syncOverlaysImpl(map, mbMap));
			return;
		}
		// Re-hide any panes created since the last sync (e.g.
		// when a custom-canvas layer like INTVL or OIM Power is
		// toggled on AFTER 3D was enabled — its onAdd creates a
		// custom pane that defaults to opacity 1, so without
		// this it would render its 2D content on top of the
		// 3D scene, producing the double-render artefact).
		this._hideHiddenable(map);
		// Hook any `_dwMb3DReloadOn` events so layer-internal
		// state changes (e.g. QLD Historical's `capturechange`
		// when the scrubber moves to a different date) trigger a
		// resync — which re-runs the URL getter and refetches
		// tiles for the new capture.
		this._wireReloadEvents(map, mbMap);
		// Two-pass remove (layers, then sources). INTVL's vector
		// source has a dependent fill layer; OIM future port will
		// have multiple. Without two passes, source removal fails.
		const oldIds = this._overlayIds || [];
		for (const id of oldIds) {
			try { if (mbMap.getLayer(id)) mbMap.removeLayer(id); } catch (_) {}
		}
		for (const id of oldIds) {
			try { if (mbMap.getSource(id)) mbMap.removeSource(id); } catch (_) {}
		}
		this._overlayIds = [];
		// Insert overlay layers BEFORE the route line so the route
		// stays visible on top. Sky stays above everything.
		const beforeId = mbMap.getLayer("dw-route-line") ? "dw-route-line" :
			(mbMap.getLayer("sky") ? "sky" : undefined);
		const specs = this._extractOverlayLayers(map);
		specs.forEach((spec, i) => {
			const id = `dw-overlay-${i}`;
			try {
				mbMap.addSource(id, {
					type: "raster", tiles: [spec.url],
					tileSize: 256, maxzoom: spec.maxzoom,
				});
				mbMap.addLayer({
					id, type: "raster", source: id,
					paint: {
						"raster-opacity": spec.opacity,
						"raster-fade-duration": 0,
						// Make the raster emit at full strength so
						// Mapbox's terrain-lighting model doesn't
						// dim it. Without this, an overlay with
						// the same opacity as the 2D version (0.8
						// for Strava) looks ~40% darker in 3D
						// because the terrain shader treats it
						// like an unlit surface. emissive=1 makes
						// the raster behave like a self-lit decal
						// — colors come through as designed.
						"raster-emissive-strength": 1,
					},
				}, beforeId);
				this._overlayIds.push(id);
			} catch (e) {
				console.warn("[CustomTiles] 3D overlay mirror failed:", spec.url, e.message);
			}
		});
		// Custom Mapbox styles attached via `_dwMb3DStyle` (e.g.
		// INTVL's vector source). Each prefix-namespaces its
		// sources / layer ids so multiple layers don't collide,
		// and IDs are tracked on `_overlayIds` for the next purge.
		let cIdx = 0;
		map.eachLayer((lyr) => {
			const style = lyr?._dwMb3DStyle;
			if (!style) return;
			const prefix = `dw-cust-${cIdx++}`;
			const srcMap = {};
			for (const [k, src] of Object.entries(style.sources || {})) {
				const id = `${prefix}-${k}`;
				srcMap[k] = id;
				try {
					mbMap.addSource(id, src);
					this._overlayIds.push(id);
				} catch (e) {
					console.warn("[CustomTiles] 3D custom source:", id, e.message);
				}
			}
			for (const layer of (style.layers || [])) {
				const layerId = `${prefix}-${layer.id}`;
				const layerSpec = { ...layer, id: layerId };
				if (layer.source && srcMap[layer.source]) {
					layerSpec.source = srcMap[layer.source];
				}
				try {
					mbMap.addLayer(layerSpec, beforeId);
					this._overlayIds.push(layerId);
				} catch (e) {
					console.warn("[CustomTiles] 3D custom layer:", layerId, e.message);
				}
			}
		});
		// One-shot retry if any token-aware getter returned null
		// — gives the QLD CSRF/token bootstrap time to complete on
		// its async path. Must be a FULL resync, not _syncOverlays:
		// the pending getter can belong to the BASE layer (QLD Globe
		// is token-gated), and only _fullResync rebuilds active-base
		// — an overlays-only retry would leave the 3D base missing
		// until some unrelated event forced a full pass.
		if (!this._hadPendingGetter) {
			// Everything resolved — re-arm the retry budget for the
			// next time a token goes pending.
			this._pendingRetryCount = 0;
		} else if (!this._pendingRetry) {
			// Cap the retries: a token that never resolves (QLD
			// bootstrap failing outright) must not full-resync — and
			// flicker every overlay — every 3 s forever.
			this._pendingRetryCount = (this._pendingRetryCount || 0) + 1;
			if (this._pendingRetryCount <= 5) {
				this._pendingRetry = setTimeout(() => {
					this._pendingRetry = null;
					if (this._active && this._mbMap) {
						const mb = this._mbMap;
						this._runWhenStyleReady(mb, () => this._fullResync(map, mb));
					}
				}, 3000);
			}
		}
	}

	// Bi-directional viewport sync. The `_syncing` flag prevents the
	// ping-pong: when our handler programmatically moves one map, the
	// other map's resulting `moveend` is ignored.
	// While 3D is on, the camera can be tilted + rotated but
	// Leaflet's marker positioning is flat (north-up Mercator).
	// Without this sync, waypoints + distance labels drift away
	// from where they should land on the tilted terrain as the
	// user pitches or orbits. Override each marker's CSS
	// `transform` to whatever Mapbox would project it to, taking
	// the parent mapPane's translate into account so the position
	// is expressed in mapPane's local coordinate frame.
	//
	// Performance: this runs on every Mapbox `move` frame plus
	// MutationObserver and body-class triggers — easily 60Hz×N
	// during a zoom animation. Two optimisations:
	//   1. `_markerCache` is a Set populated on layeradd /
	//      layerremove so we don't walk `map.eachLayer` (which
	//      iterates EVERY layer, including 100s of OIM polylines)
	//      on every sync.
	//   2. `_requestMarkerSync` rAF-batches multiple triggers
	//      down to one sync per browser paint.
	_syncMarkersToMapbox(map, mbMap) {
		const mapPane = map.getPane("mapPane");
		if (!mapPane) return;
		const mapPanePos = map._getMapPanePos?.() || L.point(0, 0);
		const tx = mapPanePos.x, ty = mapPanePos.y;
		const cache = this._markerCache;
		if (!cache) return;
		// Self-pruning: when dynamic.watch removes a marker via
		// a path that DOESN'T fire `layerremove` (e.g. inside a
		// LayerGroup whose parent is removed, or a marker reused
		// for a different waypoint), the icon ends up detached
		// from the markerPane but our cache still holds it. We
		// then keep writing translate3d() to a detached DOM
		// node — invisible but cosmetic garbage. Worse, if the
		// marker's icon is re-attached later (Leaflet caches
		// elements), we re-position a phantom that the user
		// thought was deleted. Pruning at sync time keeps the
		// cache honest with no per-frame DOM cost beyond what
		// we're already doing for the live markers.
		const toPrune = [];
		for (const lyr of cache) {
			if (!lyr._map) {
				toPrune.push(lyr);
				continue;
			}
			const el = lyr._icon || lyr.getElement?.();
			if (!el || !el.parentNode) {
				toPrune.push(lyr);
				continue;
			}
		}
		for (const lyr of toPrune) cache.delete(lyr);
		// Project markers via plain `mb.project([lng, lat])`. This
		// puts them at the sea-level pixel for the lng/lat, which
		// is what the Mapbox line layer also uses for the route
		// without `line-elevation-reference: "ground"`. The
		// terrain-aware path through `transform.locationPoint3D`
		// returns coordinates in a different space and pushes
		// markers off-screen — keeping plain project for now.
		const elevProj = (lng, lat) => mbMap.project([lng, lat]);
		this._elevProj = elevProj;
		for (const lyr of cache) {
			const el = lyr._icon || lyr.getElement?.();
			if (!el) continue;
			const latlng = lyr.getLatLng?.();
			if (!latlng) continue;
			const point = elevProj(latlng.lng, latlng.lat);
			const px = Math.round(point.x - tx);
			const py = Math.round(point.y - ty);
			el.style.transform = `translate3d(${px}px, ${py}px, 0)`;
			// Keep Leaflet's tracked position in lock-step with
			// the visual transform — L.Draggable's drag math
			// reads it as `_startPos`, so leaving it stale at
			// Leaflet's flat-projection value causes the drag
			// to compute a cursor position offset from where
			// the user actually sees the marker.
			el._leaflet_pos = L.point(px, py);
		}
	}

	// Coalesces multiple sync triggers per frame down to one.
	// Triggered by Mapbox `move`, MutationObserver, body-class
	// observer — all can fire several times per frame during a
	// drag or zoom animation. Without batching, every trigger
	// re-walks the marker cache + Mapbox-projects each one.
	_requestMarkerSync(map, mbMap) {
		if (this._syncRequested) return;
		this._syncRequested = true;
		requestAnimationFrame(() => {
			this._syncRequested = false;
			if (this._active && this._mbMap === mbMap) {
				this._syncMarkersToMapbox(map, mbMap);
			}
		});
	}

	// Populate / maintain the marker cache. On enable: one walk
	// of `map.eachLayer` to seed. After that, layeradd / layerremove
	// listeners keep it in sync — far cheaper than re-walking the
	// whole map per Mapbox frame.
	//
	// Every add/remove also schedules a marker sync so a newly-
	// added marker gets Mapbox-projected immediately rather than
	// sitting at Leaflet's flat position until the next Mapbox
	// move event fires. This is the fix for the
	// "open an existing route, 3D auto-enables, waypoints stuck at
	// the 2D ground positions until you rotate" symptom.
	_wireMarkerCache(map) {
		this._markerCache = new Set();
		map.eachLayer((lyr) => {
			if (lyr instanceof L.Marker) this._markerCache.add(lyr);
		});
		this._onMarkerAdd = (e) => {
			if (!(e.layer instanceof L.Marker)) return;
			this._markerCache.add(e.layer);
			if (this._active && this._mbMap) {
				this._requestMarkerSync(map, this._mbMap);
			}
		};
		this._onMarkerRemove = (e) => {
			if (!(e.layer instanceof L.Marker)) return;
			this._markerCache.delete(e.layer);
			if (this._active && this._mbMap) {
				this._requestMarkerSync(map, this._mbMap);
			}
		};
		map.on("layeradd",    this._onMarkerAdd);
		map.on("layerremove", this._onMarkerRemove);
	}

	_unwireMarkerCache(map) {
		if (this._onMarkerAdd)    map.off("layeradd",    this._onMarkerAdd);
		if (this._onMarkerRemove) map.off("layerremove", this._onMarkerRemove);
		this._onMarkerAdd = this._onMarkerRemove = null;
		this._markerCache = null;
	}

	// Override Leaflet's flat (2D Mercator) `layerPointToLatLng`
	// and `containerPointToLatLng` to use Mapbox's terrain-aware
	// `unproject` while 3D is active. This is the inverse of
	// `_syncMarkersToMapbox` (which projects latLng → screen
	// pixels via Mapbox). Without it:
	//   • Tapping at the top of the 3D view places a waypoint
	//     wherever Leaflet's flat unproject lands (much closer
	//     than the terrain pixel the user actually tapped).
	//   • Dragging a marker stores `marker._latlng` via Leaflet's
	//     flat layerPointToLatLng — so the moment the drag ends
	//     and the marker re-syncs through Mapbox.project, it
	//     jumps to a different terrain position than where it
	//     was released.
	// Both fix transparently: dynamic.watch's planner reads
	// `e.latlng` from `map.click`, which chains through the
	// patched methods.
	_patchLeafletProjection(map) {
		if (this._unpatchProj) return;
		const controller = this;
		const origCPtoLL = map.containerPointToLatLng.bind(map);
		const origLPtoLL = map.layerPointToLatLng.bind(map);
		// Mapbox can return extreme (or NaN) lat/lng when asked
		// to unproject a screen point above the horizon in a
		// pitched view, or any pixel beyond the canvas. Falling
		// back to Leaflet's flat unproject in those cases stops
		// dragged waypoints from jumping to the antipode.
		const project = (sx, sy) => {
			const mb = controller._mbMap;
			const canvas = mb.getCanvas?.();
			const w = canvas?.clientWidth  || 0;
			const h = canvas?.clientHeight || 0;
			if (sx < 0 || sy < 0 || (w && sx > w) || (h && sy > h)) return null;
			const ll = mb.unproject([sx, sy]);
			if (!ll || !isFinite(ll.lat) || !isFinite(ll.lng)) return null;
			if (Math.abs(ll.lat) > 85 || Math.abs(ll.lng) > 180) return null;
			return L.latLng(ll.lat, ll.lng);
		};
		map.containerPointToLatLng = function (point) {
			if (controller._active && controller._mbMap) {
				try {
					const ll = project(point.x, point.y);
					if (ll) return ll;
				} catch (_) {}
			}
			return origCPtoLL(point);
		};
		map.layerPointToLatLng = function (point) {
			if (controller._active && controller._mbMap) {
				try {
					// `_getMapPanePos()` reads Leaflet's own
					// authoritative `_leaflet_pos` on the
					// mapPane — more reliable than parsing the
					// `style.transform` CSS (different browsers
					// sometimes serialise the value differently).
					const pp = map._getMapPanePos?.() || L.point(0, 0);
					const ll = project(point.x + pp.x, point.y + pp.y);
					if (ll) return ll;
				} catch (_) {}
			}
			return origLPtoLL(point);
		};
		this._unpatchProj = () => {
			map.containerPointToLatLng = origCPtoLL;
			map.layerPointToLatLng = origLPtoLL;
			this._unpatchProj = null;
		};
	}

	_unpatchLeafletProjection() {
		if (this._unpatchProj) this._unpatchProj();
	}

	// MutationObserver on markerPane re-applies the Mapbox sync
	// every time Leaflet mutates a marker's `style` attribute —
	// drag, zoom, or programmatic setLatLng all trigger it.
	// Without this hook, dragging a waypoint leaves it visually
	// stranded at Leaflet's flat-projection position. The
	// `syncing` flag prevents our own override from triggering
	// the observer in an infinite loop.
	//
	// IMPORTANT exception: while Leaflet is mid-drag (`document
	// .body.leaflet-dragging` class is set), we DO NOT sync.
	// Letting our Mapbox projection win during drag makes the
	// marker follow a curved path instead of the cursor — the
	// mouse moves linearly through Leaflet's flat coordinate
	// space, but Mapbox-projecting each frame's flat-derived
	// latLng pushes the icon onto a non-linear trajectory. A
	// second observer on `document.body` re-syncs the moment
	// the drag class clears, so the marker lands in the right
	// 3D spot once the user releases.
	_wireMarkerObserver(map, mbMap) {
		if (this._markerObserver) return;
		const markerPane = map.getPane("markerPane");
		if (!markerPane) return;
		let syncing = false;
		const isDragging = () =>
			document.body.classList.contains("leaflet-dragging");
		this._markerObserver = new MutationObserver(() => {
			if (syncing || !this._mbMap) return;
			if (isDragging()) return;
			syncing = true;
			try { this._requestMarkerSync(map, mbMap); }
			finally {
				requestAnimationFrame(() => { syncing = false; });
			}
		});
		this._markerObserver.observe(markerPane, {
			attributes: true,
			subtree: true,
			attributeFilter: ["style"],
		});
		// Body-class observer: catches the transition from
		// `leaflet-dragging` → not-dragging so we can re-sync
		// once after a drag ends (the marker-pane observer
		// doesn't fire again on its own at that moment because
		// Leaflet's finishDrag doesn't mutate marker styles).
		this._bodyObserver = new MutationObserver((muts) => {
			if (!this._mbMap) return;
			for (const m of muts) {
				const wasDragging = m.oldValue?.includes("leaflet-dragging");
				const nowDragging = isDragging();
				if (wasDragging && !nowDragging) {
					this._requestMarkerSync(map, mbMap);
					return;
				}
			}
		});
		this._bodyObserver.observe(document.body, {
			attributes: true,
			attributeOldValue: true,
			attributeFilter: ["class"],
		});
	}

	_unwireMarkerObserver() {
		if (this._markerObserver) {
			this._markerObserver.disconnect();
			this._markerObserver = null;
		}
		if (this._bodyObserver) {
			this._bodyObserver.disconnect();
			this._bodyObserver = null;
		}
		if (this._routePathObserver) {
			this._routePathObserver.disconnect();
			this._routePathObserver = null;
		}
		if (this._routePathDebounce) {
			clearTimeout(this._routePathDebounce);
			this._routePathDebounce = null;
		}
	}

	// Watch for route SVG path mutations. Leaflet's L.Polyline
	// `setLatLngs(...)` updates the SVG path's `d` attribute in
	// place — no `layeradd` / `layerremove` event fires, so our
	// existing tracker never knows the route changed (a removed
	// waypoint leaves the Mapbox-rendered line drawn through the
	// deleted point). Observing the `d` attribute on every path
	// in overlayPane catches every in-place edit and triggers a
	// debounced re-render.
	_wireRoutePathObserver(map, mbMap) {
		if (this._routePathObserver) return;
		const overlayPane = map.getPane("overlayPane");
		if (!overlayPane) return;
		this._routePathObserver = new MutationObserver(() => {
			if (!this._mbMap || !this._active) return;
			clearTimeout(this._routePathDebounce);
			this._routePathDebounce = setTimeout(() => {
				this._routePathDebounce = null;
				if (this._active && this._mbMap === mbMap) {
					this._renderRoute(map, mbMap);
				}
			}, 80);
		});
		this._routePathObserver.observe(overlayPane, {
			attributes: true,
			subtree: true,
			attributeFilter: ["d"],
		});
	}

	_wireSync(map) {
		// One-way sync: Mapbox → Leaflet. Every Mapbox `move` frame
		// (drag, scroll, orbit, fly) feeds back into Leaflet so the
		// underlying 2D state stays in sync — when the user toggles
		// 3D off, Leaflet is already where the Mapbox camera left
		// it. The reverse direction (Leaflet → Mapbox) is NOT
		// wired: while 3D is on Mapbox owns gestures and Leaflet's
		// `zoomend` events from our own sync would snap Mapbox back
		// mid-animation, producing a double-zoom artefact.
		// Hide markerPane on movestart, show + resync on moveend.
		// Per-frame Mapbox→Leaflet reprojection of every marker
		// can't keep up cleanly during fast rotation / zoom —
		// markers visually slide along curves that look glitchy
		// even when the math is right (Leaflet's marker icon is a
		// CSS-positioned div that doesn't share Mapbox's 3D
		// projection pipeline). Hiding the whole pane during
		// motion is both perfect-looking (no slide) AND much
		// cheaper than projecting N markers at 60 Hz.
		this._handler3DMoveStart = () => {
			this._isMoving = true;
			const p = map.getPane("markerPane");
			if (p && this._markerPanePrevVis == null) {
				this._markerPanePrevVis = p.style.visibility || "";
				p.style.visibility = "hidden";
			}
		};
		this._handler3DMove = () => {
			try {
				const c = this._mbMap.getCenter();
				const z = this._mbMap.getZoom();
				// Mapbox z = Leaflet z - 1 because our raster sources
				// declare tileSize: 256 while Mapbox defaults to 512.
				// Without the +1, the mirrored basemap renders at
				// half the user's expected scale.
				map.setView([c.lat, c.lng], Math.round(z + 1),
					{ animate: false });
				// Skip the per-frame marker sync while the pane is
				// hidden — it's invisible, no point projecting.
				if (!this._isMoving) {
					this._syncMarkersToMapbox(map, this._mbMap);
				}
			} catch (_) {}
		};
		this._handler3DMoveEnd = () => {
			this._isMoving = false;
			const p = map.getPane("markerPane");
			if (p && this._markerPanePrevVis != null) {
				p.style.visibility = this._markerPanePrevVis;
				this._markerPanePrevVis = null;
			}
			// Final sync at rest so markers land on the new
			// camera state before the pane unhides.
			try { this._syncMarkersToMapbox(map, this._mbMap); } catch (_) {}
		};
		this._handlerResize = () => {
			if (!this._mbMap) return;
			try { this._mbMap.resize(); } catch (_) {}
		};
		this._mbMap.on("movestart", this._handler3DMoveStart);
		this._mbMap.on("move",      this._handler3DMove);
		this._mbMap.on("moveend",   this._handler3DMoveEnd);
		map.on("resize", this._handlerResize);
	}

	_unwireSync(map) {
		if (this._mbMap) {
			try { if (this._handler3DMoveStart) this._mbMap.off("movestart", this._handler3DMoveStart); } catch (_) {}
			try { if (this._handler3DMove)      this._mbMap.off("move",      this._handler3DMove); } catch (_) {}
			try { if (this._handler3DMoveEnd)   this._mbMap.off("moveend",   this._handler3DMoveEnd); } catch (_) {}
		}
		if (this._handlerResize) {
			map.off("resize", this._handlerResize);
		}
		// Restore markerPane visibility if we were in a mid-move
		// state when disable fired (no moveend would arrive after
		// mbMap is gone).
		const p = map.getPane?.("markerPane");
		if (p && this._markerPanePrevVis != null) {
			p.style.visibility = this._markerPanePrevVis;
			this._markerPanePrevVis = null;
		}
		this._isMoving = false;
		this._handler3DMoveStart = this._handler3DMove = null;
		this._handler3DMoveEnd = this._handlerResize = null;
	}

	// Track Leaflet layer toggles. Split into two re-sync paths:
	//
	//   1. Tile/base/vector layer changes → `_fullResync` (heavy:
	//      wipes overlay raster sources and re-adds, which makes
	//      Mapbox refetch every tile). Trigger only when the
	//      changed layer is something we actually mirror as a
	//      Mapbox source — never for transient hover markers,
	//      route SVG vertex pings, or popup pane churn.
	//   2. Shape/marker layer changes (route edits, live-data
	//      poll, vector decode arriving) → lightweight
	//      `_renderLeafletShapes` + `_renderRoute` re-run. These
	//      just rebuild the GeoJSON sources; no raster reload.
	//
	// Without this split, dynamic.watch's mouseover hover-indicator
	// layer toggling on every mouse-enter/leave was triggering a
	// full overlay reload — the user-reported "tileset keeps
	// reloading whenever the mouse leaves the window" bug.
	_wireBasemapTracker(map) {
		let heavyDebounce = null, lightDebounce = null;
		const needsFullResync = (lyr) => {
			if (!lyr) return false;
			if (lyr instanceof L.TileLayer) return true;
			if (lyr._dwMb3DStyle) return true;
			// GM-bridge raster layers (Garmin is an L.GridLayer, not a
			// TileLayer) mirror as raster overlays via `_syncOverlays`,
			// which only the FULL resync runs. Without this they'd take
			// the light (shapes-only) path when toggled on in 3D and
			// silently never appear until a 3D off/on cycle.
			if (lyr._dwMbKey) return true;
			return false;
		};
		// `aliveCheck` runs inside every queued setTimeout so a
		// debounce that was scheduled while 3D was active but
		// fires after `disable()` (mbMap removed, _active=false)
		// becomes a silent no-op rather than calling into a
		// destroyed Mapbox style. The "Cannot read properties of
		// undefined (reading 'getOwnLayer')" warnings the stress
		// test was seeing came from this race.
		const aliveCheck = (mb) =>
			this._active && this._mbMap === mb && mb.getStyle?.();
		this._baseTracker = (e) => {
			const mb = this._mbMap;
			if (!mb) return;
			// Synchronously hide any newly-created pane BEFORE
			// the 80ms debounce fires. Cadastre / QPWS / Mobile
			// Coverage etc. create their custom pane in onAdd;
			// during the debounce window the pane is visible and
			// the Leaflet tile cache paints into it as a flat
			// overlay — visible to the user as the layer "showing
			// in 2D" until the next sync finally hides the pane.
			// (DOM-only; safe even before the Mapbox style is ready.)
			this._hideHiddenable(map);
			const isBase = e?.type === "baselayerchange";
			const wantsFull = isBase || needsFullResync(e?.layer);
			// NB: do NOT gate the whole handler on isStyleLoaded() —
			// removing the previous base flips it false transiently,
			// so a switch made before the prior layer finished
			// rendering would be dropped (the "changing layers
			// doesn't update the imagery" bug). Debounce, then run
			// once the style is ready via `_runWhenStyleReady`.
			if (wantsFull) {
				clearTimeout(heavyDebounce);
				heavyDebounce = setTimeout(() => {
					if (!aliveCheck(mb)) return;
					this._runWhenStyleReady(mb, () => this._fullResync(map, mb));
				}, 80);
			} else {
				clearTimeout(lightDebounce);
				lightDebounce = setTimeout(() => {
					if (!aliveCheck(mb)) return;
					this._runWhenStyleReady(mb, () => {
						this._renderLeafletShapes(map, mb);
						this._renderRoute(map, mb);
					});
				}, 80);
			}
		};
		this._baseTrackerTimers = () => {
			clearTimeout(heavyDebounce);
			clearTimeout(lightDebounce);
		};
		map.on("baselayerchange layeradd layerremove", this._baseTracker);
	}

	// Swap the active base + re-mirror all overlays + redraw the
	// route. The base goes via setTiles() if available, otherwise a
	// remove-and-re-add. All wrapped in try/catch because Mapbox v3
	// throws on a stale-source mutation if the user is toggling
	// rapidly.
	_fullResync(map, mb) {
		// Own the pending-getter reset for this whole pass so the
		// base + overlay flag tracking are unified — otherwise
		// `_syncOverlays` would reset the flag set by
		// `_activeBaseTiles` and we'd lose the retry signal.
		this._hadPendingGetter = false;
		this._inFullResync = true;
		try {
			const t = this._activeBaseTiles(map);
			// Always tear down + re-add the base in a known order
			// rather than `setTiles`-in-place. The reason: when
			// QLD Historical's catalog resolves AFTER overlays
			// have been added, an in-place addLayer (beforeId:
			// "sky") lands between the overlays and sky — i.e.
			// ON TOP of the overlays. Re-inserting it just above
			// `bg` guarantees the correct stacking regardless of
			// the order events arrived in.
			if (mb.getLayer("active-base")) mb.removeLayer("active-base");
			if (mb.getSource("active-base")) mb.removeSource("active-base");
			if (t) {
				mb.addSource("active-base", {
					type: "raster", tiles: t.tiles,
					tileSize: 256, maxzoom: t.maxzoom,
				});
				// Insert immediately after `bg` (the background
				// solid colour). Without `bg` (it should always
				// exist) fall back to whatever's first.
				const allLayers = mb.getStyle().layers;
				const bgIdx = allLayers.findIndex(l => l.id === "bg");
				const afterBgId = allLayers[bgIdx + 1]?.id;
				mb.addLayer({
					id: "active-base", type: "raster",
					source: "active-base",
					paint: { "raster-fade-duration": 0 },
				}, afterBgId);
			}
		} catch (e) {
			console.warn("[CustomTiles] 3D basemap swap failed:", e.message);
		}
		this._syncOverlays(map, mb);
		this._renderLeafletShapes(map, mb);
		this._renderRoute(map, mb);
		// Enforce final layer order so neither a late addLayer
		// (Strava re-mirrored after active-base was rebuilt) nor
		// a Mapbox style-load reorder can leave the base painted
		// ON TOP of the overlays. The "Strava heatmap not
		// rendering above the base" symptom was exactly this
		// race. Bottom-to-top:
		//   bg → active-base → overlays → shapes → route → sky
		try {
			const want = ["bg", "active-base",
				...(this._overlayIds || []),
				...(this._shapeIds   || []),
				"dw-route-line", "sky"];
			for (let i = 0; i < want.length - 1; i++) {
				const id = want[i], next = want[i + 1];
				if (mb.getLayer(id) && mb.getLayer(next)) {
					mb.moveLayer(id, next);
				}
			}
			if (mb.getLayer("sky")) mb.moveLayer("sky");
		} catch (_) {}
		this._inFullResync = false;
	}

	_unwireBasemapTracker(map) {
		if (this._baseTracker) {
			map.off("baselayerchange layeradd layerremove", this._baseTracker);
			this._baseTracker = null;
		}
		if (this._baseTrackerTimers) {
			this._baseTrackerTimers();
			this._baseTrackerTimers = null;
		}
	}
}

// Injects a 3D-toggle button into dynamic.watch's native
// `.leaflet-planner-controls` row (the bar with travel-mode / undo /
// save / elevation / distance). The row is rendered late by the
// site's planner React tree, so we wait for it via MutationObserver.
// The button mimics the native `btn btn-default fixed-width` styling
// so it sits flush; an `active` class darkens it when 3D is on.
export class Mode3DButton {
	static attach(map, controller) {
		const tryMount = () => {
			const row = document.querySelector(".leaflet-planner-controls");
			if (!row || row.querySelector(".dw-3d-btn")) return false;
			const btn = document.createElement("button");
			btn.type = "button";
			btn.className = "btn btn-default fixed-width dw-3d-btn";
			btn.id = "dw-3d-btn";
			btn.title = "Toggle 3D terrain";
			btn.setAttribute("aria-pressed", "false");
			btn.innerHTML = '<i class="fa fa-cube"></i>';
			const distance = row.querySelector(".distance");
			if (distance) row.insertBefore(btn, distance);
			else row.appendChild(btn);
			btn.addEventListener("click", (e) => {
				e.preventDefault();
				const turningOn = !controller.isActive();
				if (turningOn) {
					controller.enable(map);
					btn.classList.add("active");
					btn.setAttribute("aria-pressed", "true");
				} else {
					controller.disable(map);
					btn.classList.remove("active");
					btn.setAttribute("aria-pressed", "false");
				}
				GM_setValue(CFG.MODE_3D_STATE_KEY, turningOn);
			});
			// Restore prior on/off state. Defer the actual enable so the
			// site's planner finishes initialising — Mapbox GL grabbing
			// the canvas before Leaflet is settled tends to thrash.
			if (GM_getValue(CFG.MODE_3D_STATE_KEY, false)) {
				setTimeout(() => {
					if (controller.isActive()) return;
					controller.enable(map);
					btn.classList.add("active");
					btn.setAttribute("aria-pressed", "true");
				}, 300);
			}
			return true;
		};
		if (tryMount()) return;
		const obs = new MutationObserver(() => {
			if (tryMount()) {
				obs.disconnect();
				clearTimeout(timeoutId);
			}
		});
		obs.observe(document.body, { childList: true, subtree: true });
		// If after 15s we still haven't found `.leaflet-planner-controls`,
		// dynamic.watch most likely renamed or restructured the DOM. Log a
		// clear, actionable warning so the user knows it's not their setup.
		const timeoutId = setTimeout(() => {
			if (document.querySelector(".dw-3d-btn")) return;
			obs.disconnect();
			console.warn(
				"[CustomTiles] 3D button not injected after 15s — couldn't find" +
				" `.leaflet-planner-controls` in dynamic.watch's DOM. The site" +
				" likely renamed or restructured its planner toolbar. Please file" +
				" an issue at" +
				" https://github.com/CalculatedCausality/dynamicWatch-Custom-Tiles/issues" +
				" with a screenshot + browser version. The userscript will" +
				" continue running, only the 3D toggle is affected.",
			);
		}, 15_000);
	}
}

