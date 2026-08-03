import { CFG } from "../config.js";
import { arcgisExportProvider } from "../layers/provider-factories.js";
import { _escHtml, esc } from "../utils/html.js";

/* -- QLD Historic Mines (GSQ MiningResources / GeoResGlobe) ------------
 * Server-rendered point overlay of Queensland's historical mine sites
 * (layer 16 "Historical workings" + 102 "Historical coal workings") with
 * hover-identify tooltips carrying the site name, commodity, status and
 * locality. Same public, token-free ArcGIS host as the cadastre.
 */

// Drop ArcGIS "Null"/empty sentinels the way the cadastre helper does.
function _mineVal(v) {
	if (v === null || v === undefined) return "";
	const s = String(v).trim();
	return s && s.toLowerCase() !== "null" ? s : "";
}

// Return the first non-empty value among candidate keys. ArcGIS /identify
// keys attributes by field ALIAS ("Occurrence name", "Main commodity"),
// while a GeoJSON /query keys by raw field name (occur_name) — so each
// field lists both forms.
function _pickAny(a, keys) {
	for (const k of keys) { const v = _mineVal(a[k]); if (v) return v; }
	return "";
}

export function _formatMineTooltip(attrs) {
	const a = attrs || {};
	const name      = _pickAny(a, ["Occurrence name", "occur_name"]);
	const commodity = _pickAny(a, ["Main commodity", "main_commodity"]);
	const status    = _pickAny(a, ["Mine status", "mine_status"]);
	const size      = _pickAny(a, ["Deposit size", "deposit_size"]);
	const locality  = _pickAny(a, ["site locality", "Site locality", "site_locality"]);
	const kind      = _pickAny(a, ["Group name", "group_name", "Site type", "site_type"]);

	const lines = [esc`<b>${name || "Historic mine"}</b>`];
	const bits = [commodity, status, size].filter(Boolean);
	if (bits.length) lines.push(_escHtml(bits.join(" · ")));
	if (locality)    lines.push(_escHtml(locality));
	if (kind)        lines.push(esc`<span class="dw-cad-sub">${kind}</span>`);
	return lines.join("<br>");
}

// Abandoned-mine physical features (shafts/adits/pits). Layer 45 keys by
// "Type"/"Mine Name"/"Commodity"/"Remediation Status"; the shallow-working
// and pit layers key by "Feature Sub Type"/"Feature Remediated" — read both.
export function _formatShaftTooltip(attrs) {
	const a = attrs || {};
	const type = _pickAny(a, ["Type", "feature_type", "Feature Sub Type", "ftr_sub"]);
	const mine = _pickAny(a, ["Mine Name", "mine_name"]);
	const commodity = _pickAny(a, ["Commodity", "commodity"]);
	const rem = _pickAny(a, ["Remediation Status", "rem_status", "Feature Remediated", "ftr_rehab"]);

	const lines = [esc`<b>${type || "Mine opening"}</b>`];
	// mine_name is frequently "Unknown" — drop it rather than show noise.
	const named = mine && mine.toLowerCase() !== "unknown" ? mine : "";
	const bits = [named, commodity].filter(Boolean);
	if (bits.length) lines.push(_escHtml(bits.join(" · ")));
	if (rem) lines.push(esc`<span class="dw-cad-sub">${rem}</span>`);
	return lines.join("<br>");
}

// Historic mining title (ML/MC/MDL) footprints. /identify aliases:
// displayname→"Permit number", permittype→"Permit type",
// permitstatus→"Permit status", permitstate→"Permit sub-status",
// permitminerals→"Mineral", authorisedholdername→"Authorised holder name".
export function _formatLeaseTooltip(attrs) {
	const a = attrs || {};
	const num = _pickAny(a, ["Permit number", "displayname"]);
	const type = _pickAny(a, ["Permit type", "permittype"]);
	const status = _pickAny(a, ["Permit sub-status", "permitstate", "Permit status", "permitstatus"]);
	const mineral = _pickAny(a, ["Mineral", "permitminerals"]);
	const holder = _pickAny(a, ["Authorised holder name", "authorisedholdername"]);

	const lines = [esc`<b>${num || "Historic mining title"}</b>`];
	const st = [type, status].filter(Boolean).join(" · ");
	if (st) lines.push(_escHtml(st));
	if (mineral) lines.push(_escHtml(mineral.replace(/,/g, ", ")));
	if (holder) lines.push(esc`<span class="dw-cad-sub">${holder}</span>`);
	return lines.join("<br>");
}

export function createQldMiningProviders({ makeHoverIdentify }) {
	const installLeasesHover = makeHoverIdentify({
		baseUrl:    CFG.QLD_LEASES_SERVICE,
		layers:     "all:" + CFG.QLD_LEASES_LAYER_IDS,
		tolerance:  4,
		minZoom:    CFG.QLD_LEASES_HOVER_MIN_ZOOM,
		tipClass:   "dw-qpws-tip",
		formatTooltip: _formatLeaseTooltip,
	});

	const HistoricLeasesLayerProvider = arcgisExportProvider({
		baseUrl: CFG.QLD_LEASES_SERVICE,
		showLayers: CFG.QLD_LEASES_LAYER_IDS,
		pane: "dwLeasesPane", paneZIndex: 393,
		opacity: 0.8, minZoom: 9, maxZoom: 25,
		attribution:
			'Mining permits &copy; <a href="https://georesglobe.information.qld.gov.au/" ' +
			'target="_blank" rel="noreferrer">State of Queensland (Resources)</a>',
		onAdd: (layer, map) => installLeasesHover(layer, map),
		onRemove: (layer) => {
			if (layer._dwHoverOff) { layer._dwHoverOff(); layer._dwHoverOff = null; }
		},
	});

	const installShaftsHover = makeHoverIdentify({
		baseUrl:    CFG.QLD_SHAFTS_SERVICE,
		layers:     "all:" + CFG.QLD_SHAFTS_LAYER_IDS,
		tolerance:  6,
		minZoom:    CFG.QLD_SHAFTS_HOVER_MIN_ZOOM,
		tipClass:   "dw-qpws-tip",
		formatTooltip: _formatShaftTooltip,
	});

	const MineShaftsLayerProvider = arcgisExportProvider({
		baseUrl: CFG.QLD_SHAFTS_SERVICE,
		showLayers: CFG.QLD_SHAFTS_LAYER_IDS,
		pane: "dwShaftsPane", paneZIndex: 400,
		opacity: 0.95, minZoom: 9, maxZoom: 25,
		attribution:
			'Abandoned mines &copy; <a href="https://georesglobe.information.qld.gov.au/" ' +
			'target="_blank" rel="noreferrer">State of Queensland (Resources)</a>',
		onAdd: (layer, map) => installShaftsHover(layer, map),
		onRemove: (layer) => {
			if (layer._dwHoverOff) { layer._dwHoverOff(); layer._dwHoverOff = null; }
		},
	});


	const installMinesHover = makeHoverIdentify({
		baseUrl:    CFG.QLD_MINING_SERVICE,
		layers:     "all:" + CFG.QLD_MINING_LAYER_IDS,
		tolerance:  8, // points need a wider grab than polygons
		minZoom:    CFG.QLD_MINING_HOVER_MIN_ZOOM,
		tipClass:   "dw-qpws-tip",
		formatTooltip: _formatMineTooltip,
	});

	const HistoricMinesLayerProvider = arcgisExportProvider({
		baseUrl: CFG.QLD_MINING_SERVICE,
		showLayers: CFG.QLD_MINING_LAYER_IDS,
		pane: "dwMiningPane", paneZIndex: 399,
		opacity: 0.95, minZoom: 8, maxZoom: 25,
		attribution:
			'Mines &copy; <a href="https://georesglobe.information.qld.gov.au/" ' +
			'target="_blank" rel="noreferrer">State of Queensland (GSQ)</a>',
		onAdd: (layer, map) => installMinesHover(layer, map),
		onRemove: (layer) => {
			if (layer._dwHoverOff) { layer._dwHoverOff(); layer._dwHoverOff = null; }
		},
	});

	return { HistoricMinesLayerProvider, MineShaftsLayerProvider, HistoricLeasesLayerProvider };
}
