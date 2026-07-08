import { BLANK_TILE, CFG } from "../config.js";
import { LayerProvider } from "../layers/provider-factories.js";
import { gmJsonGet } from "../utils/http.js";

/* -- Vexcel high-res aerial (ANZ viewer WMTS) ---------------------------
 * api.vexcelgroup.com serves the "urban" ortho mosaic (7.5 cm class,
 * Sunshine Coast flown 2019+) through a standard WMTS discovered via
 * /v2/ortho/wmts GetCapabilities: EPSG:3857, levels 0-21, JPEG/PNG,
 * CORS *. getTile only needs the account JWT — the viewer's `session`
 * param is not required for tiles.
 *
 * The JWT expires ~24 h after login and there's no anonymous mint or
 * renew endpoint, so this follows the Waze manual-token pattern: the
 * user pastes any api.vexcelgroup.com request URL (or the bare token)
 * once per day when the layer asks; it's stored in GM until expiry.
 * The token is never baked into the script.
 */

// Accept a bare JWT, or any URL/curl blob containing token=<jwt>.
export function _vexcelParseToken(raw) {
	const s = String(raw || "").trim();
	const m =
		s.match(/token=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/) ||
		s.match(/^([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/);
	return m ? m[1] : "";
}

// JWT payload `exp` (seconds) → epoch ms; 0 when undecodable.
export function _vexcelTokenExp(token) {
	try {
		const b64 = String(token).split(".")[1]
			.replace(/-/g, "+").replace(/_/g, "/");
		const payload = JSON.parse(atob(b64));
		return (Number(payload.exp) || 0) * 1000;
	} catch (_) { return 0; }
}

export function _vexcelTokenValid(token) {
	return !!token && _vexcelTokenExp(token) > Date.now() + 60 * 1000;
}

export function _vexcelTileTpl(token) {
	return (
		CFG.VEXCEL_WMTS_BASE +
		"?service=wmts&request=getTile&layer=urban&Style=RGB" +
		"&TileMatrixSet=urban&TileMatrix={z}&TileRow={y}&TileCol={x}" +
		"&format=image/jpeg&token=" + encodeURIComponent(token)
	);
}

/* -- Oblique / directional views ---------------------------------------
 * The ortho WMTS is locked to the current-best mosaic on this account
 * (collection/date params ignored; layer=<collection> → 403). But the
 * OBLIQUE photography is per-capture and reachable token-only:
 *   POST /v2/oriented/query → every (direction × capture) at a point
 *   GET  /v2/oriented/tile?downsample=&tile-x=&tile-y=&image-name=…
 *        → 256px JPEG tiles (CORS *), so the oblique loads progressively
 *        in chunks and pans/zooms as a Leaflet image pyramid.
 * So directional N/E/S/W views AND date selection live here, mirroring
 * the Vexcel viewer's oblique panel.
 */

// product-type → compass label. Vexcel names an oblique by the side it
// looks toward; the viewer surfaces these as N/E/S/W.
export const VEXCEL_DIRECTIONS = [
	{ key: "oblique-north", label: "N" },
	{ key: "oblique-east",  label: "E" },
	{ key: "oblique-south", label: "S" },
	{ key: "oblique-west",  label: "W" },
	{ key: "nadir",         label: "Top" },
];

// collection id → capture year for the date picker (au-qld-...-2019 →
// "2019", au-qld-...r2-2021 → "2021"). Falls back to the raw id.
export function _vexcelCollectionYear(collection) {
	const m = String(collection || "").match(/(\d{4})(?!.*\d{4})/);
	return m ? m[1] : String(collection || "");
}

// oriented/query FeatureCollection → { directions, captures, images }.
// images is keyed "<product-type>@<collection>" → { name, layer } for
// the first (best) photo in that cell; captures is the distinct
// collection list newest-first. Each image carries its own source
// layer (urban / wide-area) so extract targets the right program.
export function _vexcelParseObliques(data) {
	const images = {};
	const captureMeta = new Map(); // collection → { year, date }
	const dirSet = new Set();
	for (const f of (data && Array.isArray(data.features) ? data.features : [])) {
		const p = f.properties || {};
		const dir = p["product-type"];
		const coll = p.collection;
		const name = p["image-name"];
		if (!dir || !coll || !name) continue;
		const key = dir + "@" + coll;
		if (!(key in images)) {
			images[key] = {
				name,
				layer: p["source-layer"] || p.layer || "urban",
				w: Number(p["raster-size-width"]) || 0,
				h: Number(p["raster-size-height"]) || 0,
			};
		}
		if (!captureMeta.has(coll)) {
			// capture-date like "2019-11-29T04:23:00" → "2019-11-29".
			const date = String(p["capture-date"] || "").slice(0, 10) ||
				_vexcelCollectionYear(coll);
			captureMeta.set(coll, { year: _vexcelCollectionYear(coll), date });
		}
		dirSet.add(dir);
	}
	const captures = [...captureMeta.entries()]
		.map(([collection, meta]) => ({ collection, year: meta.year, date: meta.date }))
		.sort((a, b) => b.date.localeCompare(a.date));
	const directions = VEXCEL_DIRECTIONS.filter((d) => dirSet.has(d.key));
	return { images, captures, directions };
}

export function _vexcelObliqueExtractUrl(imageName, layer, lat, lng, token) {
	if (!imageName || !_vexcelTokenValid(token)) return "";
	const wkt = `POINT(${Number(lng)} ${Number(lat)})`;
	return (
		CFG.VEXCEL_API_BASE + "/v2/oriented/extract?" +
		"wkt=" + encodeURIComponent(wkt) +
		"&srid=4326&layer=" + encodeURIComponent(layer || "urban") +
		"&image-name=" + encodeURIComponent(imageName) +
		"&token=" + encodeURIComponent(token)
	);
}

// Tile-pyramid base for an oblique — /v2/oriented/tile serves 256px
// JPEG tiles token-only (CORS *), so the oblique loads progressively in
// chunks (pan/zoom) instead of one giant image. Leaflet fills in
// downsample/tile-x/tile-y per request via a custom getTileUrl.
export function _vexcelObliqueTileBase(imageName, layer, token) {
	if (!imageName || !_vexcelTokenValid(token)) return "";
	return (
		CFG.VEXCEL_API_BASE + "/v2/oriented/tile?layer=" +
		encodeURIComponent(layer || "urban") +
		"&image-name=" + encodeURIComponent(imageName) +
		"&token=" + encodeURIComponent(token)
	);
}

// Deepest downsample level (whole image ≈ one 256px tile). Leaflet zoom
// z maps to downsample = maxDownsample - z.
export function _vexcelMaxDownsample(w, h) {
	const px = Math.max(Number(w) || 256, Number(h) || 256);
	return Math.max(0, Math.ceil(Math.log2(px / 256)));
}

function _getStoredToken() {
	try { return GM_getValue(CFG.VEXCEL_TOKEN_KEY, "") || ""; }
	catch (_) { return ""; }
}

function _storeToken(t) {
	try { GM_setValue(CFG.VEXCEL_TOKEN_KEY, t); } catch (_) {}
}

function _promptForToken() {
	const raw = window.prompt(
		"Vexcel Aerial needs a fresh token (they expire daily).\n\n" +
		"1. Log in at " + CFG.VEXCEL_VIEWER_URL + "\n" +
		"2. DevTools → Network → copy any api.vexcelgroup.com request URL\n" +
		"3. Paste it here (the whole URL is fine):",
		"",
	);
	if (raw == null) return ""; // cancelled — don't nag again this add
	const tok = _vexcelParseToken(raw);
	if (tok) _storeToken(tok);
	return tok;
}

// Fetch every oblique/nadir capture available at a point (token-only,
// not rate-limited — this is the metadata query, not the image pull).
// Queries both programs (wide-area + urban) so rural/edge points that
// only have wide-area coverage still resolve.
export function fetchVexcelObliques(lat, lng, cb) {
	const token = _getStoredToken();
	if (!_vexcelTokenValid(token)) { cb(null); return; }
	gmJsonGet(
		CFG.VEXCEL_API_BASE + "/v2/oriented/query?token=" +
			encodeURIComponent(token),
		{
			method: "POST",
			data: JSON.stringify({
				wkt: `POINT(${Number(lng)} ${Number(lat)})`,
				srid: "4326",
				layer: "wide-area,urban",
				// image-center-distance-asc → the first image per cell is
				// the one whose frame is centred nearest the clicked point,
				// so the user's spot sits near the middle of the oblique.
				"order-by": "image-center-distance-asc",
				include: "collection,capture-date,product-type,image-name," +
					"source-layer,raster-size-width,raster-size-height",
			}),
			headers: { "Content-Type": "application/json" },
		},
		(err, data) => {
			if (err || !data) { cb(null); return; }
			const parsed = _vexcelParseObliques(data);
			cb(parsed.directions.length ? parsed : null);
		},
	);
}

function _dirLabel(key) {
	const d = VEXCEL_DIRECTIONS.find((x) => x.key === key);
	return d ? d.label : key;
}

/* -- Vexcel imagery compass (docked, layer-attached) ------------------
 * A passive button compass shown whenever the Vexcel base is active —
 * the counterpart to the QLD Historical compass. A compass rose of
 * direction buttons (N top, E right, S bottom, W left, ⊙ centre =
 * straight-down nadir) plus a capture-DATE SLIDER (older ⇢ newer).
 *
 * It does NOT auto-fetch on pan — that caused a "No imagery" flicker
 * whenever the map centre drifted over an uncovered gap. Instead it
 * just sits there; clicking a direction queries the captures at the
 * current centre on demand and loads that stitched oblique into an
 * expanding panel (extract is a heavy, rate-limited stitch). The flat
 * ortho basemap stays current-best (a tier lock); date + angle drive
 * the panel — "⊙" is the closest thing to dated 2D (nadir).
 */
let _vexCtl = null;

export function createVexcelControl() {
	if (_vexCtl) return _vexCtl;
	// Direction compass (small, docked) + a FULL-MAP overlay the oblique
	// fills. DATE scrubbing is delegated to the app's shared history bar
	// (same ◀ slider ▶ + date component every other time-series layer
	// uses) — this control exposes a capture adapter + fires
	// "capturechange" so that bar drives it. No bespoke date slider here.
	const el = document.createElement("div");
	el.className = "dw-vex-ctl";
	el.innerHTML =
		'<div class="dw-vex-rose">' +
		'<button type="button" class="dw-vex-dir dw-vex-n" data-dir="oblique-north" title="Look from the north">N</button>' +
		'<button type="button" class="dw-vex-dir dw-vex-w" data-dir="oblique-west" title="Look from the west">W</button>' +
		'<button type="button" class="dw-vex-dir dw-vex-c" data-dir="nadir" title="Straight down (dated)">⊙</button>' +
		'<button type="button" class="dw-vex-dir dw-vex-e" data-dir="oblique-east" title="Look from the east">E</button>' +
		'<button type="button" class="dw-vex-dir dw-vex-s" data-dir="oblique-south" title="Look from the south">S</button>' +
		"</div>";
	const overlay = document.createElement("div");
	overlay.className = "dw-vex-overlay";
	overlay.style.display = "none";
	overlay.innerHTML =
		'<button type="button" class="dw-vex-close" title="Back to map">✕ Map</button>' +
		'<div class="dw-vex-hint">drag to pan · scroll to zoom</div>' +
		'<div class="dw-vex-msg"></div>' +
		'<div class="dw-vex-tilemap"></div>';
	for (const node of [el, overlay]) {
		L.DomEvent.disableClickPropagation(node);
		L.DomEvent.disableScrollPropagation(node);
	}

	// Tiny event emitter so the app's _makeHistoryBar can bind
	// on/off("capturechange") exactly like it does for a real layer.
	const listeners = {};
	const ctl = {
		el, overlay, _map: null,
		lat: 0, lng: 0, atKey: "",
		model: null,
		dir: "oblique-north",
		capIdx: 0,       // index into model.captures (0 = newest)
		gen: 0,
		on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return ctl; },
		off(ev, fn) { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn); return ctl; },
		_fire(ev) { for (const f of listeners[ev] || []) { try { f(); } catch (_) {} } },
	};
	const mapEl   = overlay.querySelector(".dw-vex-tilemap");
	const msgEl   = overlay.querySelector(".dw-vex-msg");
	const dirBtns = [...el.querySelectorAll(".dw-vex-dir")];

	const setMsg = (t) => {
		overlay.style.display = "";
		msgEl.textContent = t;
		msgEl.style.display = t ? "" : "none";
	};
	const markActiveDir = () => dirBtns.forEach((b) =>
		b.classList.toggle("dw-vex-dir--on", b.dataset.dir === ctl.dir));

	// The oblique renders as a Leaflet image pyramid (CRS.Simple): 256px
	// JPEG tiles from /v2/oriented/tile load progressively as you pan/zoom
	// — no more one giant download. Created lazily (needs a sized div).
	ctl._imgMap = null;
	ctl._tileLayer = null;
	const ensureImgMap = () => {
		if (ctl._imgMap) return ctl._imgMap;
		ctl._imgMap = L.map(mapEl, {
			crs: L.CRS.Simple,
			attributionControl: false,
			zoomControl: true,
			minZoom: 0,
		});
		return ctl._imgMap;
	};

	const dropTiles = () => {
		if (ctl._tileLayer && ctl._imgMap) {
			ctl._imgMap.removeLayer(ctl._tileLayer);
			ctl._tileLayer = null;
		}
	};

	// Show the currently-selected oblique as a fresh tile pyramid.
	const load = () => {
		if (!ctl.model) return;
		const cap = ctl.model.captures[ctl.capIdx];
		const img = cap && ctl.model.images[ctl.dir + "@" + cap.collection];
		if (!img) {
			// e.g. nadir only flown some years — clear the stale pyramid
			// so the message shows on black, not over the old photo.
			dropTiles();
			setMsg("No " + _dirLabel(ctl.dir) + " photo for " + (cap ? cap.date : "this date") + " here.");
			return;
		}
		const token = _getStoredToken();
		const base = _vexcelObliqueTileBase(img.name, img.layer, token);
		if (!base) { setMsg("Vexcel token expired — reselect the base to refresh it."); return; }

		overlay.style.display = "";
		setMsg(""); // hide the message; the tile map fills the overlay
		const w = img.w || 10560, h = img.h || 14144;

		// Zoomify-style pyramid: level 0 = coarsest (~1 tile), maxZoom =
		// native. gridSize[z] bounds the valid tile grid per level so we
		// don't request off-image tiles, and downsample = maxZoom - z.
		const TS = 256;
		const sizes = [];
		let s = L.point(w, h);
		sizes.push(s);
		while (s.x > TS || s.y > TS) { s = s.divideBy(2).ceil(); sizes.push(s); }
		sizes.reverse();                       // index 0 = smallest
		const maxZ = sizes.length - 1;
		const grids = sizes.map((p) =>
			L.point(Math.ceil(p.x / TS), Math.ceil(p.y / TS)));

		const map = ensureImgMap();
		map.setMaxZoom(maxZ);
		map.invalidateSize();

		dropTiles();
		const TileCls = L.TileLayer.extend({
			getTileUrl(coords) {
				const ds = maxZ - coords.z; // 0 = native, maxZ = coarsest
				return base + "&downsample=" + ds +
					"&tile-x=" + coords.x + "&tile-y=" + coords.y;
			},
			// Only request tiles that exist in the level's grid — kills
			// the off-image 404 storm and keeps placement exact.
			_isValidTile(coords) {
				const g = grids[coords.z];
				return !!g && coords.x >= 0 && coords.y >= 0 &&
					coords.x < g.x && coords.y < g.y;
			},
		});
		ctl._tileLayer = new TileCls("", {
			tileSize: TS, minZoom: 0, maxZoom: maxZ,
			noWrap: true, crossOrigin: true, errorTileUrl: BLANK_TILE,
		}).addTo(map);

		// Image occupies pixels [0..w]×[0..h] at native zoom; CRS.Simple
		// flips y, so SW = (0,h), NE = (w,0).
		const bounds = L.latLngBounds(
			map.unproject([0, h], maxZ), map.unproject([w, 0], maxZ));
		map.setMaxBounds(bounds.pad(0.1));
		map.setMinZoom(Math.max(0, map.getBoundsZoom(bounds, false) - 0));
		// Open ZOOMED IN on the centre (the user's spot sits near the
		// frame middle) so dragging immediately streams new tiles — a
		// scrollable tileset, not a whole-image thumbnail. Scroll out for
		// the overview. One below native keeps context while leaving room
		// to pan; clamped so small frames still fit.
		const fitZ = map.getBoundsZoom(bounds, false);
		const initZ = Math.min(maxZ, Math.max(fitZ, maxZ - 1));
		map.setView(bounds.getCenter(), initZ, { animate: false });
	};

	// Query captures at the current map centre and refresh the date bar.
	// Cheap + un-throttled, so safe to run on every settle. Does NOT open
	// the overlay — that only happens on an explicit direction click.
	let refreshTimer = null;
	const refreshCaptures = () => {
		if (!ctl._map) return;
		const c = ctl._map.getCenter();
		const key = c.lat.toFixed(5) + "," + c.lng.toFixed(5);
		if (ctl.atKey === key) return;
		ctl.lat = c.lat; ctl.lng = c.lng; ctl.atKey = key;
		if (!_vexcelTokenValid(_getStoredToken())) {
			ctl.model = null; ctl._fire("capturechange"); return;
		}
		const gen = ++ctl.gen;
		fetchVexcelObliques(ctl.lat, ctl.lng, (model) => {
			if (gen !== ctl.gen && model == null) { /* keep prior on stale */ }
			ctl.model = model || null;
			if (model) {
				if (!model.directions.some((d) => d.key === ctl.dir)) ctl.dir = model.directions[0].key;
				if (ctl.capIdx >= model.captures.length) ctl.capIdx = 0;
				markActiveDir();
			}
			ctl._fire("capturechange"); // history bar re-reads count/idx/label
			// If the overlay is already open, refresh it for the new centre.
			if (overlay.style.display !== "none" && model) load();
		});
	};
	const scheduleRefresh = () => {
		clearTimeout(refreshTimer);
		refreshTimer = setTimeout(refreshCaptures, 500);
	};

	dirBtns.forEach((b) => b.addEventListener("click", () => {
		ctl.dir = b.dataset.dir;
		markActiveDir();
		if (!_vexcelTokenValid(_getStoredToken())) { setMsg("Paste a Vexcel token (reselect the base) to load imagery."); return; }
		if (!ctl.model) { setMsg("No Vexcel oblique here — recentre over a flown area."); return; }
		load();
	}));
	overlay.querySelector(".dw-vex-close").addEventListener("click", () => {
		overlay.style.display = "none";  // back to the live map
		ctl.gen++;
	});

	// -- history-bar adapter (dates) --------------------------------
	ctl.getCaptureCount = () => (ctl.model && ctl.model.captures.length) || 0;
	ctl.getCaptureIdx   = () => ctl.capIdx;
	ctl.getCaptureDate  = (i) => {
		const caps = (ctl.model && ctl.model.captures) || [];
		return caps[i] ? (caps[i].date || caps[i].year) : "";
	};
	ctl.setCapture = (i) => {
		ctl.capIdx = i;
		if (overlay.style.display !== "none" && ctl.model) load();
	};

	ctl.addTo = (m) => {
		if (ctl._map) return ctl;
		ctl._map = m;
		m.getContainer().appendChild(overlay);
		m.getContainer().appendChild(el);
		m.on("moveend", scheduleRefresh);
		markActiveDir();
		refreshCaptures();
		return ctl;
	};
	ctl.remove = () => {
		if (!ctl._map) return ctl;
		ctl._map.off("moveend", scheduleRefresh);
		clearTimeout(refreshTimer);
		ctl.gen++;
		if (ctl._imgMap) { try { ctl._imgMap.remove(); } catch (_) {} ctl._imgMap = null; ctl._tileLayer = null; }
		if (el.parentNode) el.parentNode.removeChild(el);
		if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
		ctl._map = null;
		return ctl;
	};
	_vexCtl = ctl;
	return ctl;
}

// True when a fresh-enough token exists.
export function vexcelHasToken() {
	return _vexcelTokenValid(_getStoredToken());
}

export class VexcelLayerProvider extends LayerProvider {
	create() {
		const stored = _getStoredToken();
		const layer = L.tileLayer(
			_vexcelTokenValid(stored) ? _vexcelTileTpl(stored) : BLANK_TILE,
			{
				tileSize: 256,
				maxNativeZoom: 21,
				maxZoom: 25,
				crossOrigin: true,
				// Urban program tiles 404 outside flown areas — render
				// those as blank rather than broken-image icons.
				errorTileUrl: BLANK_TILE,
				attribution:
					'&copy; <a href="https://www.vexcelgroup.com/" target="_blank"' +
					' rel="noreferrer">Vexcel Imaging</a>',
			},
		);
		// Token check happens when the base is SELECTED, not at boot —
		// a page-load prompt would be obnoxious and the token may well
		// have rotated since the last session.
		layer.on("add", (e) => {
			let tok = _getStoredToken();
			if (!_vexcelTokenValid(tok)) tok = _promptForToken();
			if (_vexcelTokenValid(tok)) {
				const tpl = _vexcelTileTpl(tok);
				if (layer._url !== tpl) layer.setUrl(tpl);
			}
			// Show the docked imagery compass (N/E/S/W/⊙ + date slider).
			const map = e && e.target && e.target._map;
			if (map) createVexcelControl().addTo(map);
		});
		layer.on("remove", () => {
			if (_vexCtl) _vexCtl.remove();
		});
		// 3D sync re-evaluates per sync, so a token pasted mid-session
		// flows into the Mapbox raster source without a mode toggle.
		layer._dwMb3DGetUrl = () => {
			const tok = _getStoredToken();
			return _vexcelTokenValid(tok) ? _vexcelTileTpl(tok) : "";
		};
		return layer;
	}
}
