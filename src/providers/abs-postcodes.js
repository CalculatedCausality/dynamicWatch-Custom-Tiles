import { CFG } from "../config.js";
import { arcgisExportProvider } from "../layers/provider-factories.js";
import { _escHtml, esc } from "../utils/html.js";

/* -- Postcodes (ABS Postal Areas) ------------------------------------------
 * Every postcode area in Australia, from the Australian Bureau of
 * Statistics' 2021 Postal Areas (ASGS2021/POA, layer 0): the ABS's
 * mesh-block approximation of Australia Post postcodes, which it says
 * are for statistics, not official boundaries. Australia Post's own
 * boundaries are a paid product. Drawn as outlines with the postcode
 * written in each area.
 */

export function postcodeDynamicLayers() {
	return JSON.stringify([{
		id: 0, source: { type: "mapLayer", mapLayerId: 0 },
		drawingInfo: {
			renderer: { type: "simple", symbol: { type: "esriSFS", style: "esriSFSNull",
				// Dark grey dashes: the planner draws routes in purple.
				outline: { type: "esriSLS", style: "esriSLSDash", color: [55, 65, 81, 220], width: 1.4 } } },
			showLabels: true,
			labelingInfo: [{
				labelExpression: "[poa_code_2021]",
				labelPlacement: "esriServerPolygonPlacementAlwaysHorizontal",
				symbol: { type: "esriTS", color: [31, 41, 55, 255], haloColor: [255, 255, 255, 255], haloSize: 2,
					font: { family: "Arial", size: 11, weight: "bold" } },
			}],
		},
	}]);
}

export function _formatPostcode(attrs) {
	const a = attrs || {};
	const code = String(a.POA_CODE_2021 || a.poa_code_2021 || "").trim();
	const km2 = Number(a.AREA_ALBERS_SQKM || a.area_albers_sqkm);
	const lines = [esc`<b>Postcode ${code || "unknown"}</b>`];
	if (km2 > 0) lines.push(_escHtml(`${km2 >= 10 ? Math.round(km2).toLocaleString("en-AU") : km2.toFixed(1)} km²`));
	lines.push(`<span class="dw-cad-sub">ABS approximation of the postcode area</span>`);
	return lines.join("<br>");
}

export function postcodeIdentifySource() {
	return { layerName: CFG.LAYER_POSTCODES, heading: "Postcode", baseUrl: CFG.ABS_POA_SERVICE,
		layers: "all:0", tolerance: 0, minZoom: CFG.ABS_POA_MIN_ZOOM, format: _formatPostcode };
}

export function createPostcodeProvider({ makeHoverIdentify }) {
	const src = postcodeIdentifySource();
	const installHover = makeHoverIdentify({
		baseUrl: src.baseUrl, layers: src.layers, tolerance: 0, minZoom: src.minZoom,
		tipClass: "dw-qpws-tip", formatTooltip: _formatPostcode,
	});
	return arcgisExportProvider({
		baseUrl: CFG.ABS_POA_SERVICE,
		extraParams: "&dynamicLayers=" + encodeURIComponent(postcodeDynamicLayers()),
		// Large tiles: each tile labels its own piece of an area, so fewer tiles
		// means fewer repeated numbers.
		tileSize: 512,
		pane: "dwPostcodePane", paneZIndex: 387, opacity: 1, minZoom: CFG.ABS_POA_MIN_ZOOM, maxZoom: 25,
		attribution: 'Postal areas &copy; <a href="https://www.abs.gov.au/" target="_blank" rel="noreferrer">Australian Bureau of Statistics</a>, CC BY 4.0',
		onAdd: (layer, map) => installHover(layer, map),
		onRemove: (layer) => { if (layer._dwHoverOff) { layer._dwHoverOff(); layer._dwHoverOff = null; } },
	});
}

/* -- Suburbs (ABS Suburbs and Localities) ----------------------------------
 * The ABS's 2021 Suburbs and Localities (ASGS2021/SAL, layer 0): its
 * mesh-block approximation of gazetted suburbs and localities, all of
 * Australia. Solid teal outlines with the name, so they read apart from
 * the grey dashed postcodes when both are on. Names the ABS shares across
 * states carry a state suffix, e.g. "Kenmore (Qld)".
 */

export function suburbDynamicLayers() {
	return JSON.stringify([{
		id: 0, source: { type: "mapLayer", mapLayerId: 0 },
		drawingInfo: {
			renderer: { type: "simple", symbol: { type: "esriSFS", style: "esriSFSNull",
				outline: { type: "esriSLS", style: "esriSLSSolid", color: [15, 118, 110, 200], width: 1.2 } } },
			showLabels: true,
			labelingInfo: [{
				labelExpression: "[sal_name_2021]",
				labelPlacement: "esriServerPolygonPlacementAlwaysHorizontal",
				symbol: { type: "esriTS", color: [17, 94, 89, 255], haloColor: [255, 255, 255, 255], haloSize: 2,
					font: { family: "Arial", size: 10, style: "italic", weight: "bold" } },
			}],
		},
	}]);
}

export function _formatSuburb(attrs) {
	const a = attrs || {};
	const name = String(a.SAL_NAME_2021 || a.sal_name_2021 || "").replace(/\s*\((?:Qld|NSW|Vic\.?|SA|WA|Tas\.?|NT|ACT|OT)\)\s*$/i, "").trim();
	const state = String(a.STATE_NAME_2021 || a.state_name_2021 || "").trim();
	const km2 = Number(a.AREA_ALBERS_SQKM || a.area_albers_sqkm);
	const lines = [esc`<b>${name || "Suburb"}</b>`];
	const facts = [state, km2 > 0 ? `${km2 >= 10 ? Math.round(km2).toLocaleString("en-AU") : km2.toFixed(1)} km²` : ""].filter(Boolean).join(" · ");
	if (facts) lines.push(_escHtml(facts));
	return lines.join("<br>");
}

export function suburbIdentifySource() {
	return { layerName: CFG.LAYER_SUBURBS, heading: "Suburb", baseUrl: CFG.ABS_SAL_SERVICE,
		layers: "all:0", tolerance: 0, minZoom: CFG.ABS_SAL_MIN_ZOOM, format: _formatSuburb };
}

export function createSuburbProvider({ makeHoverIdentify }) {
	const src = suburbIdentifySource();
	const installHover = makeHoverIdentify({
		baseUrl: src.baseUrl, layers: src.layers, tolerance: 0, minZoom: src.minZoom,
		tipClass: "dw-qpws-tip", formatTooltip: _formatSuburb,
	});
	return arcgisExportProvider({
		baseUrl: CFG.ABS_SAL_SERVICE,
		extraParams: "&dynamicLayers=" + encodeURIComponent(suburbDynamicLayers()),
		tileSize: 512,
		pane: "dwSuburbPane", paneZIndex: 386, opacity: 1, minZoom: CFG.ABS_SAL_MIN_ZOOM, maxZoom: 25,
		attribution: 'Suburbs &copy; <a href="https://www.abs.gov.au/" target="_blank" rel="noreferrer">Australian Bureau of Statistics</a>, CC BY 4.0',
		onAdd: (layer, map) => installHover(layer, map),
		onRemove: (layer) => { if (layer._dwHoverOff) { layer._dwHoverOff(); layer._dwHoverOff = null; } },
	});
}
