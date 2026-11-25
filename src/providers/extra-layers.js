import { CFG } from "../config.js";
import { arcgisExportProvider } from "../layers/provider-factories.js";
import { _escHtml, esc } from "../utils/html.js";
import { _formatSurveyMark } from "./qld-survey.js";

/* -- Pipelines, easements, pastoral districts, destroyed survey marks ------
 * Pipelines: Geoscience Australia's Oil and Gas Pipelines (layers 0 oil,
 *   1 gas), Australia-wide, in GA's own style (CC BY 4.0).
 * Easements (QLD): the cadastre's easement parcels (layer 9), the strips
 *   reserved for power lines, pipes, drainage or access. The records hold
 *   the lot and plan, not the purpose.
 * Pastoral Districts (QLD): Queensland's 15 historic pastoral districts.
 * Old Survey Marks (destroyed): the survey-control marks recorded as
 *   destroyed (layer 13), drawn as grey crosses, with their history.
 */

const v = (x) => { const s = x == null ? "" : String(x).trim(); return s && !/^(null|none)$/i.test(s) ? s : ""; };

export function _formatPipeline(attrs) {
	const a = attrs || {};
	const name = v(a.Name || a.feature_name);
	const type = v(a["Feature Type"] || a.feature_type) || "Pipeline";
	const status = v(a.Status || a.status);
	const operator = v(a.Operator || a.operator);
	const km = Number(v(a["Length Km"] || a.length_km));
	const lines = [esc`<b>${name || type}</b>`];
	const facts = [name ? type : "", km > 0 ? `${km >= 10 ? Math.round(km) : km.toFixed(1)} km` : ""].filter(Boolean).join(" · ");
	if (facts) lines.push(_escHtml(facts));
	const st = status === "Fully capable of operation" ? "In operation" : status;
	if (st || operator) lines.push(_escHtml([st, operator ? "operator " + operator : ""].filter(Boolean).join(" · ")));
	return lines.join("<br>");
}

export function _formatEasement(attrs) {
	const a = attrs || {};
	const lot = v(a.Lot), plan = v(a.Plan);
	const m2 = Number(v(a["Lot area (m²)"]));
	const lines = [esc`<b>Easement ${lot}${plan ? " on " + plan : ""}</b>`];
	const facts = [m2 > 0 ? (m2 >= 10000 ? `${(m2 / 10000).toFixed(1)} ha` : `${Math.round(m2).toLocaleString("en-AU")} m²`) : "", v(a.Locality)].filter(Boolean).join(" · ");
	if (facts) lines.push(_escHtml(facts));
	lines.push(`<span class="dw-cad-sub">A strip reserved for power, pipes, drainage or access; the record does not say which</span>`);
	return lines.join("<br>");
}

export function _formatPastoral(attrs) {
	const a = attrs || {};
	const d = v(a.DISTRICT || a.district);
	const name = d ? d.charAt(0) + d.slice(1).toLowerCase() : "";
	return esc`<b>${name || "Pastoral"} pastoral district</b>` + `<br><span class="dw-cad-sub">One of Queensland's 15 historic pastoral districts</span>`;
}

const SC = "sirpub.prop.qld_surveycontrol_scdb.";

export function destroyedMarksDynamicLayers() {
	return JSON.stringify([{
		id: 13, source: { type: "mapLayer", mapLayerId: 13 },
		drawingInfo: { renderer: { type: "simple", symbol: { type: "esriSMS", style: "esriSMSX", color: [107, 114, 128, 230], size: 7,
			outline: { color: [107, 114, 128, 230], width: 1.4 } } }, showLabels: false },
	}]);
}

// The service's own renderer names the field "DISTRICT" while the data has
// "district", so it draws nothing: outline and name the districts ourselves.
export function pastoralDynamicLayers() {
	return JSON.stringify([{
		id: 0, source: { type: "mapLayer", mapLayerId: 0 },
		drawingInfo: {
			renderer: { type: "simple", symbol: { type: "esriSFS", style: "esriSFSNull",
				outline: { type: "esriSLS", style: "esriSLSDashDot", color: [146, 64, 14, 220], width: 1.6 } } },
			showLabels: true,
			labelingInfo: [{ labelExpression: "[district]", labelPlacement: "esriServerPolygonPlacementAlwaysHorizontal",
				symbol: { type: "esriTS", color: [120, 53, 15, 255], haloColor: [255, 255, 255, 255], haloSize: 2,
					font: { family: "Arial", size: 11, weight: "bold" } } }],
		},
	}]);
}

export function extraIdentifySources() {
	return [
		{ layerName: CFG.LAYER_PIPELINES, heading: "Pipelines", baseUrl: CFG.GA_PIPELINES_SERVICE,
			layers: "all:0,1", tolerance: 5, minZoom: 6, format: _formatPipeline },
		{ layerName: CFG.LAYER_EASEMENTS, heading: "Easements", baseUrl: CFG.QLD_STATE_LAND_SERVICE,
			layers: "all:9", tolerance: 1, minZoom: 14, format: _formatEasement },
		{ layerName: CFG.LAYER_PASTORAL, heading: "Pastoral district", baseUrl: CFG.QLD_PASTORAL_SERVICE,
			layers: "all:0", tolerance: 0, minZoom: 4, format: _formatPastoral },
		{ layerName: CFG.LAYER_OLD_MARKS, heading: "Destroyed survey marks", baseUrl: CFG.QLD_SURVEY_SERVICE,
			layers: "all:13", tolerance: 6, minZoom: CFG.QLD_SURVEY_MIN_ZOOM, format: _formatSurveyMark },
	];
}

export function createExtraProviders({ makeHoverIdentify }) {
	const [pipe, ease, past, marks] = extraIdentifySources();
	const off = (layer) => { if (layer._dwHoverOff) { layer._dwHoverOff(); layer._dwHoverOff = null; } };
	const hover = (src, format) => makeHoverIdentify({ baseUrl: src.baseUrl, layers: src.layers, tolerance: src.tolerance,
		minZoom: src.minZoom, tipClass: "dw-qpws-tip", formatTooltip: format || src.format });
	const hp = hover(pipe), he = hover(ease), ha = hover(past);
	// The tooltip cannot be clicked, so a mark's report link is left to the pop-up.
	const hm = hover(marks, (a) => _formatSurveyMark({ ...a, "Report link": "", "Report Link": "" }));
	const prov = (o, install) => arcgisExportProvider({ ...o, onAdd: (layer, map) => install(layer, map), onRemove: off });
	return {
		PipelinesProvider: prov({ baseUrl: CFG.GA_PIPELINES_SERVICE, showLayers: "0,1", pane: "dwPipelinePane", paneZIndex: 408,
			opacity: 1, minZoom: 4, maxZoom: 25,
			attribution: 'Pipelines &copy; <a href="https://www.ga.gov.au/" target="_blank" rel="noreferrer">Geoscience Australia</a> (CC BY 4.0)' }, hp),
		EasementsProvider: prov({ baseUrl: CFG.QLD_STATE_LAND_SERVICE, showLayers: "9", pane: "dwEasementPane", paneZIndex: 389,
			opacity: 0.9, minZoom: 14, maxZoom: 25,
			attribution: 'Easements &copy; <a href="https://www.data.qld.gov.au/" target="_blank" rel="noreferrer">State of Queensland (Resources)</a>' }, he),
		PastoralProvider: prov({ baseUrl: CFG.QLD_PASTORAL_SERVICE, tileSize: 512,
			extraParams: "&dynamicLayers=" + encodeURIComponent(pastoralDynamicLayers()), pane: "dwPastoralPane", paneZIndex: 380,
			opacity: 0.8, minZoom: 4, maxZoom: 25,
			attribution: 'Pastoral districts &copy; <a href="https://www.data.qld.gov.au/" target="_blank" rel="noreferrer">State of Queensland</a>' }, ha),
		OldMarksProvider: prov({ baseUrl: CFG.QLD_SURVEY_SERVICE,
			extraParams: "&dynamicLayers=" + encodeURIComponent(destroyedMarksDynamicLayers()),
			pane: "dwOldMarksPane", paneZIndex: 401, opacity: 1, minZoom: CFG.QLD_SURVEY_MIN_ZOOM, maxZoom: 25,
			attribution: 'Survey marks &copy; <a href="https://www.qld.gov.au/environment/land/title/surveying" target="_blank" rel="noreferrer">State of Queensland (Resources)</a>' }, hm),
	};
}
