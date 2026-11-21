import { CFG } from "../config.js";
import { arcgisExportProvider } from "../layers/provider-factories.js";
import { _escHtml, esc } from "../utils/html.js";

/* -- QLD Land Use + State Land -----------------------------------------
 * Two polygon overlays from the same public, token-free ArcGIS host as the
 * cadastre:
 *   Land Use   — the Queensland Land Use Mapping Program's latest mapping
 *                (PlanningCadastre/LandUse), drawn in the service's own
 *                colours.
 *   State Land — the cadastre's Tenure layer cut down to land the State
 *                owns, recoloured so each kind reads apart. (The purpose-
 *                built StateManagedLand service is token-gated.)
 */

function _landVal(v) {
	if (v === null || v === undefined) return "";
	const s = String(v).trim();
	return s && s.toLowerCase() !== "null" && s.toLowerCase() !== "none" ? s : "";
}
function _landPick(a, keys) {
	for (const k of keys) { const v = _landVal(a[k]); if (v) return v; }
	return "";
}

// The service's 194 QLUMP codes fall into 32 classes in unbroken runs; each
// entry is [last code of the run, class]. Read from the layer's renderer.
const LAND_USE_CLASSES = [
	[8, "Nature conservation"], [14, "Managed resource protection"], [19, "Other minimal use"],
	[20, "Grazing native vegetation"], [23, "Production forestry"], [28, "Plantation forestry"],
	[35, "Grazing modified pastures"], [44, "Cropping"], [54, "Perennial horticulture"],
	[59, "Seasonal horticulture"], [65, "Land in transition"], [70, "Irrigated plantation forestry"],
	[76, "Irrigated modified pastures"], [86, "Irrigated cropping"], [96, "Irrigated perennial horticulture"],
	[102, "Irrigated seasonal horticulture"], [108, "Irrigated land in transition"], [113, "Intensive horticulture"],
	[123, "Intensive animal husbandry"], [132, "Manufacturing and industrial"], [138, "Residential"],
	[144, "Services"], [151, "Utilities"], [157, "Transport and communication"], [162, "Mining"],
	[168, "Waste treatment and disposal"], [173, "Lake"], [177, "Reservoir/dam"], [181, "River"],
	[185, "Channel/aqueduct"], [190, "Marsh/wetland"], [194, "Estuary/coastal waters"],
];

// Class name for a QLUMP code; "" when the code is outside the table.
export function _landUseClass(code) {
	const n = Number(code);
	if (!Number.isInteger(n) || n < 1) return "";
	const hit = LAND_USE_CLASSES.find(([last]) => n <= last);
	return hit ? hit[1] : "";
}

export function _formatLandUseTooltip(attrs) {
	const a = attrs || {};
	const cls = _landUseClass(_landPick(a, ["QLUMP_Code", "qlump_code"]));
	// The finer levels are filled in for only some polygons.
	const detail = _landPick(a, ["Tertiary", "tertiary"]) || _landPick(a, ["Secondary", "secondary"]);
	const commodity = _landPick(a, ["COMMODITY", "commodity"]);
	const alum = _landPick(a, ["ALUM_Code", "alum_code"]);
	const year = _landPick(a, ["Year", "year"]);

	const lines = [esc`<b>${cls || detail || "Land use"}</b>`];
	if (detail && cls && detail.toLowerCase() !== cls.toLowerCase()) lines.push(_escHtml(detail));
	if (commodity) lines.push(_escHtml(commodity));
	const sub = [alum ? "ALUM " + alum : "", year ? "mapped " + year : ""].filter(Boolean).join(" · ");
	if (sub) lines.push(esc`<span class="dw-cad-sub">${sub}</span>`);
	return lines.join("<br>");
}

// The tenures drawn as State Land, with their fill colour and what each
// means in plain words. Tenure names come from tile data filters, so they
// are fixed strings here, never user or server text.
export const STATE_LAND_TENURES = [
	{ tenure: "National Park",  rgb: [21, 128, 61],  note: "National park" },
	{ tenure: "State Forest",   rgb: [133, 77, 14],  note: "State forest" },
	{ tenure: "Forest Reserve", rgb: [133, 77, 14],  note: "Forest reserve" },
	{ tenure: "Timber Reserve", rgb: [133, 77, 14],  note: "Timber reserve" },
	{ tenure: "Reserve",        rgb: [13, 148, 136], note: "Reserve set aside for a community purpose" },
	{ tenure: "State Land",     rgb: [234, 88, 12],  note: "Unallocated State land" },
	{ tenure: "Lands Lease",    rgb: [202, 138, 4],  note: "State land held under lease" },
];

const STATE_LAND_WHERE =
	"tenure IN (" + STATE_LAND_TENURES.map((t) => `'${t.tenure}'`).join(",") + ")";

// ArcGIS `dynamicLayers` value: the Tenure layer, filtered and recoloured.
export function stateLandDynamicLayers() {
	return JSON.stringify([{
		id: CFG.QLD_STATE_LAND_LAYER_ID,
		source: { type: "mapLayer", mapLayerId: CFG.QLD_STATE_LAND_LAYER_ID },
		definitionExpression: STATE_LAND_WHERE,
		drawingInfo: { renderer: {
			type: "uniqueValue", field1: "tenure",
			uniqueValueInfos: STATE_LAND_TENURES.map((t) => ({
				value: t.tenure, label: t.tenure,
				symbol: {
					type: "esriSFS", style: "esriSFSSolid", color: [...t.rgb, 110],
					outline: { type: "esriSLS", style: "esriSLSSolid",
						color: [...t.rgb.map((c) => Math.round(c * 0.7)), 235], width: 0.8 },
				},
			})),
		} },
	}]);
}

// "125410" m² → "12.5 ha"; small lots stay in m².
export function _landArea(value) {
	const m2 = Number(_landVal(value));
	if (!Number.isFinite(m2) || m2 <= 0) return "";
	if (m2 < 10000) return Math.round(m2).toLocaleString("en-AU") + " m²";
	const ha = m2 / 10000;
	return (ha >= 100 ? Math.round(ha) : Number(ha.toFixed(1))).toLocaleString("en-AU") + " ha";
}

export function _formatStateLandTooltip(attrs) {
	const a = attrs || {};
	const tenure = _landPick(a, ["Tenure", "tenure"]);
	const known = STATE_LAND_TENURES.find((t) => t.tenure === tenure);
	const name = _landPick(a, ["Name", "feat_name"]);
	const alias = _landPick(a, ["Alias", "alias_name"]);
	const lotplan = _landPick(a, ["Lot/plan", "lotplan"]);
	const area = _landArea(_landPick(a, ["Lot area (m²)", "lot_area"]));
	const locality = _landPick(a, ["Locality", "locality"]);

	const kind = known ? known.note : tenure;
	const lines = [esc`<b>${name || kind || "State land"}</b>`];
	if (name && kind) lines.push(_escHtml(kind));
	// The alias field doubles as a notes field ("Total Area Abt6455ha"): only a real second name is shown.
	if (alias && alias.toLowerCase() !== name.toLowerCase() && !/\barea\b|\d\s*ha\b/i.test(alias)) {
		lines.push(esc`Also known as ${alias}`);
	}
	const sub = [lotplan ? "Lot " + lotplan : "", area, locality].filter(Boolean).join(" · ");
	if (sub) lines.push(esc`<span class="dw-cad-sub">${sub}</span>`);
	return lines.join("<br>");
}

// Both overlays as identify sources, for the location pop-up.
export function landIdentifySources() {
	return [
		{ layerName: CFG.LAYER_STATE_LAND, heading: "State land", baseUrl: CFG.QLD_STATE_LAND_SERVICE,
			layers: "all:" + CFG.QLD_STATE_LAND_LAYER_ID, tolerance: 1, minZoom: CFG.QLD_STATE_LAND_MIN_ZOOM,
			layerDefs: { [CFG.QLD_STATE_LAND_LAYER_ID]: STATE_LAND_WHERE }, format: _formatStateLandTooltip },
		{ layerName: CFG.LAYER_LAND_USE, heading: "Land use", baseUrl: CFG.QLD_LAND_USE_SERVICE,
			layers: "all:0", tolerance: 1, minZoom: CFG.QLD_LAND_USE_HOVER_MIN_ZOOM, format: _formatLandUseTooltip },
	];
}

export function createQldLandProviders({ makeHoverIdentify }) {
	const offHover = (layer) => {
		if (layer._dwHoverOff) { layer._dwHoverOff(); layer._dwHoverOff = null; }
	};
	const [stateSrc, useSrc] = landIdentifySources();

	const installStateHover = makeHoverIdentify({
		baseUrl: stateSrc.baseUrl, layers: stateSrc.layers, layerDefs: stateSrc.layerDefs,
		tolerance: 1, minZoom: CFG.QLD_STATE_LAND_MIN_ZOOM,
		tipClass: "dw-qpws-tip", formatTooltip: _formatStateLandTooltip,
	});
	const StateLandLayerProvider = arcgisExportProvider({
		baseUrl: CFG.QLD_STATE_LAND_SERVICE,
		extraParams: "&dynamicLayers=" + encodeURIComponent(stateLandDynamicLayers()),
		pane: "dwStateLandPane", paneZIndex: 386,
		opacity: 0.85, minZoom: CFG.QLD_STATE_LAND_MIN_ZOOM, maxZoom: 25,
		attribution:
			'Tenure &copy; <a href="https://www.data.qld.gov.au/" ' +
			'target="_blank" rel="noreferrer">State of Queensland (Resources)</a>',
		onAdd: (layer, map) => installStateHover(layer, map),
		onRemove: offHover,
	});

	const installUseHover = makeHoverIdentify({
		baseUrl: useSrc.baseUrl, layers: useSrc.layers,
		tolerance: 1, minZoom: CFG.QLD_LAND_USE_HOVER_MIN_ZOOM,
		tipClass: "dw-qpws-tip", formatTooltip: _formatLandUseTooltip,
	});
	const LandUseLayerProvider = arcgisExportProvider({
		baseUrl: CFG.QLD_LAND_USE_SERVICE,
		showLayers: "0",
		pane: "dwLandUsePane", paneZIndex: 385,
		opacity: 0.55, minZoom: 7, maxZoom: 25,
		attribution:
			'Land use &copy; <a href="https://www.qld.gov.au/environment/land/management/mapping/statewide-monitoring/qlump" ' +
			'target="_blank" rel="noreferrer">State of Queensland (QLUMP)</a>',
		onAdd: (layer, map) => installUseHover(layer, map),
		onRemove: offHover,
	});

	return { StateLandLayerProvider, LandUseLayerProvider };
}
