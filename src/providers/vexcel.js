import { BLANK_TILE, CFG } from "../config.js";
import { LayerProvider } from "../layers/provider-factories.js";
import { gmGet, gmJsonGet } from "../utils/http.js";
import { _escHtml } from "../utils/html.js";

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
 *   POST /v2/oriented/query  → every (direction × capture) at a point
 *   GET  /v2/oriented/extract?image-name=… → the stitched oblique JPEG
 * So directional N/E/S/W views AND date selection live here, mirroring
 * the Vexcel viewer's oblique panel. extract is heavy (~25 MB) and
 * rate-limited, so this is an on-demand inspector, not a tile layer.
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
// images is keyed "<product-type>@<collection>" → first (best) image
// name; captures is the sorted-desc distinct collection list; the same
// point yields many candidate photos per cell, we keep the first (the
// API returns them best-first).
export function _vexcelParseObliques(data) {
	const images = {};
	const captureSet = new Map(); // collection → year
	const dirSet = new Set();
	for (const f of (data && Array.isArray(data.features) ? data.features : [])) {
		const p = f.properties || {};
		const dir = p["product-type"];
		const coll = p.collection;
		const name = p["image-name"];
		if (!dir || !coll || !name) continue;
		const key = dir + "@" + coll;
		if (!(key in images)) images[key] = name;
		captureSet.set(coll, _vexcelCollectionYear(coll));
		dirSet.add(dir);
	}
	const captures = [...captureSet.entries()]
		.map(([collection, year]) => ({ collection, year }))
		.sort((a, b) => b.year.localeCompare(a.year));
	const directions = VEXCEL_DIRECTIONS.filter((d) => dirSet.has(d.key));
	return { images, captures, directions };
}

export function _vexcelObliqueExtractUrl(imageName, lat, lng, token) {
	if (!imageName || !_vexcelTokenValid(token)) return "";
	const wkt = `POINT(${Number(lng)} ${Number(lat)})`;
	return (
		CFG.VEXCEL_API_BASE + "/v2/oriented/extract?" +
		"wkt=" + encodeURIComponent(wkt) +
		"&srid=4326&layer=urban" +
		"&image-name=" + encodeURIComponent(imageName) +
		"&token=" + encodeURIComponent(token)
	);
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
				layer: "urban",
				include: "collection,capture-date,product-type,image-name",
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

/* -- Oblique viewer overlay -------------------------------------------
 * A floating panel (like the SCC submenu) opened by clicking the map
 * while the Vexcel base is active. Shows N/E/S/W/Top direction buttons
 * and a capture-year dropdown; picking a cell pulls that stitched
 * oblique via extract and shows it. One viewer instance, reused.
 */
let _vexView = null;

function _vexObliqueViewer(map) {
	if (_vexView) return _vexView;
	const el = document.createElement("div");
	el.className = "dw-vex-viewer";
	el.style.display = "none";
	el.innerHTML =
		'<div class="dw-vex-hd">' +
		'<span class="dw-vex-title">Vexcel oblique</span>' +
		'<button type="button" class="dw-vex-close" aria-label="Close">×</button>' +
		"</div>" +
		'<div class="dw-vex-controls">' +
		'<div class="dw-vex-dirs"></div>' +
		'<select class="dw-vex-dates"></select>' +
		"</div>" +
		'<div class="dw-vex-stage"><div class="dw-vex-msg">Click the map to load an oblique.</div>' +
		'<img class="dw-vex-img" alt="Vexcel oblique view" style="display:none">' +
		"</div>";
	L.DomEvent.disableClickPropagation(el);
	L.DomEvent.disableScrollPropagation(el);
	map.getContainer().appendChild(el);

	const view = {
		el,
		lat: 0, lng: 0,
		model: null,
		dir: "oblique-north",
		collection: "",
		gen: 0,
		imgObjUrl: "",
	};

	const dirsEl  = el.querySelector(".dw-vex-dirs");
	const datesEl = el.querySelector(".dw-vex-dates");
	const imgEl   = el.querySelector(".dw-vex-img");
	const msgEl   = el.querySelector(".dw-vex-msg");

	const revoke = () => {
		if (view.imgObjUrl) { try { URL.revokeObjectURL(view.imgObjUrl); } catch (_) {} view.imgObjUrl = ""; }
	};
	const setMsg = (t) => {
		msgEl.textContent = t;
		msgEl.style.display = t ? "" : "none";
		imgEl.style.display = t ? "none" : "";
	};

	const load = () => {
		const name = view.model &&
			view.model.images[view.dir + "@" + view.collection];
		if (!name) { setMsg("No " + _dirLabel(view.dir) + " image for this capture."); return; }
		const token = _getStoredToken();
		const url = _vexcelObliqueExtractUrl(name, view.lat, view.lng, token);
		if (!url) { setMsg("Token expired — reselect the Vexcel base to refresh."); return; }
		const gen = ++view.gen;
		setMsg("Loading oblique… (large image, may take a moment)");
		// extract can 429 (heavy stitch) — GM fetch as a blob so we can
		// surface a friendly rate-limit message instead of a broken img.
		gmGet(url, { responseType: "blob", timeout: 90000 }, (err, r) => {
			if (gen !== view.gen) return; // superseded by a newer pick
			if (err || !r || r.status < 200 || r.status >= 300) {
				setMsg(r && r.status === 429
					? "Vexcel is rate-limiting oblique pulls — wait a moment and retry."
					: "Couldn't load this oblique.");
				return;
			}
			revoke();
			view.imgObjUrl = URL.createObjectURL(r.response);
			imgEl.onload = () => { if (gen === view.gen) setMsg(""); };
			imgEl.src = view.imgObjUrl;
		});
	};

	const renderControls = () => {
		dirsEl.innerHTML = "";
		for (const d of view.model.directions) {
			const b = document.createElement("button");
			b.type = "button";
			b.className = "dw-vex-dir" + (d.key === view.dir ? " dw-vex-dir--on" : "");
			b.textContent = d.label;
			b.addEventListener("click", () => {
				view.dir = d.key;
				renderControls();
				load();
			});
			dirsEl.appendChild(b);
		}
		datesEl.innerHTML = "";
		for (const c of view.model.captures) {
			const o = document.createElement("option");
			o.value = c.collection;
			o.textContent = c.year;
			if (c.collection === view.collection) o.selected = true;
			datesEl.appendChild(o);
		}
	};

	datesEl.addEventListener("change", () => {
		view.collection = datesEl.value;
		load();
	});
	el.querySelector(".dw-vex-close").addEventListener("click", () => {
		el.style.display = "none";
		view.gen++;
		revoke();
	});

	view.open = (lat, lng) => {
		view.lat = lat; view.lng = lng;
		el.style.display = "";
		setMsg("Finding captures…");
		dirsEl.innerHTML = ""; datesEl.innerHTML = "";
		const gen = ++view.gen;
		fetchVexcelObliques(lat, lng, (model) => {
			if (gen !== view.gen) return;
			if (!model) { setMsg("No Vexcel oblique imagery here."); return; }
			view.model = model;
			// Keep the current direction if still available, else first.
			if (!model.directions.some((d) => d.key === view.dir)) {
				view.dir = model.directions[0].key;
			}
			view.collection = model.captures[0].collection;
			renderControls();
			load();
		});
	};
	_vexView = view;
	return view;
}

function _dirLabel(key) {
	const d = VEXCEL_DIRECTIONS.find((x) => x.key === key);
	return d ? d.label : key;
}

// Entry point for the location popup's "Oblique views" button — opens
// the floating viewer at the clicked point. (We don't hook map clicks
// directly: that would fight the site's waypoint-drop.)
export function openVexcelObliques(map, lat, lng) {
	_vexObliqueViewer(map).open(lat, lng);
}

// True when a fresh-enough token exists to bother offering the oblique
// button in the popup.
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
		layer.on("add", () => {
			let tok = _getStoredToken();
			if (!_vexcelTokenValid(tok)) tok = _promptForToken();
			if (!_vexcelTokenValid(tok)) return; // stays blank until re-add
			const tpl = _vexcelTileTpl(tok);
			if (layer._url !== tpl) layer.setUrl(tpl);
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
