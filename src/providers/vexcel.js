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

function _getStoredToken() {
	try { return GM_getValue(CFG.VEXCEL_TOKEN_KEY, "") || ""; }
	catch (_) { return ""; }
}

function _storeToken(t) {
	try { GM_setValue(CFG.VEXCEL_TOKEN_KEY, t); } catch (_) {}
}

function _promptForToken(lead) {
	const raw = window.prompt(
		(lead || "Vexcel Aerial needs a fresh token (they expire daily).") + "\n\n" +
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
				// Both bands (rgb + irg) so the viewer can offer an IR
				// toggle; parse buckets them by the image-name suffix.
				// image-center-distance-asc → the first image per cell is
				// the one whose frame is centred nearest the clicked point,
				// so the user's spot sits near the middle of the oblique.
				"order-by": "image-center-distance-asc",
				include: "collection,capture-date,product-type,image-name," +
					"source-layer,raster-size-width,raster-size-height,geometry",
			}),
			headers: { "Content-Type": "application/json" },
		},
		(err, data, raw) => {
			// 401/403 = token rejected server-side despite a valid expiry
			// (quota/revoked). Drop it so the UI prompts for a fresh one.
			if (raw && (raw.status === 401 || raw.status === 403)) {
				_storeToken(""); cb(null, "auth"); return;
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
	const token = _getStoredToken();
	if (!_vexcelTokenValid(token)) { cb(null); return; }
	gmJsonGet(
		CFG.VEXCEL_API_BASE + "/v2/oriented/query?token=" + encodeURIComponent(token),
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
			headers: { "Content-Type": "application/json" },
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
		"</div>" +
		'<button type="button" class="dw-vex-ir" title="Toggle near-infrared (vegetation shows red)">IR</button>';
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
		// Default to the straight-down nadir (⊙) — it matches the flat
		// basemap orientation, so entering the dated viewer feels like
		// "the same view, but through time". Falls back to an oblique
		// angle on dates/areas without nadir (SCC: nadir is 2025 only).
		dir: "nadir",
		band: "rgb",     // "rgb" | "irg" (near-infrared)
		capIdx: 0,       // index into model.captures (0 = newest)
		gen: 0,
		on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return ctl; },
		off(ev, fn) { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn); return ctl; },
		_fire(ev) { for (const f of listeners[ev] || []) { try { f(); } catch (_) {} } },
	};
	const mapEl   = overlay.querySelector(".dw-vex-tilemap");
	const msgEl   = overlay.querySelector(".dw-vex-msg");
	const dirBtns = [...el.querySelectorAll(".dw-vex-dir")];
	const irBtn   = el.querySelector(".dw-vex-ir");

	// Cell {rgb?, irg?} for a direction at the current date; the image
	// for the active band (falling back to rgb).
	const cellFor = (dir) => {
		const cap = ctl.model && ctl.model.captures[ctl.capIdx];
		return cap ? ctl.model.images[dir + "@" + cap.collection] : null;
	};
	const curImage = () => {
		const cell = cellFor(ctl.dir);
		return cell ? (cell[ctl.band] || cell.rgb) : null;
	};
	const irAvail = () => {
		const cell = cellFor(ctl.dir);
		return !!(cell && cell.irg);
	};

	// setMsg opens the overlay; fire "overlaytoggle" on the closed→open
	// transition so the app can show the date bar (which only makes sense
	// while an oblique is up — the flat basemap is date-locked).
	const setMsg = (t) => {
		const wasClosed = overlay.style.display === "none";
		overlay.style.display = "";
		msgEl.textContent = t;
		msgEl.style.display = t ? "" : "none";
		if (wasClosed) ctl._fire("overlaytoggle");
	};
	ctl.isOverlayOpen = () => overlay.style.display !== "none";

	// Which directions actually have a photo at the current capture date.
	// N/E/S/W exist every flown year; nadir (⊙) only some (SCC: 2025), so
	// ⊙ is disabled on years without it rather than dead-ending in a "no
	// photo" message.
	const dirHasPhoto = (dir) => {
		const cell = cellFor(dir);
		return !!(cell && (cell.rgb || cell.irg));
	};
	const availDirs = () => {
		if (!ctl.model) return [];
		return ctl.model.directions.filter((d) => dirHasPhoto(d.key));
	};
	// Reflect the IR toggle state: highlighted when active, greyed when
	// the current direction+date has no infrared band (SCC: nadir 2025
	// only). Auto-reverts to rgb if IR isn't available here.
	const updateIrBtn = () => {
		if (!irBtn) return;
		const avail = irAvail();
		if (!avail && ctl.band === "irg") ctl.band = "rgb";
		irBtn.disabled = !avail;
		irBtn.classList.toggle("dw-vex-dir--off", !avail);
		irBtn.classList.toggle("dw-vex-ir--on", ctl.band === "irg" && avail);
	};
	// Highlight the active direction ONLY while an oblique is open (on the
	// flat basemap no angle is "selected"); grey out any with no photo for
	// the current date so ⊙ can't dead-end on a year it wasn't flown.
	const markActiveDir = () => {
		dirBtns.forEach((b) => {
			const has = dirHasPhoto(b.dataset.dir);
			b.classList.toggle("dw-vex-dir--on",
				ctl.isOverlayOpen() && b.dataset.dir === ctl.dir && has);
			b.classList.toggle("dw-vex-dir--off", !!ctl.model && !has);
			b.disabled = !!ctl.model && !has;
		});
		updateIrBtn();
	};

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
		// Continuous panning: settle → maybe switch to the adjacent frame.
		ctl._imgMap.on("moveend", onInnerMove);
		return ctl._imgMap;
	};

	const dropTiles = () => {
		if (ctl._tileLayer && ctl._imgMap) {
			ctl._imgMap.removeLayer(ctl._tileLayer);
			ctl._tileLayer = null;
		}
	};

	ctl._frame = null;       // { name, layer, w, h, corners, collection, maxZ }
	ctl._suppressMove = false;

	// Render one oblique frame as a fresh tile pyramid. opts.center =
	// [lng,lat] to keep that ground point centred (used when panning
	// switches to a neighbouring frame); otherwise open zoomed-in on the
	// frame centre.
	const loadFrame = (frame, opts) => {
		opts = opts || {};
		const base = _vexcelObliqueTileBase(
			frame.name, frame.layer, _getStoredToken());
		if (!base) { setMsg("Vexcel token expired — reselect the base to refresh it."); return; }
		setMsg(""); // opens the overlay (fires overlaytoggle) + hides msg
		const w = frame.w || 10560, h = frame.h || 14144;

		// Zoomify-style pyramid: level 0 = coarsest (~1 tile), maxZoom =
		// native. gridSize[z] bounds the valid tile grid per level.
		const TS = 256;
		const sizes = [];
		let s = L.point(w, h);
		sizes.push(s);
		while (s.x > TS || s.y > TS) { s = s.divideBy(2).ceil(); sizes.push(s); }
		sizes.reverse();
		const maxZ = sizes.length - 1;
		const grids = sizes.map((p) =>
			L.point(Math.ceil(p.x / TS), Math.ceil(p.y / TS)));

		const map = ensureImgMap();
		map.setMinZoom(0);
		map.setMaxZoom(maxZ);
		map.invalidateSize();

		dropTiles();
		const TileCls = L.TileLayer.extend({
			getTileUrl(coords) {
				const ds = maxZ - coords.z; // 0 = native, maxZ = coarsest
				return base + "&downsample=" + ds +
					"&tile-x=" + coords.x + "&tile-y=" + coords.y;
			},
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

		// Image pixels [0..w]×[0..h] at native zoom; CRS.Simple flips y
		// so SW=(0,h), NE=(w,0).
		const bounds = L.latLngBounds(
			map.unproject([0, h], maxZ), map.unproject([w, 0], maxZ));
		map.setMaxBounds(bounds.pad(0.1));

		ctl._frame = Object.assign({ collection: frame.collection, maxZ, w, h }, frame);

		// View: keep the panned-to ground point centred when switching
		// frames (so the pan feels continuous); else open zoomed-in on
		// the frame centre.
		const keepZ = opts.keepZoom && map.getZoom();
		let center = bounds.getCenter(), z;
		if (opts.center && frame.corners) {
			const [u, v] = _vexcelInvBilinear(frame.corners, opts.center[0], opts.center[1]);
			center = map.unproject([u * w, v * h], maxZ);
			z = keepZ || Math.min(maxZ, Math.max(map.getBoundsZoom(bounds, false), maxZ - 1));
		} else {
			z = Math.min(maxZ, Math.max(map.getBoundsZoom(bounds, false), maxZ - 1));
		}
		// Arm one skip: the programmatic setView below fires a moveend we
		// must ignore (else it re-queries and can loop). onInnerMove clears
		// the flag on that first moveend; real pans then flow through.
		ctl._suppressMove = true;
		map.setView(center, z, { animate: false });
		markActiveDir();
	};

	// Show the currently-selected direction+date+band as an oblique frame.
	const load = () => {
		if (!ctl.model) return;
		const cap = ctl.model.captures[ctl.capIdx];
		const img = curImage();
		if (!img) {
			dropTiles();
			setMsg("No " + _dirLabel(ctl.dir) + " photo for " + (cap ? cap.date : "this date") + " here.");
			ctl._frame = null;
			return;
		}
		loadFrame(Object.assign({ collection: cap.collection }, img));
	};

	// Continuous panning: when the inner view settles, map its centre
	// pixel → ground via the frame footprint and pull the frame best
	// centred there. If it's a NEIGHBOUR, switch to it (keeping the
	// ground point centred) so you can scroll across the whole survey.
	let panTimer = null;
	const onInnerMove = () => {
		if (ctl._suppressMove) { ctl._suppressMove = false; return; } // skip the programmatic setView
		const f = ctl._frame;
		if (!f || !f.corners || !ctl.model) return;
		clearTimeout(panTimer);
		panTimer = setTimeout(() => {
			const map = ctl._imgMap;
			if (!map || !ctl.isOverlayOpen()) return;
			const pt = map.project(map.getCenter(), f.maxZ);
			const u = Math.max(0, Math.min(1, pt.x / f.w));
			const v = Math.max(0, Math.min(1, pt.y / f.h));
			const ground = _vexcelBilinear(f.corners, u, v);
			const cap = ctl.model.captures[ctl.capIdx];
			if (!cap) return;
			fetchVexcelFrame(ground[0], ground[1], cap.collection, ctl.dir, ctl.band, (fr) => {
				if (!fr || !fr.name || !ctl.isOverlayOpen()) return;
				if (fr.name === f.name) return;            // same frame — nothing to do
				loadFrame(Object.assign({ collection: cap.collection }, fr),
					{ center: ground, keepZoom: true });
			});
		}, 300);
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
		fetchVexcelObliques(ctl.lat, ctl.lng, (model, reason) => {
			if (gen !== ctl.gen && model == null) { /* keep prior on stale */ }
			ctl.model = model || null;
			if (reason === "auth") {
				// Token was refused (cleared by the fetch). The basemap's
				// tile-error handler prompts for a fresh one; here just
				// reflect it if the oblique overlay is open.
				ctl._fire("capturechange");
				if (ctl.isOverlayOpen()) setMsg("Vexcel token was refused — reselect the base to paste a fresh one.");
				return;
			}
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
		if (b.disabled) return; // greyed — no photo for this date
		if (!_vexcelTokenValid(_getStoredToken())) { setMsg("Paste a Vexcel token (reselect the base) to load imagery."); return; }
		if (!ctl.model) { setMsg("No Vexcel oblique here — recentre over a flown area."); return; }
		ctl.dir = b.dataset.dir;
		markActiveDir();
		load();
	}));
	// IR toggle: swap the active band (rgb ⇄ near-infrared) and reload the
	// current view. Only enabled where an IR band exists (SCC: nadir 2025).
	if (irBtn) irBtn.addEventListener("click", () => {
		if (irBtn.disabled || !irAvail()) return;
		ctl.band = ctl.band === "irg" ? "rgb" : "irg";
		updateIrBtn();
		if (ctl.isOverlayOpen()) load();
	});
	overlay.querySelector(".dw-vex-close").addEventListener("click", () => {
		overlay.style.display = "none";  // back to the live map
		ctl.gen++;
		markActiveDir();            // clear the highlight (no oblique open)
		ctl._fire("overlaytoggle"); // hide the date bar with the oblique
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
		if (!ctl.model) return;
		// The chosen date may not have the current direction (e.g. ⊙
		// nadir on a pre-2025 year) — fall back to an available angle so
		// scrubbing always shows imagery rather than a dead "no photo".
		if (!dirHasPhoto(ctl.dir)) {
			const avail = availDirs();
			if (avail.length) ctl.dir = avail[0].key;
		}
		markActiveDir();
		// Scrubbing a date shows that date's imagery — open the oblique
		// even from the basemap (whose own tiles are date-locked).
		load();
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
		// A rejected token (403 quota/revoked) still passes the JWT-expiry
		// check, so the basemap would silently blank forever. A BURST of
		// tile errors (whole view failing, not the odd out-of-coverage
		// 404) means the token was refused — clear it and prompt for a
		// fresh one, then repaint. Guarded so it prompts once per burst.
		// Tiles are `<img>` loads whose only URL that ever 403s is the
		// real WMTS one (the no-token fallback is a blank data URI that
		// never errors), so a burst of tile errors ⇒ the token was
		// refused. (The oblique query may have already cleared it, so we
		// do NOT gate on token validity here.)
		let errBurst = 0, errTimer = null;
		layer.on("tileerror", () => {
			if (!layer._map || layer._dwReprompt) return;
			errBurst++;
			clearTimeout(errTimer);
			errTimer = setTimeout(() => { errBurst = 0; }, 3000);
			if (errBurst < 8) return;
			errBurst = 0;
			layer._dwReprompt = true;
			_storeToken(""); // drop the rejected token
			const tok = _promptForToken(
				"Vexcel refused the current token (expired or usage limit). Paste a fresh one:");
			layer._dwReprompt = false;
			if (_vexcelTokenValid(tok)) {
				layer.setUrl(_vexcelTileTpl(tok));
				layer.redraw();
				if (_vexCtl) { _vexCtl.atKey = ""; } // force a re-query
			} else {
				// Cancelled / still bad — stop hammering the dead token
				// (blank data URIs don't error, so no more prompts).
				layer.setUrl(BLANK_TILE);
			}
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
