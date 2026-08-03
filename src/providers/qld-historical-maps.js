import { CFG } from "../config.js";
import { arcgisExportProvider } from "../layers/provider-factories.js";
import { arcgisIdentify } from "../layers/hover-identify.js";
import { _escHtml, esc } from "../utils/html.js";

/* -- QLD Historical printed map sheets --------------------------------
 * An index overlay of every historical printed map sheet (parish, town,
 * topographic, exploration, …) from QLD's HistoricalPrintedMapExtents.
 * Clicking the map lists the sheets covering that point — each with a
 * link to the scanned image — and an "Overlay" action that superimposes
 * the scan on the live map with four draggable corners so it can be
 * rubber-sheeted into alignment (a shaft on an 1909 6-chain goldfield
 * sheet drops onto its real-world spot).
 */

/* -- Homography: map an image rectangle onto a dragged quad -----------
 * Standard 4-point projective transform expressed as a CSS matrix3d, so
 * an <img> can be perspective-warped purely in the compositor. Source is
 * the image's own pixel rectangle; destination is the four corner points
 * (in map layer-pixel space). transform-origin must be 0 0.
 */
function _adj(m) { // adjugate of a 3x3 (row-major)
	return [
		m[4] * m[8] - m[5] * m[7], m[2] * m[7] - m[1] * m[8], m[1] * m[5] - m[2] * m[4],
		m[5] * m[6] - m[3] * m[8], m[0] * m[8] - m[2] * m[6], m[2] * m[3] - m[0] * m[5],
		m[3] * m[7] - m[4] * m[6], m[1] * m[6] - m[0] * m[7], m[0] * m[4] - m[1] * m[3],
	];
}
function _multmm(a, b) {
	const r = [];
	for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
		let s = 0;
		for (let k = 0; k < 3; k++) s += a[3 * i + k] * b[3 * k + j];
		r[3 * i + j] = s;
	}
	return r;
}
function _multmv(m, v) {
	return [
		m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
		m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
		m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
	];
}
function _basisToPoints(p) { // p = [[x,y]×4]
	const m = [p[0][0], p[1][0], p[2][0], p[0][1], p[1][1], p[2][1], 1, 1, 1];
	const v = _multmv(_adj(m), [p[3][0], p[3][1], 1]);
	return _multmm(m, [v[0], 0, 0, 0, v[1], 0, 0, 0, v[2]]);
}
function _general2DProjection(src, dst) {
	return _multmm(_basisToPoints(dst), _adj(_basisToPoints(src)));
}

// Build the CSS matrix3d string mapping an (w×h) image onto dst corners
// (order TL,TR,BR,BL, in pixels). dst==image-rect → identity.
export function _quadToMatrix3d(w, h, dst) {
	const src = [[0, 0], [w, 0], [w, h], [0, h]];
	const t = _general2DProjection(src, dst);
	for (let i = 0; i < 9; i++) t[i] = t[i] / t[8];
	const m = [
		t[0], t[3], 0, t[6],
		t[1], t[4], 0, t[7],
		0, 0, 1, 0,
		t[2], t[5], 0, t[8],
	];
	return "matrix3d(" + m.join(",") + ")";
}

/* -- Distortable image overlay ---------------------------------------- */

const OVERLAY_PANE = "dwHistMapPane";
let _activeOverlay = null; // only one warped sheet at a time

// Superimpose `url` on the map, initially filling the geographic bbox
// [[N,W],[N,E],[S,E],[S,W]] (TL,TR,BR,BL), with draggable corners.
export function makeDistortableMapOverlay(map, opts) {
	if (_activeOverlay) _activeOverlay.remove();

	if (!map.getPane(OVERLAY_PANE)) {
		map.createPane(OVERLAY_PANE);
		map.getPane(OVERLAY_PANE).style.zIndex = "350";
	}
	const pane = map.getPane(OVERLAY_PANE);
	pane.style.pointerEvents = "none";

	const img = document.createElement("img");
	img.className = "dw-histmap-img";
	img.alt = opts.title || "historical map";
	img.style.cssText =
		"position:absolute;left:0;top:0;transform-origin:0 0;" +
		"pointer-events:none;will-change:transform;max-width:none;";
	img.style.opacity = "0.7";
	pane.appendChild(img);

	const handleIcon = L.divIcon({ className: "dw-histmap-handle", iconSize: [16, 16] });
	const corners = opts.corners.map((c) =>
		L.marker(c, { draggable: true, icon: handleIcon, zIndexOffset: 2000 }).addTo(map));

	let W = 0, H = 0;
	const update = () => {
		if (!W || !H) return;
		const p = corners.map((m) => map.latLngToLayerPoint(m.getLatLng()));
		img.style.transform =
			_quadToMatrix3d(W, H, [[p[0].x, p[0].y], [p[1].x, p[1].y], [p[2].x, p[2].y], [p[3].x, p[3].y]]);
	};
	img.addEventListener("load", () => {
		W = img.naturalWidth; H = img.naturalHeight;
		img.style.width = W + "px"; img.style.height = H + "px";
		update();
	});
	img.addEventListener("error", () => setMsg("Couldn't load the map scan."));
	img.src = opts.url;

	corners.forEach((m) => m.on("drag", update));
	const onMove = () => update();
	map.on("move zoom viewreset zoomend moveend", onMove);

	// Floating control: opacity, fit-to-bbox, remove.
	const ctl = L.DomUtil.create("div", "dw-histmap-ctl");
	ctl.innerHTML =
		`<div class="dw-histmap-ttl">${_escHtml((opts.title || "Historical map").slice(0, 60))}</div>` +
		`<label>Opacity <input type="range" class="dw-histmap-op" min="0" max="1" step="0.05" value="0.7"></label>` +
		`<div class="dw-histmap-msg"></div>` +
		`<div class="dw-histmap-btns">` +
		`<button type="button" class="dw-histmap-fit">Reset corners</button>` +
		`<button type="button" class="dw-histmap-del">Remove</button></div>`;
	map.getContainer().appendChild(ctl);
	L.DomEvent.disableClickPropagation(ctl);
	L.DomEvent.disableScrollPropagation(ctl);
	const msgEl = ctl.querySelector(".dw-histmap-msg");
	const setMsg = (t) => { if (msgEl) msgEl.textContent = t || ""; };

	ctl.querySelector(".dw-histmap-op").addEventListener("input", (e) => {
		img.style.opacity = e.target.value;
	});
	ctl.querySelector(".dw-histmap-fit").addEventListener("click", () => {
		corners.forEach((m, i) => m.setLatLng(opts.corners[i]));
		update();
	});

	const handle = {
		remove() {
			map.off("move zoom viewreset zoomend moveend", onMove);
			corners.forEach((m) => m.remove());
			if (img.parentNode) img.remove();
			if (ctl.parentNode) ctl.remove();
			if (_activeOverlay === handle) _activeOverlay = null;
		},
	};
	ctl.querySelector(".dw-histmap-del").addEventListener("click", () => handle.remove());
	_activeOverlay = handle;
	return handle;
}

/* -- Index overlay + click popup -------------------------------------- */

// Read an aliased-or-raw identify attribute.
function _pick(a, keys) {
	for (const k of keys) {
		const v = a[k];
		if (v !== null && v !== undefined && String(v).trim() && String(v).trim().toLowerCase() !== "null") {
			return String(v).trim();
		}
	}
	return "";
}

function _yearOf(v) {
	const m = String(v || "").match(/\b(1[6-9]\d\d|20\d\d)\b/);
	return m ? m[1] : "";
}

// Model each identify result into the fields the popup + overlay need.
export function _histMapSheet(attrs) {
	const a = attrs || {};
	const title = _pick(a, ["Title", "title"]) || "Untitled sheet";
	const year = _yearOf(_pick(a, ["Publication date", "publication_date"]));
	const scale = _pick(a, ["Map scale", "map_scale"]);
	const link = _pick(a, ["Download link", "download_link"]);
	const preview = _pick(a, ["Map preview", "map_preview"]);
	const w = parseFloat(_pick(a, ["Bounding box west longitude", "boundingboxwestlongitude"]));
	const e = parseFloat(_pick(a, ["Bounding box east longitude", "boundingboxeastlongitude"]));
	const n = parseFloat(_pick(a, ["Bounding box north latitude", "boundingboxnorthlatitude"]));
	const s = parseFloat(_pick(a, ["Bounding box south latitude", "boundingboxsouthlatitude"]));
	const bbox = [w, s, e, n].every(Number.isFinite) ? { w, s, e, n } : null;
	return { title, year, scale, link, preview, bbox };
}

// Build the "historical maps here" popup section. Only sheets with both a
// scan link and a bbox get an Overlay button; scan link alone gets Open.
export function _histMapsSectionHtml(sheets) {
	const usable = sheets.filter((m) => m.link);
	if (!usable.length) return "";
	const rows = usable.slice(0, 30).map((m) => {
		const meta = [m.year, m.scale ? "1:" + m.scale : ""].filter(Boolean).join(" · ");
		const bboxAttr = m.bbox
			? ` data-w="${m.bbox.w}" data-s="${m.bbox.s}" data-e="${m.bbox.e}" data-n="${m.bbox.n}"`
			: "";
		const overlayBtn = m.bbox
			? `<a href="#" class="dw-histmap-overlay-link" data-url="${_escHtml(m.link)}"${bboxAttr} data-title="${_escHtml(m.title)}">Overlay ▦</a>`
			: "";
		return (
			`<div class="dw-histmap-row">` +
			`<div class="dw-histmap-row-t">${esc`<b>${m.title}</b>`}` +
			(meta ? esc` <span class="dw-cad-sub">${meta}</span>` : "") + `</div>` +
			`<div class="dw-histmap-row-a">` +
			`<a href="${_escHtml(m.link)}" target="_blank" rel="noreferrer">Open scan ↗</a>` +
			(overlayBtn ? " &nbsp; " + overlayBtn : "") + `</div></div>`
		);
	});
	return `<div class="dw-histmap-list"><div class="dw-histmap-hd">Historical map sheets here (${usable.length})</div>${rows.join("")}</div>`;
}

// Identify every index sublayer at a point → sheet models (link + bbox
// first, newest first).
export function fetchHistMapSheets(map, latlng, cb) {
	arcgisIdentify(map, latlng, {
		baseUrl: CFG.QLD_HIST_MAPS_SERVICE,
		layers: "all:" + CFG.QLD_HIST_MAPS_LAYER_IDS,
		tolerance: 1,
	}, (err, _feat, raw) => {
		// arcgisIdentify returns only the first result; re-read all from raw.
		const results = (raw && raw.results) || [];
		const sheets = results.map((r) => _histMapSheet(r.attributes || {}))
			.filter((m) => m.link);
		sheets.sort((a, b) => Number(b.year || 0) - Number(a.year || 0));
		cb(sheets);
	});
}

// One-time delegated handler: clicking an "Overlay ▦" link warps that
// scan onto the map.
let _histMapHookInstalled = false;
export function _ensureHistMapHook(map) {
	if (_histMapHookInstalled) return;
	_histMapHookInstalled = true;
	document.addEventListener("click", (e) => {
		const a = e.target && e.target.closest && e.target.closest(".dw-histmap-overlay-link");
		if (!a) return;
		e.preventDefault();
		e.stopPropagation();
		const n = parseFloat(a.dataset.n), s = parseFloat(a.dataset.s);
		const w = parseFloat(a.dataset.w), ea = parseFloat(a.dataset.e);
		if (![n, s, w, ea].every(Number.isFinite) || !a.dataset.url) return;
		makeDistortableMapOverlay(map, {
			url: a.dataset.url,
			title: a.dataset.title || "",
			corners: [[n, w], [n, ea], [s, ea], [s, w]], // TL,TR,BR,BL
		});
	}, true);
}

export const HistoricalMapsIndexProvider = arcgisExportProvider({
	baseUrl: CFG.QLD_HIST_MAPS_SERVICE,
	showLayers: CFG.QLD_HIST_MAPS_LAYER_IDS,
	pane: "dwHistMapIndexPane", paneZIndex: 388,
	opacity: 0.7, minZoom: 9, maxZoom: 25,
	attribution:
		'Historical maps &copy; <a href="https://www.data.qld.gov.au/" ' +
		'target="_blank" rel="noreferrer">State of Queensland (Resources)</a>',
	onAdd: (layer, map) => _ensureHistMapHook(map),
});
