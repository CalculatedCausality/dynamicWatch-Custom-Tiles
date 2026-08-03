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

export function createQldMiningProviders({ makeHoverIdentify }) {
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

	return { HistoricMinesLayerProvider };
}
