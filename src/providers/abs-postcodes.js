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
		pane: "dwPostcodePane", paneZIndex: 387, opacity: 1, minZoom: CFG.ABS_POA_MIN_ZOOM, maxZoom: 25,
		attribution: 'Postal areas &copy; <a href="https://www.abs.gov.au/" target="_blank" rel="noreferrer">Australian Bureau of Statistics</a>, CC BY 4.0',
		onAdd: (layer, map) => installHover(layer, map),
		onRemove: (layer) => { if (layer._dwHoverOff) { layer._dwHoverOff(); layer._dwHoverOff = null; } },
	});
}
