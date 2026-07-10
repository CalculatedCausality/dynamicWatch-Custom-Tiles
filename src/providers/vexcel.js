import { dwMbGmFetchAB, dwRegisterMbLayer } from "../bridge/mapbox-tile-bridge.js";
import { BLANK_TILE, CFG } from "../config.js";
import { LayerProvider } from "../layers/provider-factories.js";
import { gmGet, gmJsonGet, wireTileAbort } from "../utils/http.js";
import {
	_clearSession,
	_ensureAuthedToken,
	_ensureQueryAuth,
	_ensureSession,
	_getStoredSession,
	_getStoredToken,
	_hasCreds,
	_storeToken,
	_vexcelOriginHeaders,
	_vexcelTokenValid,
} from "./vexcel-auth.js";

// Preserve the provider module's existing exports while app code can import
// auth helpers from their owning module directly.
export {
	_vexcelIsCredString,
	_vexcelLogin,
	_vexcelParseToken,
	_vexcelTokenExp,
	_vexcelTokenValid,
	vexcelHasToken,
} from "./vexcel-auth.js";

/* -- Vexcel imagery integration -----------------------------------------
 * This module owns Vexcel imagery models and URLs, metadata requests, the
 * docked oblique control, and the Leaflet/Mapbox tile layer. Credential,
 * token, and viewer-session lifecycle is isolated in vexcel-auth.js.
 */

export function _vexcelTileTpl(token, session) {
	const base =
		CFG.VEXCEL_WMTS_BASE +
		"?service=wmts&request=getTile&layer=urban&Style=RGB" +
		"&TileMatrixSet=urban&TileMatrix={z}&TileRow={y}&TileCol={x}" +
		"&format=image/jpeg";
	// The imagery service needs BOTH the session (from configuration/init)
	// AND the JWT — verified: session-only → 403 Forbidden, token-only → 403
	// "Unauthorized by Service", session+token (with the viewer Origin) →
	// 200. The tiles also require an Origin header, so these URLs are fetched
	// via GM_xmlhttpRequest (blob-bridged), never as plain <img> src.
	return session
		? base + "&session=" + encodeURIComponent(session) +
			"&token=" + encodeURIComponent(token)
		: base + "&token=" + encodeURIComponent(token);
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

// Band of an image from its name suffix — Vexcel serves each frame as
// `..._rgb` (true colour) and sometimes `..._irg` (near-infrared, false-
// colour: vegetation reads bright red). Only nadir has IR on SCC.
export function _vexcelBand(name) {
	return /_irg$/i.test(String(name || "")) ? "irg" : "rgb";
}

// oriented/query FeatureCollection → { directions, captures, images }.
// images is keyed "<product-type>@<collection>" → { rgb?, irg? }, each
// { name, layer, w, h, corners } for the first (best) photo in that
// cell+band; captures is the distinct collection list newest-first.
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
		const band = _vexcelBand(name);
		if (!images[key]) images[key] = {};
		if (!images[key][band]) {
			images[key][band] = {
				name,
				layer: p["source-layer"] || p.layer || "urban",
				w: Number(p["raster-size-width"]) || 0,
				h: Number(p["raster-size-height"]) || 0,
				corners: _vexcelFootprint(f.geometry),
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

// Tile-pyramid base for an oblique — /v2/oriented/tile serves 256px JPEG
// tiles, so the oblique loads progressively in chunks (pan/zoom) instead of
// one giant image. Needs session+token (and, on the wire, the viewer Origin
// header — added by the GM fetch), so tiles are GM-fetched + blob-bridged.
// downsample/tile-x/tile-y are appended per tile.
export function _vexcelObliqueTileBase(imageName, layer, token, session) {
	if (!imageName || !_vexcelTokenValid(token)) return "";
	return (
		CFG.VEXCEL_API_BASE + "/v2/oriented/tile?layer=" +
		encodeURIComponent(layer || "urban") +
		"&image-name=" + encodeURIComponent(imageName) +
		(session ? "&session=" + encodeURIComponent(session) : "") +
		"&token=" + encodeURIComponent(token)
	);
}

// Deepest downsample level (whole image ≈ one 256px tile). Leaflet zoom
// z maps to downsample = maxDownsample - z.
export function _vexcelMaxDownsample(w, h) {
	const px = Math.max(Number(w) || 256, Number(h) || 256);
	return Math.max(0, Math.ceil(Math.log2(px / 256)));
}

/* -- Frame footprint ↔ image-pixel mapping (continuous panning) --------
 * Each oblique is one aerial photo; to pan CONTINUOUSLY across the
 * survey we map the current view's pixel position to a ground point via
 * the frame's footprint, then load the neighbouring frame there. The
 * footprint is a quad (TL,TR,BR,BL matching image corners
 * [0,0],[w,0],[w,h],[0,h]); a bilinear map is enough (frames are ~nadir-
 * aligned, kappa≈0) and needs no matrix solve.
 */
export function _vexcelFootprint(geometry) {
	const ring = geometry && geometry.coordinates && geometry.coordinates[0];
	if (!Array.isArray(ring) || ring.length < 4) return null;
	// Drop the closing point if present; keep TL,TR,BR,BL.
	const c = ring.slice(0, 4).map((p) => [Number(p[0]), Number(p[1])]);
	return c.every((p) => isFinite(p[0]) && isFinite(p[1])) ? c : null;
}

// (u,v) in the unit square (u:0=left→1=right, v:0=top→1=bottom) → ground
// [lng,lat] via bilinear interpolation of the footprint corners.
export function _vexcelBilinear(corners, u, v) {
	const a = (1 - u) * (1 - v), b = u * (1 - v), d = u * v, e = (1 - u) * v;
	return [
		a * corners[0][0] + b * corners[1][0] + d * corners[2][0] + e * corners[3][0],
		a * corners[0][1] + b * corners[1][1] + d * corners[2][1] + e * corners[3][1],
	];
}

// Inverse: ground [lng,lat] → (u,v). Newton iteration from the centre
// (the map is close to affine, so this converges in a few steps).
export function _vexcelInvBilinear(corners, lng, lat) {
	let u = 0.5, v = 0.5;
	for (let i = 0; i < 15; i++) {
		const p = _vexcelBilinear(corners, u, v);
		const fx = p[0] - lng, fy = p[1] - lat;
		const du = 1e-4, dv = 1e-4;
		const pu = _vexcelBilinear(corners, u + du, v);
		const pv = _vexcelBilinear(corners, u, v + dv);
		const j00 = (pu[0] - p[0]) / du, j01 = (pv[0] - p[0]) / dv;
		const j10 = (pu[1] - p[1]) / du, j11 = (pv[1] - p[1]) / dv;
		const det = j00 * j11 - j01 * j10;
		if (!det) break;
		u -= (j11 * fx - j01 * fy) / det;
		v -= (-j10 * fx + j00 * fy) / det;
		u = Math.max(0, Math.min(1, u));
		v = Math.max(0, Math.min(1, v));
	}
	return [u, v];
}

// Fetch every oblique/nadir capture available at a point (token-only,
// not rate-limited — this is the metadata query, not the image pull).
// Queries both programs (wide-area + urban) so rural/edge points that
// only have wide-area coverage still resolve.
export function fetchVexcelObliques(lat, lng, cb) {
	_ensureQueryAuth((token, session) => {
		if (!token) { cb(null); return; }
		_fetchVexcelObliques(lat, lng, token, session, cb);
	});
}
function _fetchVexcelObliques(lat, lng, token, session, cb) {
	if (!_vexcelTokenValid(token)) { cb(null); return; }
	gmJsonGet(
		CFG.VEXCEL_API_BASE + "/v2/oriented/query?session=" +
			encodeURIComponent(session) + "&token=" + encodeURIComponent(token),
		{
			method: "POST",
			data: JSON.stringify({
				wkt: `POINT(${Number(lng)} ${Number(lat)})`,
				srid: "4326",
				layer: "wide-area,urban",
				// Both bands (rgb + irg) so the viewer can offer an IR
				// toggle; parse buckets them by the image-name suffix.
				// image-center-distance-asc → the first image per cell is
				// the one whose frame is centred nearest the clicked point,
				// so the user's spot sits near the middle of the oblique.
				"order-by": "image-center-distance-asc",
				include: "collection,capture-date,product-type,image-name," +
					"source-layer,raster-size-width,raster-size-height,geometry",
			}),
			headers: _vexcelOriginHeaders({ "Content-Type": "application/json" }),
		},
		(err, data, raw) => {
			// 401/403 = token rejected server-side despite a valid expiry
			// (quota/revoked). Do NOT clear the token here — `_ensureTokenSilent`
			// already refreshed an EXPIRED one, so a 403 means quota-capped,
			// and clearing would just make the basemap re-mint in a loop.
			// Report "auth" so the caller can show a message; the basemap's
			// give-up logic owns stopping the retries.
			if (raw && (raw.status === 401 || raw.status === 403)) {
				cb(null, "auth"); return;
			}
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

// Fetch the single best-centred frame for a direction+collection at a
// ground point — used while panning to pull the ADJACENT frame as the
// view crosses the current frame's edge.
export function fetchVexcelFrame(lng, lat, collection, dir, band, cb) {
	_ensureQueryAuth((token, session) => {
		if (!token) { cb(null); return; }
		_fetchVexcelFrame(lng, lat, collection, dir, band, token, session, cb);
	});
}
function _fetchVexcelFrame(lng, lat, collection, dir, band, token, session, cb) {
	if (!_vexcelTokenValid(token)) { cb(null); return; }
	gmJsonGet(
		CFG.VEXCEL_API_BASE + "/v2/oriented/query?session=" +
			encodeURIComponent(session) + "&token=" + encodeURIComponent(token),
		{
			method: "POST",
			data: JSON.stringify({
				wkt: `POINT(${Number(lng)} ${Number(lat)})`,
				srid: "4326", layer: "wide-area,urban",
				collection, "product-type": dir, bands: band || "rgb",
				"order-by": "image-center-distance-asc", "total-records": 1,
				include: "image-name,source-layer,raster-size-width," +
					"raster-size-height,geometry",
			}),
			headers: _vexcelOriginHeaders({ "Content-Type": "application/json" }),
		},
		(err, data) => {
			const f = !err && data && Array.isArray(data.features) && data.features[0];
			if (!f) { cb(null); return; }
			const p = f.properties || {};
			cb({
				name: p["image-name"], layer: p["source-layer"] || "urban",
				w: Number(p["raster-size-width"]) || 0,
				h: Number(p["raster-size-height"]) || 0,
				corners: _vexcelFootprint(f.geometry),
			});
		},
	);
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
let _vexLayer = null; // the base tile layer, so the control can drive date/band

// Flat-ortho capture dates at a point, newest-first — drives the date slider.
// Uses /v2/ortho/collections (final-ortho product), which lists every
// collection covering the point; the year is derived from the collection id.
export function fetchVexcelOrthoDates(lat, lng, cb) {
	_ensureQueryAuth((token, session) => {
		if (!token) { cb(null); return; }
		gmJsonGet(
			CFG.VEXCEL_API_BASE + "/v2/ortho/collections?wkt=" +
				encodeURIComponent(`POINT(${Number(lng)} ${Number(lat)})`) +
				"&srid=4326&layer=urban,wide-area&session=" +
				encodeURIComponent(session) + "&token=" + encodeURIComponent(token),
			{ headers: _vexcelOriginHeaders() },
			(err, data, raw) => {
				if (raw && (raw.status === 401 || raw.status === 403)) { cb(null, "auth"); return; }
				if (err || !data || !Array.isArray(data.features)) { cb(null); return; }
				const seen = new Set(), caps = [];
				for (const f of data.features) {
					const c = f.properties && f.properties.collection;
					if (!c || seen.has(c)) continue;
					seen.add(c);
					caps.push({ collection: c, year: _vexcelCollectionYear(c) });
				}
				// Newest first (year desc); the slider's index 0 = current-best.
				caps.sort((a, b) => String(b.year).localeCompare(String(a.year)));
				cb(caps.length ? caps : null);
			},
		);
	});
}

// Pull dynamic.watch's drawn route as an array of paths, each a list of
// [lng,lat] ground points. The route lives in leafletPlan.lines → segments →
// seg.polyline (an L.Polyline of the routed, road-snapped path). leafletPlan
// is a PAGE global, so reach it via unsafeWindow (the userscript sandbox
// can't see it on plain window) — the same bridge the app uses elsewhere.
export function _dwGetRoutePaths() {
	try {
		const pageWin = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
		const lp = pageWin.leafletPlan;
		if (!lp || !Array.isArray(lp.lines)) return [];
		const paths = [];
		for (const line of lp.lines) {
			if (!Array.isArray(line)) continue;
			for (const seg of line) {
				const pl = seg && seg.polyline;
				if (!pl || typeof pl.getLatLngs !== "function") continue;
				const lls = pl.getLatLngs();
				const flat = Array.isArray(lls[0]) ? lls.flat(Infinity) : lls;
				if (flat.length) paths.push(flat.map((ll) => [ll.lng, ll.lat]));
			}
		}
		return paths;
	} catch (_) { return []; }
}

export function createVexcelControl() {
	if (_vexCtl) return _vexCtl;
	// Docked control for the Vexcel base:
	//   • an IR toggle for the flat straight-down imagery (&bands=irg)
	//   • a compass rose (N/E/S/W/⊙) that opens the OBLIQUE viewer
	// Capture DATES ride the app's shared history bar (the adapter below);
	// the flat base is a normal dated tile layer. Clicking a compass angle
	// opens a full-map oblique for the current date + the dynamic.watch route
	// PROJECTED onto the photo (each ground point mapped into the oblique's
	// pixel space via the frame footprint), so the drawn line sits where it
	// really is on the angled image.
	const el = document.createElement("div");
	el.className = "dw-vex-ctl";
	el.innerHTML =
		'<div class="dw-vex-rose">' +
		'<button type="button" class="dw-vex-dir dw-vex-n" data-dir="oblique-north" title="Look from the north">N</button>' +
		'<button type="button" class="dw-vex-dir dw-vex-w" data-dir="oblique-west" title="Look from the west">W</button>' +
		'<button type="button" class="dw-vex-dir dw-vex-c" data-dir="nadir" title="Straight down">⊙</button>' +
		'<button type="button" class="dw-vex-dir dw-vex-e" data-dir="oblique-east" title="Look from the east">E</button>' +
		'<button type="button" class="dw-vex-dir dw-vex-s" data-dir="oblique-south" title="Look from the south">S</button>' +
		"</div>" +
		'<button type="button" class="dw-vex-ir" title="Toggle near-infrared on the flat map (vegetation shows red)">IR</button>' +
		'<div class="dw-vex-basemsg" style="display:none"></div>';
	const overlay = document.createElement("div");
	overlay.className = "dw-vex-overlay";
	overlay.style.display = "none";
	overlay.innerHTML =
		'<button type="button" class="dw-vex-close" title="Back to map">✕ Map</button>' +
		'<div class="dw-vex-hint">drag to pan · scroll to zoom · red line = your route</div>' +
		'<div class="dw-vex-msg"></div>' +
		'<div class="dw-vex-tilemap"></div>';
	for (const node of [el, overlay]) {
		L.DomEvent.disableClickPropagation(node);
		L.DomEvent.disableScrollPropagation(node);
	}

	const listeners = {};
	const ctl = {
		el, overlay, _map: null,
		lat: 0, lng: 0, atKey: "",
		captures: [],    // flat ortho dates [{collection, year}] newest-first
		capIdx: 0,
		band: "rgb",     // flat IR band
		obModel: null,   // oblique model {images, captures, directions} at centre
		obAtKey: "",     // centre the oblique model was queried for
		dir: "nadir",    // active oblique direction
		queried: false,  // flat dates query resolved?
		gen: 0,
		on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return ctl; },
		off(ev, fn) { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn); return ctl; },
		_fire(ev) { for (const f of listeners[ev] || []) { try { f(); } catch (_) {} } },
		setBaseMsg(text) {
			const n = el.querySelector(".dw-vex-basemsg");
			if (!n) return;
			n.textContent = text || "";
			n.style.display = text ? "block" : "none";
		},
	};
	const mapEl   = overlay.querySelector(".dw-vex-tilemap");
	const msgEl   = overlay.querySelector(".dw-vex-msg");
	const dirBtns = [...el.querySelectorAll(".dw-vex-dir")];
	const irBtn   = el.querySelector(".dw-vex-ir");

	const curCollection = () => {
		const cap = ctl.captures[ctl.capIdx];
		return cap ? cap.collection : "";
	};
	// The oblique cell {rgb?, irg?} for a direction at the current date.
	const cellFor = (dir) => {
		if (!ctl.obModel) return null;
		return ctl.obModel.images[dir + "@" + curCollection()] || null;
	};

	const setMsg = (t) => {
		const wasClosed = overlay.style.display === "none";
		overlay.style.display = "";
		msgEl.textContent = t;
		msgEl.style.display = t ? "" : "none";
		if (wasClosed) ctl._fire("overlaytoggle");
	};
	ctl.isOverlayOpen = () => overlay.style.display !== "none";

	// -- flat IR toggle ------------------------------------------------
	const updateIrBtn = () => {
		if (irBtn) irBtn.classList.toggle("dw-vex-ir--on", ctl.band === "irg");
	};
	if (irBtn) irBtn.addEventListener("click", () => {
		ctl.band = ctl.band === "irg" ? "rgb" : "irg";
		if (_vexLayer && _vexLayer._dwSetBand) _vexLayer._dwSetBand(ctl.band);
		updateIrBtn();
	});

	// -- oblique tile pyramid + route overlay --------------------------
	ctl._imgMap = null;
	ctl._tileLayer = null;
	ctl._routeLayer = null;
	ctl._frame = null;         // { name, layer, w, h, corners, collection, maxZ }
	ctl._suppressMove = false;
	const ensureImgMap = () => {
		if (ctl._imgMap) return ctl._imgMap;
		ctl._imgMap = L.map(mapEl, {
			crs: L.CRS.Simple, attributionControl: false,
			zoomControl: true, minZoom: 0,
		});
		ctl._imgMap.on("moveend", onInnerMove);
		return ctl._imgMap;
	};
	const dropTiles = () => {
		if (ctl._tileLayer && ctl._imgMap) { ctl._imgMap.removeLayer(ctl._tileLayer); ctl._tileLayer = null; }
	};

	// Project the dynamic.watch route into the current frame's pixel space
	// and draw it (red) on the oblique. Points outside the frame footprint
	// are clipped (bilinear extrapolation past the quad is meaningless), so
	// the line breaks where it leaves the photo.
	const drawRoute = () => {
		if (ctl._routeLayer && ctl._imgMap) { ctl._imgMap.removeLayer(ctl._routeLayer); ctl._routeLayer = null; }
		const f = ctl._frame, map = ctl._imgMap;
		if (!f || !f.corners || !map) return;
		const paths = _dwGetRoutePaths();
		if (!paths.length) return;
		const segs = [];
		for (const path of paths) {
			let run = [];
			for (const [lng, lat] of path) {
				const uv = _vexcelInvBilinear(f.corners, lng, lat);
				const u = uv[0], v = uv[1];
				if (u < -0.02 || u > 1.02 || v < -0.02 || v > 1.02) {
					if (run.length > 1) segs.push(run);
					run = [];
					continue;
				}
				run.push(map.unproject([u * f.w, v * f.h], f.maxZ));
			}
			if (run.length > 1) segs.push(run);
		}
		if (!segs.length) return;
		ctl._routeLayer = L.layerGroup(segs.map((s) =>
			L.polyline(s, { color: "#ff2d2d", weight: 3, opacity: 0.9,
				lineJoin: "round", lineCap: "round" }))).addTo(map);
	};

	const loadFrame = (frame, opts) => {
		opts = opts || {};
		const base = _vexcelObliqueTileBase(
			frame.name, frame.layer, _getStoredToken(), _getStoredSession());
		if (!base) { setMsg("Vexcel session expired — reselect the base to refresh it."); return; }
		setMsg(""); // opens the overlay + hides the message
		const w = frame.w || 10560, h = frame.h || 14144;
		const TS = 256;
		const sizes = [];
		let s = L.point(w, h);
		sizes.push(s);
		while (s.x > TS || s.y > TS) { s = s.divideBy(2).ceil(); sizes.push(s); }
		sizes.reverse();
		const maxZ = sizes.length - 1;
		const grids = sizes.map((p) => L.point(Math.ceil(p.x / TS), Math.ceil(p.y / TS)));

		const map = ensureImgMap();
		map.setMinZoom(0); map.setMaxZoom(maxZ); map.invalidateSize();

		dropTiles();
		// GM-fetch + blob-bridge (oriented/tile needs session + the viewer
		// Origin header, which an <img> can't send).
		const hdrs = _vexcelOriginHeaders({ Accept: "image/jpeg,image/*,*/*;q=0.8" });
		const TileCls = L.GridLayer.extend({
			createTile(coords, done) {
				const img = document.createElement("img");
				img.setAttribute("role", "presentation");
				const ds = maxZ - coords.z; // 0 = native, maxZ = coarsest
				const url = base + "&downsample=" + ds + "&tile-x=" + coords.x + "&tile-y=" + coords.y;
				img._dwHandle = gmGet(url, { responseType: "arraybuffer", headers: hdrs }, (err, r) => {
					img._dwHandle = null;
					if (err || !r || r.status !== 200) { img.src = BLANK_TILE; done(null, img); return; }
					const blob = new Blob([r.response], { type: "image/jpeg" });
					const objUrl = URL.createObjectURL(blob);
					img.onload = () => { URL.revokeObjectURL(objUrl); done(null, img); };
					img.onerror = () => { URL.revokeObjectURL(objUrl); img.src = BLANK_TILE; done(null, img); };
					img.src = objUrl;
				});
				return img;
			},
			_isValidTile(coords) {
				const g = grids[coords.z];
				return !!g && coords.x >= 0 && coords.y >= 0 && coords.x < g.x && coords.y < g.y;
			},
		});
		ctl._tileLayer = new TileCls({ tileSize: TS, minZoom: 0, maxZoom: maxZ, noWrap: true }).addTo(map);
		wireTileAbort(ctl._tileLayer);

		const bounds = L.latLngBounds(map.unproject([0, h], maxZ), map.unproject([w, 0], maxZ));
		map.setMaxBounds(bounds.pad(0.1));
		ctl._frame = Object.assign({ collection: frame.collection, maxZ, w, h }, frame);

		const keepZ = opts.keepZoom && map.getZoom();
		let center = bounds.getCenter(), z;
		if (opts.center && frame.corners) {
			const uv = _vexcelInvBilinear(frame.corners, opts.center[0], opts.center[1]);
			center = map.unproject([uv[0] * w, uv[1] * h], maxZ);
			z = keepZ || Math.min(maxZ, Math.max(map.getBoundsZoom(bounds, false), maxZ - 1));
		} else {
			z = Math.min(maxZ, Math.max(map.getBoundsZoom(bounds, false), maxZ - 1));
		}
		ctl._suppressMove = true;
		map.setView(center, z, { animate: false });
		drawRoute();
		markActiveDir();
	};

	// Show the selected direction + date as an oblique frame.
	const load = () => {
		if (!ctl.obModel) { setMsg("No Vexcel oblique here — recentre over a flown area."); return; }
		const cell = cellFor(ctl.dir);
		const img = cell ? (cell.rgb || cell.irg) : null;
		if (!img) {
			dropTiles();
			if (ctl._routeLayer && ctl._imgMap) { ctl._imgMap.removeLayer(ctl._routeLayer); ctl._routeLayer = null; }
			setMsg("No " + _dirLabel(ctl.dir) + " photo for " + (curCollection() || "this date") + " here.");
			ctl._frame = null;
			return;
		}
		loadFrame(Object.assign({ collection: curCollection() }, img));
	};

	// Continuous panning: settle → pull the neighbouring frame best-centred
	// under the view and switch to it (keeping the ground point centred).
	let panTimer = null;
	const onInnerMove = () => {
		if (ctl._suppressMove) { ctl._suppressMove = false; return; }
		const f = ctl._frame;
		if (!f || !f.corners || !ctl.obModel) return;
		clearTimeout(panTimer);
		panTimer = setTimeout(() => {
			const map = ctl._imgMap;
			if (!map || !ctl.isOverlayOpen()) return;
			const pt = map.project(map.getCenter(), f.maxZ);
			const u = Math.max(0, Math.min(1, pt.x / f.w));
			const v = Math.max(0, Math.min(1, pt.y / f.h));
			const ground = _vexcelBilinear(f.corners, u, v);
			fetchVexcelFrame(ground[0], ground[1], curCollection(), ctl.dir, "rgb", (fr) => {
				if (!fr || !fr.name || !ctl.isOverlayOpen()) return;
				if (fr.name === f.name) { drawRoute(); return; }
				loadFrame(Object.assign({ collection: curCollection() }, fr), { center: ground, keepZoom: true });
			});
		}, 300);
	};

	// Grey out any direction with no photo for the current date; highlight
	// the active one only while the overlay is open.
	const dirHasPhoto = (dir) => { const c = cellFor(dir); return !!(c && (c.rgb || c.irg)); };
	function markActiveDir() {
		dirBtns.forEach((b) => {
			const has = dirHasPhoto(b.dataset.dir);
			b.classList.toggle("dw-vex-dir--on", ctl.isOverlayOpen() && b.dataset.dir === ctl.dir && has);
			b.classList.toggle("dw-vex-dir--off", !!ctl.obModel && !has);
			b.disabled = !!ctl.obModel && !has;
		});
	}

	// Ensure the oblique model for the current centre, then run cb().
	const ensureObModel = (cb) => {
		const key = ctl.lat.toFixed(5) + "," + ctl.lng.toFixed(5);
		if (ctl.obModel && ctl.obAtKey === key) { cb(); return; }
		setMsg("Loading oblique imagery…");
		fetchVexcelObliques(ctl.lat, ctl.lng, (model) => {
			ctl.obModel = model || null;
			ctl.obAtKey = key;
			markActiveDir();
			cb();
		});
	};

	dirBtns.forEach((b) => b.addEventListener("click", () => {
		if (b.disabled) return;
		if (!_vexcelTokenValid(_getStoredToken()) && !_hasCreds()) {
			setMsg("Sign in to Vexcel (reselect the base) to load imagery."); return;
		}
		ctl.dir = b.dataset.dir;
		setMsg("Loading oblique imagery…");
		ensureObModel(() => { markActiveDir(); load(); });
	}));

	overlay.querySelector(".dw-vex-close").addEventListener("click", () => {
		overlay.style.display = "none";
		ctl.gen++;
		markActiveDir();
		ctl._fire("overlaytoggle");
	});

	// -- history-bar adapter (flat capture dates) ----------------------
	ctl.getCaptureCount = () => ctl.captures.length;
	ctl.getCaptureIdx   = () => ctl.capIdx;
	ctl.getCaptureState = () => !ctl.queried ? "loading" : (ctl.captures.length ? "ready" : "empty");
	ctl.getCaptureDate  = (i) => (ctl.captures[i] ? ctl.captures[i].year : "");
	ctl.setCapture = (i) => {
		ctl.capIdx = i;
		const cap = ctl.captures[i];
		if (_vexLayer && _vexLayer._dwSetCollection) {
			_vexLayer._dwSetCollection(i === 0 ? "" : (cap ? cap.collection : ""));
		}
		// If the oblique overlay is open, reload it for the newly-picked date.
		if (ctl.isOverlayOpen()) { markActiveDir(); load(); }
	};

	// Query the flat capture dates at the current map centre (drives the date
	// bar + the flat base). Oblique data is fetched lazily on compass click.
	let refreshTimer = null;
	const refreshCaptures = () => {
		if (!ctl._map) return;
		const c = ctl._map.getCenter();
		const key = c.lat.toFixed(4) + "," + c.lng.toFixed(4);
		if (ctl.atKey === key) return;
		ctl.lat = c.lat; ctl.lng = c.lng; ctl.atKey = key;
		ctl.obModel = null; ctl.obAtKey = ""; // invalidate obliques for the new centre
		if (!_vexcelTokenValid(_getStoredToken()) && !_hasCreds()) {
			ctl.captures = []; ctl.queried = true; ctl._fire("capturechange"); return;
		}
		ctl.queried = false; ctl._fire("capturechange");
		const gen = ++ctl.gen;
		fetchVexcelOrthoDates(ctl.lat, ctl.lng, (caps) => {
			if (gen !== ctl.gen) return;
			ctl.captures = caps || [];
			ctl.queried = true;
			if (ctl.capIdx >= ctl.captures.length) ctl.capIdx = 0;
			ctl._fire("capturechange");
		});
	};
	const scheduleRefresh = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(refreshCaptures, 500); };

	ctl.addTo = (m) => {
		if (ctl._map) return ctl;
		ctl._map = m;
		m.getContainer().appendChild(overlay);
		m.getContainer().appendChild(el);
		m.on("moveend", scheduleRefresh);
		updateIrBtn();
		markActiveDir();
		refreshCaptures();
		return ctl;
	};
	ctl.remove = () => {
		if (!ctl._map) return ctl;
		ctl._map.off("moveend", scheduleRefresh);
		clearTimeout(refreshTimer);
		ctl.gen++;
		if (ctl._imgMap) { try { ctl._imgMap.remove(); } catch (_) {} ctl._imgMap = null; ctl._tileLayer = null; ctl._routeLayer = null; }
		if (el.parentNode) el.parentNode.removeChild(el);
		if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
		ctl._map = null;
		return ctl;
	};
	_vexCtl = ctl;
	return ctl;
}

export class VexcelLayerProvider extends LayerProvider {
	create() {
		const spoofOrigin = CFG.VEXCEL_SPOOF_ORIGIN;
		// The imagery service requires the ANZ-viewer Origin header AND both
		// the session + JWT on the query string. An <img> tile can send
		// neither a spoofed Origin nor be gated behind an async session, so
		// tiles are GM-fetched (which CAN set Origin) and blob-bridged, the
		// same pattern Stamen/QLD-Historical use.
		const tileHeaders = {
			Origin: spoofOrigin,
			Referer: spoofOrigin + "/",
			Accept: "image/jpeg,image/*,*/*;q=0.8",
		};
		// Concrete per-tile URL on the viewer's world-layer /ortho/tile
		// endpoint (256px, same tiles as wmts but — unlike wmts — it honours
		// date + band params). "" until a session exists (then the layer
		// redraws), so we never fire a doomed token-only request.
		//   layer._dwVexColl : ""=newest, else order-by that collection (date)
		//   layer._dwVexBand : "rgb" | "irg" (near-infrared, &bands=irg)
		const tileUrl = (z, x, y) => {
			const tok = _getStoredToken(), sess = _getStoredSession();
			if (!_vexcelTokenValid(tok) || !sess) return "";
			let u = CFG.VEXCEL_API_BASE + "/v2/ortho/tile?zoom=" + z +
				"&tile-x=" + x + "&tile-y=" + y +
				"&interpolation=true&layer=urban,wide-area" +
				"&session=" + encodeURIComponent(sess) +
				"&token=" + encodeURIComponent(tok);
			if (layer._dwVexColl) {
				u += "&order-by=" + encodeURIComponent(layer._dwVexColl) +
					",collection-last-capture-date-desc";
			}
			if (layer._dwVexBand === "irg") u += "&bands=irg";
			return u;
		};

		const VexGrid = L.GridLayer.extend({
			createTile(coords, done) {
				const img = document.createElement("img");
				img.setAttribute("role", "presentation");
				const url = tileUrl(coords.z, coords.x, coords.y);
				// Given up, or creds not minted yet → blank (a redraw after
				// auth repaints). data: src so it "loads" without erroring.
				if (this._dwAuthGaveUp || !url) {
					img.src = BLANK_TILE;
					setTimeout(() => done(null, img), 0);
					return img;
				}
				img._dwHandle = gmGet(url, {
					responseType: "arraybuffer", headers: tileHeaders,
				}, (err, r) => {
					img._dwHandle = null;
					if (err) { done(new Error("Vexcel " + err.message), img); return; }
					// 404 = outside flown coverage → blank, NOT an error (so a
					// pan over a gap doesn't look like an auth failure). Only
					// 401/403 (session/token refused) trips the burst.
					if (r.status === 404) { img.src = BLANK_TILE; done(null, img); return; }
					if (r.status !== 200) { done(new Error("Vexcel HTTP " + r.status), img); return; }
					const blob = new Blob([r.response], { type: "image/jpeg" });
					const objUrl = URL.createObjectURL(blob);
					img.onload = () => { URL.revokeObjectURL(objUrl); done(null, img); };
					img.onerror = () => {
						URL.revokeObjectURL(objUrl);
						done(new Error("Vexcel decode failed"), img);
					};
					img.src = objUrl;
				});
				return img;
			},
		});

		const layer = new VexGrid({
			tileSize: 256,
			maxNativeZoom: 21,
			maxZoom: 25,
			attribution:
				'&copy; <a href="https://www.vexcelgroup.com/" target="_blank"' +
				' rel="noreferrer">Vexcel Imaging</a>',
		});
		wireTileAbort(layer);
		// Date (collection) + band state, driven by the docked control. ""
		// collection = current-best (newest); a set collection scrubs to that
		// capture date. Setters redraw only on a real change.
		layer._dwVexColl = "";
		layer._dwVexBand = "rgb";
		layer._dwSetCollection = (c) => {
			if ((c || "") === layer._dwVexColl) return;
			layer._dwVexColl = c || "";
			layer.redraw();
		};
		layer._dwSetBand = (b) => {
			if (b !== layer._dwVexBand) { layer._dwVexBand = b; layer.redraw(); }
		};
		_vexLayer = layer; // so the control can drive date/band

		// Auth happens when the base is SELECTED, not at boot — a page-load
		// prompt would be obnoxious and the token may have rotated. Mint the
		// session (once per token, via configuration/init with the Origin
		// header) then redraw so tiles carry session+token.
		layer.on("add", (e) => {
			layer._dwAuthTries = 0; // fresh activation → allow re-auth
			layer._dwAuthGaveUp = false;
			const ready = (tok) => {
				if (!_vexcelTokenValid(tok)) return;
				_ensureSession(tok, () => layer.redraw());
			};
			const cur = _getStoredToken();
			if (_vexcelTokenValid(cur)) ready(cur);
			else _ensureAuthedToken(undefined, ready); // silent auto-login / prompt
			// Show the docked IR toggle (dates ride the shared history bar).
			const map = e && e.target && e.target._map;
			if (map) createVexcelControl().addTo(map);
		});
		layer.on("remove", () => {
			if (_vexCtl) _vexCtl.remove();
		});
		// A real (blob:) tile painted ⇒ session+token+account are all fine →
		// re-arm re-auth and clear any notice. Ignore data: blanks (coverage
		// gaps / not-yet-authed), else the give-up counter would reset on
		// every blank and the storm would never converge.
		layer.on("tileload", (e) => {
			const src = (e && e.tile && e.tile.src) || "";
			if (src.slice(0, 5) === "data:") return; // blank fallback, not a real paint
			layer._dwAuthTries = 0;
			layer._dwAuthGaveUp = false;
			if (_vexCtl && _vexCtl.setBaseMsg) _vexCtl.setBaseMsg("");
		});
		// A BURST of tile errors = the session/token was refused (out-of-
		// coverage 404s blank instead of erroring, so they don't count).
		// Escalate cheaply: (0) the session may have expired while the JWT is
		// still valid → re-mint it via init; (1) the JWT itself is bad →
		// re-auth from creds/prompt + re-mint; (2) give up (account refused /
		// no coverage) — blank and stop, re-armed only by a real paint or a
		// base re-toggle. This bounds logins (≤1 extra) so we never storm.
		let errBurst = 0, errTimer = null;
		layer.on("tileerror", () => {
			if (!layer._map || layer._dwReprompt || layer._dwAuthGaveUp) return;
			errBurst++;
			clearTimeout(errTimer);
			errTimer = setTimeout(() => { errBurst = 0; }, 3000);
			if (errBurst < 6) return;
			errBurst = 0;
			layer._dwReprompt = true;
			const tok = _getStoredToken();
			if (layer._dwAuthTries === 0 && _vexcelTokenValid(tok)) {
				layer._dwAuthTries = 1;
				_clearSession(); // force a fresh session for the same JWT
				_ensureSession(tok, () => { layer._dwReprompt = false; layer.redraw(); });
				return;
			}
			if (layer._dwAuthTries === 1) {
				layer._dwAuthTries = 2;
				_storeToken(""); _clearSession(); // drop both, re-auth from scratch
				_ensureAuthedToken(
					"Vexcel refused the current session (expired or usage limit).",
					(t) => {
						layer._dwReprompt = false;
						if (_vexcelTokenValid(t)) {
							_ensureSession(t, () => layer.redraw());
							if (_vexCtl) { _vexCtl.atKey = ""; } // force a re-query
						} else {
							layer._dwAuthGaveUp = true; layer.redraw();
						}
					},
				);
				return;
			}
			// Re-minted the session AND re-authed and STILL refused → the
			// account/session is refused here or there's no coverage. Stop.
			layer._dwReprompt = false;
			layer._dwAuthGaveUp = true;
			layer.redraw();
			if (_vexCtl && _vexCtl.setBaseMsg) {
				_vexCtl.setBaseMsg(
					"No Vexcel imagery loaded here — either this area isn't " +
					"covered, or the account/session was refused. Try another " +
					"area, or reselect the base.");
			}
			console.warn("[CustomTiles] Vexcel: session+token still refused after " +
				"re-auth — no coverage or account refused; stopping retries.");
		});
		// 3D: the Mapbox raster source can't send a spoofed Origin either, so
		// register the same GM-fetch bridge (dw:// / transformRequest) 2D
		// uses. NO _dwMb3DGetUrl — that path would emit a plain raster URL
		// with no Origin header and 401.
		dwRegisterMbLayer(layer, (z, x, y) => new Promise((resolve, reject) => {
			// Self-heal: mint the session here too (cached), so 3D works even
			// if it activates before the 2D `add` minted it.
			const tok = _getStoredToken();
			if (!_vexcelTokenValid(tok)) { reject(new Error("Vexcel: no token")); return; }
			_ensureSession(tok, () => {
				const url = tileUrl(z, x, y);
				if (!url) { reject(new Error("Vexcel: no session")); return; }
				dwMbGmFetchAB(url, { headers: tileHeaders }).then(resolve, reject);
			});
		}));
		return layer;
	}
}
