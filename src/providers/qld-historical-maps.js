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

// 2D affine mapping a source triangle onto a destination triangle. Given
// src/dst = [[x,y]×3], returns [a,b,c,d,e,f] for CSS matrix(a,b,c,d,e,f):
//   X = a·x + c·y + e ,  Y = b·x + d·y + f
// Solved by Cramer's rule on the source basis; underpins the control-point
// mesh (each triangle warps independently so interior points bend the map).
export function _triAffine(s, d) {
	const x0 = s[0][0], y0 = s[0][1], x1 = s[1][0], y1 = s[1][1], x2 = s[2][0], y2 = s[2][1];
	const det = x0 * (y1 - y2) - x1 * (y0 - y2) + x2 * (y0 - y1);
	if (!det) return [1, 0, 0, 1, 0, 0];
	const X0 = d[0][0], X1 = d[1][0], X2 = d[2][0], Y0 = d[0][1], Y1 = d[1][1], Y2 = d[2][1];
	const a = (X0 * (y1 - y2) + X1 * (y2 - y0) + X2 * (y0 - y1)) / det;
	const c = (X0 * (x2 - x1) + X1 * (x0 - x2) + X2 * (x1 - x0)) / det;
	const e = (X0 * (x1 * y2 - x2 * y1) + X1 * (x2 * y0 - x0 * y2) + X2 * (x0 * y1 - x1 * y0)) / det;
	const b = (Y0 * (y1 - y2) + Y1 * (y2 - y0) + Y2 * (y0 - y1)) / det;
	const dd = (Y0 * (x2 - x1) + Y1 * (x0 - x2) + Y2 * (x1 - x0)) / det;
	const f = (Y0 * (x1 * y2 - x2 * y1) + Y1 * (x2 * y0 - x0 * y2) + Y2 * (x0 * y1 - x1 * y0)) / det;
	return [a, b, c, dd, e, f];
}

/* -- Distortable image overlay (control-point mesh) -------------------
 * A single 4-corner homography can only correct perspective/skew. Old map
 * scans carry local, non-linear distortion (paper shrinkage, projection),
 * so the sheet is warped through a 3×3 lattice of draggable control points
 * — corners PLUS edge-midpoints and centre. The image is split into 8
 * triangles; each is background-clipped to its source triangle and given
 * its own affine transform, so dragging any point bends the map locally
 * while triangles stay joined at shared vertices.
 */

const OVERLAY_PANE = "dwHistMapPane";
const _GRID = 2;                                  // 2×2 cells → 3×3 points, 8 triangles
const _CORNER_IDX = new Set([0, 2, 6, 8]);        // lattice corners (bigger handles)
let _activeOverlay = null;                        // only one warped sheet at a time

// Superimpose `url` on the map, initially filling the geographic bbox
// corners [[N,W],[N,E],[S,E],[S,W]] (TL,TR,BR,BL), with a draggable mesh.
export function makeDistortableMapOverlay(map, opts) {
	if (_activeOverlay) _activeOverlay.remove();

	if (!map.getPane(OVERLAY_PANE)) {
		map.createPane(OVERLAY_PANE);
		map.getPane(OVERLAY_PANE).style.zIndex = "350";
	}
	const pane = map.getPane(OVERLAY_PANE);
	pane.style.pointerEvents = "none";

	const wrap = L.DomUtil.create("div", "dw-histmap-warp", pane);
	wrap.style.cssText = "position:absolute;left:0;top:0;transform-origin:0 0;opacity:0.7;";

	// 3×3 control-point lattice, bilinear-interpolated from the 4 corners.
	const [NW, NE, SE, SW] = opts.corners;
	const gridLL = [];
	for (let r = 0; r <= _GRID; r++) for (let cc = 0; cc <= _GRID; cc++) {
		const u = cc / _GRID, v = r / _GRID;
		const tLat = NW[0] + (NE[0] - NW[0]) * u, tLng = NW[1] + (NE[1] - NW[1]) * u;
		const bLat = SW[0] + (SE[0] - SW[0]) * u, bLng = SW[1] + (SE[1] - SW[1]) * u;
		gridLL.push([tLat + (bLat - tLat) * v, tLng + (bLng - tLng) * v]);
	}
	const cornerIcon = L.divIcon({ className: "dw-histmap-handle", iconSize: [16, 16] });
	const midIcon = L.divIcon({ className: "dw-histmap-handle dw-histmap-handle--mid", iconSize: [14, 14] });
	const markers = gridLL.map((ll, i) =>
		L.marker(ll, {
			draggable: true, zIndexOffset: 2000,
			icon: _CORNER_IDX.has(i) ? cornerIcon : midIcon,
		}).addTo(map));

	// Two triangles per cell (indices into the row-major 3×3 lattice).
	const tris = [];
	for (let r = 0; r < _GRID; r++) for (let cc = 0; cc < _GRID; cc++) {
		const tl = r * (_GRID + 1) + cc, tr = tl + 1, bl = tl + (_GRID + 1), br = bl + 1;
		tris.push([tl, tr, br], [tl, br, bl]);
	}

	let W = 0, H = 0, srcPts = [];
	const triDivs = [];
	// Grow each clip triangle slightly toward its edges so neighbours overlap
	// by ~1px and no anti-aliased hairline seam shows between them.
	const dilate = (t, px) => {
		const cx = (t[0][0] + t[1][0] + t[2][0]) / 3, cy = (t[0][1] + t[1][1] + t[2][1]) / 3;
		return t.map(([x, y]) => { const dx = x - cx, dy = y - cy, l = Math.hypot(dx, dy) || 1; return [x + dx / l * px, y + dy / l * px]; });
	};
	const buildTris = () => {
		srcPts = [];
		for (let r = 0; r <= _GRID; r++) for (let cc = 0; cc <= _GRID; cc++) srcPts.push([cc / _GRID * W, r / _GRID * H]);
		tris.forEach((t) => {
			const div = L.DomUtil.create("div", "dw-histmap-tri", wrap);
			div.style.cssText =
				`position:absolute;left:0;top:0;width:${W}px;height:${H}px;transform-origin:0 0;` +
				`background-image:url("${opts.url}");background-size:${W}px ${H}px;background-repeat:no-repeat;`;
			const s = dilate([srcPts[t[0]], srcPts[t[1]], srcPts[t[2]]], 1);
			div.style.clipPath = `polygon(${s[0][0]}px ${s[0][1]}px, ${s[1][0]}px ${s[1][1]}px, ${s[2][0]}px ${s[2][1]}px)`;
			triDivs.push(div);
		});
	};
	const update = () => {
		if (!W || !H || !triDivs.length) return;
		const pts = markers.map((m) => { const p = map.latLngToLayerPoint(m.getLatLng()); return [p.x, p.y]; });
		tris.forEach((t, i) => {
			const s = [srcPts[t[0]], srcPts[t[1]], srcPts[t[2]]];
			const d = [pts[t[0]], pts[t[1]], pts[t[2]]];
			triDivs[i].style.transform = "matrix(" + _triAffine(s, d).join(",") + ")";
		});
	};

	// Preload to learn the natural pixel size, then build + place the mesh.
	const probe = new Image();
	probe.addEventListener("load", () => { W = probe.naturalWidth; H = probe.naturalHeight; buildTris(); update(); });
	probe.addEventListener("error", () => setMsg("Couldn't load the map scan."));
	probe.src = opts.url;

	markers.forEach((m) => m.on("drag", update));
	const onMove = () => update();
	map.on("move zoom viewreset zoomend moveend", onMove);

	// Floating control: opacity, reset-mesh, remove.
	const ctl = L.DomUtil.create("div", "dw-histmap-ctl");
	ctl.innerHTML =
		`<div class="dw-histmap-ttl">${_escHtml((opts.title || "Historical map").slice(0, 60))}</div>` +
		`<label>Opacity <input type="range" class="dw-histmap-op" min="0" max="1" step="0.05" value="0.7"></label>` +
		`<div class="dw-histmap-msg"></div>` +
		`<div class="dw-histmap-btns">` +
		`<button type="button" class="dw-histmap-fit">Reset points</button>` +
		`<button type="button" class="dw-histmap-del">Remove</button></div>`;
	map.getContainer().appendChild(ctl);
	L.DomEvent.disableClickPropagation(ctl);
	L.DomEvent.disableScrollPropagation(ctl);
	const msgEl = ctl.querySelector(".dw-histmap-msg");
	const setMsg = (t) => { if (msgEl) msgEl.textContent = t || ""; };

	ctl.querySelector(".dw-histmap-op").addEventListener("input", (e) => {
		wrap.style.opacity = e.target.value;
	});
	ctl.querySelector(".dw-histmap-fit").addEventListener("click", () => {
		markers.forEach((m, i) => m.setLatLng(gridLL[i]));
		update();
	});

	const handle = {
		remove() {
			map.off("move zoom viewreset zoomend moveend", onMove);
			markers.forEach((m) => m.remove());
			if (wrap.parentNode) wrap.remove();
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

// Drop whole-region / state / exploration sheets (1:>300k) — the "crazy
// zoomed-out" ones — and keep the local, shaft-legible scales.
const _HIST_MAX_SCALE = 300000;

// Identify every index sublayer at a point → sheet models, most-local
// (smallest scale) first so the detailed goldfield sheets lead the list.
export function fetchHistMapSheets(map, latlng, cb) {
	arcgisIdentify(map, latlng, {
		baseUrl: CFG.QLD_HIST_MAPS_SERVICE,
		layers: "all:" + CFG.QLD_HIST_MAPS_LAYER_IDS,
		tolerance: 1,
	}, (err, _feat, raw) => {
		// arcgisIdentify returns only the first result; re-read all from raw.
		const results = (raw && raw.results) || [];
		const seen = new Set();
		const sheets = results.map((r) => _histMapSheet(r.attributes || {}))
			.filter((m) => {
				if (!m.link || seen.has(m.link)) return false; // dedupe repeats
				seen.add(m.link);
				const s = parseFloat(m.scale);
				return !Number.isFinite(s) || s <= _HIST_MAX_SCALE;
			});
		sheets.sort((a, b) =>
			((parseFloat(a.scale) || 9e9) - (parseFloat(b.scale) || 9e9)) ||
			(Number(b.year || 0) - Number(a.year || 0)));
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
		// Dismiss the hover panel once a sheet is chosen.
		const panel = a.closest(".dw-histmap-hover");
		if (panel) panel.style.display = "none";
	}, true);
}

/* -- Hover panel ------------------------------------------------------
 * A plain map click drops a route waypoint, so the sheet chooser can't
 * live in a click popup. Instead: hovering the footprints cursor-identifies
 * the sheets underneath and shows an INTERACTIVE panel (you can move into
 * it to click "Overlay ▦"). The panel stays while the pointer is over it
 * and hides shortly after leaving both it and the footprints.
 */
function installHistMapHover(layer, map) {
	// Hover is a desktop interaction. On touch there is no hover — pans fire
	// synthetic mousemoves that would spuriously open the panel, and the
	// tap/long-press location popup already carries the sheet list — so skip
	// the floating panel entirely on touch devices.
	if (L.Browser.mobile || (window.matchMedia && window.matchMedia("(hover: none)").matches)) return;
	const container = map.getContainer();
	let panel = null, hideTimer = null, debounce = null, gen = 0;
	let lastKey = "";     // signature of the currently-shown sheet set
	let overPanel = false; // pointer is inside the panel (scrolling/clicking)

	const scheduleHide = () => {
		clearTimeout(hideTimer);
		hideTimer = setTimeout(() => {
			if (panel) { panel.style.display = "none"; lastKey = ""; }
		}, 500);
	};
	const ensurePanel = () => {
		if (panel) return panel;
		panel = L.DomUtil.create("div", "dw-histmap-hover", container);
		panel.style.display = "none";
		L.DomEvent.disableClickPropagation(panel);
		L.DomEvent.disableScrollPropagation(panel);
		// Keep the panel's own pointer moves from bubbling to the map — else
		// every move inside it re-fires identify and the panel jumps / its
		// scroll position resets, making it impossible to scroll or reach a row.
		L.DomEvent.on(panel, "mousemove", L.DomEvent.stopPropagation);
		panel.addEventListener("mouseenter", () => { overPanel = true; clearTimeout(hideTimer); });
		panel.addEventListener("mouseleave", () => { overPanel = false; scheduleHide(); });
		return panel;
	};

	const onMove = (e) => {
		if (overPanel) return;
		if (map.getZoom() < CFG.QLD_HIST_MAPS_MIN_ZOOM) { scheduleHide(); return; }
		clearTimeout(debounce);
		const pt = e.containerPoint, ll = e.latlng;
		debounce = setTimeout(() => {
			if (overPanel) return;
			const my = ++gen;
			fetchHistMapSheets(map, ll, (sheets) => {
				if (my !== gen || overPanel) return;
				const html = _histMapsSectionHtml(sheets);
				if (!html) { scheduleHide(); return; }
				const key = sheets.map((s) => s.link).join("|");
				const p = ensurePanel();
				clearTimeout(hideTimer);
				// Same sheets already displayed → leave the panel exactly where
				// it is (stable position + preserved scroll). Only re-render and
				// reposition when the sheet set actually changes.
				if (key === lastKey && p.style.display === "block") return;
				lastKey = key;
				p.innerHTML = `<div class="dw-histmap-hint">Move in to open · drag corners to align</div>` + html;
				p.style.display = "block";
				const cw = container.clientWidth, ch = container.clientHeight;
				let x = pt.x + 16, y = pt.y + 16;
				if (x + p.offsetWidth > cw) x = Math.max(4, pt.x - p.offsetWidth - 16);
				if (y + p.offsetHeight > ch) y = Math.max(4, ch - p.offsetHeight - 6);
				p.style.left = x + "px"; p.style.top = y + "px";
			});
		}, 220);
	};

	map.on("mousemove", onMove);
	map.on("mouseout", scheduleHide);
	layer._dwHistHoverOff = () => {
		clearTimeout(debounce); clearTimeout(hideTimer);
		map.off("mousemove", onMove);
		map.off("mouseout", scheduleHide);
		if (panel) { panel.remove(); panel = null; }
	};
}

export const HistoricalMapsIndexProvider = arcgisExportProvider({
	baseUrl: CFG.QLD_HIST_MAPS_SERVICE,
	showLayers: CFG.QLD_HIST_MAPS_LAYER_IDS,
	pane: "dwHistMapIndexPane", paneZIndex: 388,
	opacity: 0.7, minZoom: 9, maxZoom: 25,
	attribution:
		'Historical maps &copy; <a href="https://www.data.qld.gov.au/" ' +
		'target="_blank" rel="noreferrer">State of Queensland (Resources)</a>',
	onAdd: (layer, map) => { _ensureHistMapHook(map); installHistMapHover(layer, map); },
	onRemove: (layer) => { if (layer._dwHistHoverOff) { layer._dwHistHoverOff(); layer._dwHistHoverOff = null; } },
});
