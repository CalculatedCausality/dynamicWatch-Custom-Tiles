import { CFG } from "../config.js";
import { arcgisExportProvider } from "../layers/provider-factories.js";
import { _escHtml, esc } from "../utils/html.js";

/* -- QLD fire history ------------------------------------------------------
 * Two overlays from the same public host as the cadastre:
 *   Park Fire History — QPWS's record of planned burns and wildfires on
 *       park and forest land (Environment/ParksFireHistory, layer 0),
 *       last ten years, coloured by age; wildfires solid, planned burns
 *       hatched. Drawn as six filtered `dynamicLayers` passes.
 *   Fire Scars — burns detected in Sentinel-2 satellite imagery on all
 *       land (Environment/FireScarMapping): layer 0 holds the current
 *       year, and each earlier year has its own layer, id = year − 1986.
 * Both are built for the year the page is opened in.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Age bands, newest first: [label, oldest years back, newest years back, colour].
export const FIRE_AGES = [
	["Within about a year", 1, 0, [220, 38, 38]],
	["2 to 4 years ago", 4, 2, [234, 88, 12]],
	["5 to 10 years ago", 10, 5, [202, 138, 4]],
];

// The six filtered passes over the parks layer for `year`.
export function parkFireDynamicLayers(year) {
	const out = [];
	FIRE_AGES.forEach(([label, from, to, rgb], ai) => {
		for (const [ti, [type, style, alpha]] of [["WF", "esriSFSSolid", 110], ["PB", "esriSFSBackwardDiagonal", 200]].entries()) {
			out.push({
				id: 201 + ai * 2 + ti,
				source: { type: "mapLayer", mapLayerId: 0 },
				definitionExpression: `type = '${type}' AND outyear >= ${year - from} AND outyear <= ${year - to}`,
				drawingInfo: { renderer: { type: "simple", label: `${label} (${type === "WF" ? "wildfire" : "planned burn"})`,
					symbol: { type: "esriSFS", style, color: [...rgb, alpha],
						outline: { type: "esriSLS", style: "esriSLSSolid", color: [...rgb, 230], width: 1 } } }, showLabels: false },
			});
		}
	});
	return JSON.stringify(out);
}

// Satellite layer for a past year (2025 → 39); layer 0 is the current year.
export function fireScarLayerId(year) { return year - 1986; }

export function fireScarDynamicLayers(year) {
	const pass = (id, source, rgb, alpha, label) => ({
		id, source: { type: "mapLayer", mapLayerId: source },
		drawingInfo: { renderer: { type: "simple", label, symbol: { type: "esriSFS", style: "esriSFSSolid", color: [...rgb, alpha],
			outline: { type: "esriSLS", style: "esriSLSSolid", color: [...rgb, 200], width: 0.4 } } }, showLabels: false },
	});
	// First is drawn on top: this year over last year.
	return JSON.stringify([
		pass(301, 0, [220, 38, 38], 140, String(year)),
		pass(302, fireScarLayerId(year - 1), [234, 88, 12], 90, String(year - 1)),
	]);
}

function _val(v) {
	if (v === null || v === undefined) return "";
	const s = String(v).trim();
	return s && !/^(null|none)$/i.test(s) ? s : "";
}

// "4/15/2026 10:16:00 AM" (identify) or epoch ms → "Apr 2026"; "" otherwise.
export function _fireMonth(v) {
	const s = _val(v);
	if (!s) return "";
	let d = null;
	if (/^-?\d{11,13}$/.test(s)) d = new Date(Number(s));
	else { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s); if (m) d = new Date(Date.UTC(+m[3], +m[1] - 1, +m[2])); }
	return d && !isNaN(d) && d.getUTCFullYear() > 1900 ? `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` : "";
}

const _ha = (v) => { const n = Number(_val(v)); return n > 0 ? (n >= 100 ? Math.round(n).toLocaleString("en-AU") : n.toFixed(n < 10 ? 1 : 0)) + " ha" : ""; };

export function _formatParkFire(attrs) {
	const a = attrs || {};
	const type = _val(a.Type || a.type);
	const kind = type === "WF" ? "Wildfire" : type === "PB" ? "Planned burn" : "Fire";
	const when = _fireMonth(a.IgnitionDate || a.ignitiondate) || _fireMonth(a.OutDate || a.outdate) || _val(a.OutYear || a.outyear);
	const park = _val(a.Label || a.label).split("/")[0].trim();
	const where = _val(a.General_Location || a.general_location);
	const pct = Number(_val(a.Pct_Burn || a.pct_burn));
	const lines = [esc`<b>${kind}${when ? ", " + when : ""}</b>`];
	if (park) lines.push(_escHtml(park));
	const facts = [_ha(a.Area_ha || a.area_ha), Number.isFinite(pct) && pct > 0 && _val(a.Pct_Burn || a.pct_burn) ? `${Math.round(pct)}% burnt` : ""].filter(Boolean).join(" · ");
	if (facts) lines.push(_escHtml(facts));
	if (where) lines.push(esc`<span class="dw-cad-sub">${where.slice(0, 160)}</span>`);
	return lines.join("<br>");
}

export function _formatFireScar(attrs) {
	const a = attrs || {};
	const rawMonth = Number(_val(a.Month || a.month));
	const month = _val(a["Month of Year"] || a["Month of year"] || a.month_desc) ||
		(rawMonth >= 1 && rawMonth <= 12 ? ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][rawMonth - 1] : "");
	const year = _val(a.Year || a.year);
	const lines = [esc`<b>Burnt${month || year ? ", " + [month, year].filter(Boolean).join(" ") : ""}</b>`];
	const area = _ha(a["Area(ha)"] || a.area_ha);
	lines.push(_escHtml(["Detected by satellite", area].filter(Boolean).join(" · ")));
	return lines.join("<br>");
}

export function fireIdentifySources(year) {
	return [
		{ layerName: CFG.LAYER_PARK_FIRES, heading: "Park fire history", baseUrl: CFG.QLD_PARK_FIRE_SERVICE,
			layers: "all:0", layerDefs: { 0: `outyear >= ${year - 10}` }, tolerance: 1, unformatted: true,
			minZoom: CFG.QLD_FIRE_HOVER_MIN_ZOOM, format: _formatParkFire },
		{ layerName: CFG.LAYER_FIRE_SCARS, heading: "Fire scars", baseUrl: CFG.QLD_FIRE_SCAR_SERVICE,
			layers: `all:0,${fireScarLayerId(year - 1)}`, tolerance: 1, unformatted: true,
			minZoom: CFG.QLD_FIRE_HOVER_MIN_ZOOM, format: _formatFireScar },
	];
}

export function createQldFireProviders({ makeHoverIdentify }) {
	const year = new Date().getFullYear();
	const [parkSrc, scarSrc] = fireIdentifySources(year);
	const offHover = (layer) => { if (layer._dwHoverOff) { layer._dwHoverOff(); layer._dwHoverOff = null; } };
	const hover = (src) => makeHoverIdentify({
		baseUrl: src.baseUrl, layers: src.layers, layerDefs: src.layerDefs, tolerance: src.tolerance, unformatted: true,
		minZoom: src.minZoom, tipClass: "dw-qpws-tip", formatTooltip: src.format,
	});
	const installPark = hover(parkSrc), installScar = hover(scarSrc);
	const ParkFireLayerProvider = arcgisExportProvider({
		baseUrl: CFG.QLD_PARK_FIRE_SERVICE,
		extraParams: "&dynamicLayers=" + encodeURIComponent(parkFireDynamicLayers(year)),
		pane: "dwParkFirePane", paneZIndex: 384, opacity: 0.9, minZoom: 8, maxZoom: 25,
		attribution: 'Park fire history &copy; <a href="https://www.data.qld.gov.au/" target="_blank" rel="noreferrer">State of Queensland (QPWS)</a>',
		onAdd: (layer, map) => installPark(layer, map), onRemove: offHover,
	});
	const FireScarLayerProvider = arcgisExportProvider({
		baseUrl: CFG.QLD_FIRE_SCAR_SERVICE,
		extraParams: "&dynamicLayers=" + encodeURIComponent(fireScarDynamicLayers(year)),
		pane: "dwFireScarPane", paneZIndex: 383, opacity: 0.85, minZoom: 6, maxZoom: 25,
		attribution: 'Fire scars &copy; <a href="https://www.data.qld.gov.au/" target="_blank" rel="noreferrer">State of Queensland (Sentinel-2 fire scar mapping)</a>',
		onAdd: (layer, map) => installScar(layer, map), onRemove: offHover,
	});
	return { ParkFireLayerProvider, FireScarLayerProvider };
}
