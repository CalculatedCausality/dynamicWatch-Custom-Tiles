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

// A four-digit year from an /identify date ("6/14/1872") or epoch ms; "" when
// there is none. Years outside 1800–2100 are placeholders, not dates.
export function _mineYear(value) {
	const v = _mineVal(value);
	if (!v) return "";
	let year = "";
	if (/^-?\d{9,}$/.test(v)) year = String(new Date(Number(v)).getUTCFullYear());
	else year = (/(?:^|\D)(\d{4})(?:\D|$)/.exec(v) || [])[1] || "";
	return year >= "1800" && year <= "2100" ? year : "";
}

// "Au(vs);Ag(vs)" → "Au, Ag": every commodity recorded at the site.
function _allCommodities(value) {
	return _mineVal(value).split(/[;,]/).map((c) => c.replace(/\(.*?\)/g, "").trim()).filter(Boolean).join(", ");
}

export function _formatMineTooltip(attrs) {
	const a = attrs || {};
	const name      = _pickAny(a, ["Occurrence name", "occur_name"]);
	const commodity = _pickAny(a, ["Main commodity", "main_commodity"]);
	const status    = _pickAny(a, ["Mine status", "mine_status"]);
	const size      = _pickAny(a, ["Deposit size", "deposit_size"]);
	const locality  = _pickAny(a, ["site locality", "Site locality", "site_locality"]);
	const kind      = _pickAny(a, ["Group name", "group_name", "Site type", "site_type"]);
	const all       = _allCommodities(_pickAny(a, ["All commodities", "all_commodities"]));
	const workings  = _pickAny(a, ["Work extent", "work_extent"]);
	const accuracy  = Number(_pickAny(a, ["Location accuracy (m)", "loc_accuracy"]));
	const recorded  = _mineYear(_pickAny(a, ["Date recorded", "date_recorded"]));

	const lines = [esc`<b>${name || "Historic mine"}</b>`];
	const bits = [commodity, status, size].filter(Boolean);
	if (bits.length) lines.push(_escHtml(bits.join(" · ")));
	// Only worth a line when the site has more than its main commodity.
	if (all.includes(",")) lines.push(esc`Also recorded: ${all}`);
	if (workings)    lines.push(esc`Workings: ${workings.toLowerCase()}`);
	if (locality)    lines.push(_escHtml(locality));
	// These sites were mostly placed from old maps: say how far off the dot may be.
	if (accuracy >= 50) lines.push(esc`<span class="dw-cad-sub">Position within about ${Math.round(accuracy)} m</span>`);
	const sub = [kind, recorded ? "recorded " + recorded : ""].filter(Boolean).join(" · ");
	if (sub)         lines.push(esc`<span class="dw-cad-sub">${sub}</span>`);
	return lines.join("<br>");
}

// What each abandoned-mine layer is, for features that carry no type of
// their own (keyed by the /identify layer id).
const SHAFT_LAYER_KINDS = {
	44: "Mine vent", 60: "Remediated opening", 62: "Underground workings", 63: "Underground workings",
	70: "Mineral material", 85: "Pit", 90: "Tailings", 95: "Mineral material",
	105: "Shallow workings", 110: "Mine openings",
};

// Abandoned-mine physical features (shafts, adits, pits, tailings and the
// mapped extent of underground workings). Layer 45 keys by "Type"/"Mine
// Name"/"Commodity"/"Remediation Status"; the survey layers key by "Feature
// Sub Type"/"Feature Remediated"/"Year of Works" — read every form.
export function _formatShaftTooltip(attrs, feature) {
	const a = attrs || {};
	const layerKind = feature && SHAFT_LAYER_KINDS[feature.layerId];
	const type = _pickAny(a, ["Type", "feature_type", "Feature Sub Type", "Feature Subtype", "ftr_sub",
		"Vent Construction"]);
	const mine = _pickAny(a, ["Mine Name", "mine_name", "Feature Name", "ftr_name"]);
	const commodity = _pickAny(a, ["Commodity", "commodity", "Mine Seam", "mine_seam"]);
	const rem = _pickAny(a, ["Remediation Status", "rem_status", "Feature Remediated", "ftr_rehab",
		"Feature Rehabilitated?"]);
	const worksYear = _mineYear(_pickAny(a, ["Year of Works", "rehab_yr"]));

	// "Underground workings — shaft": the layer says what it is, the type refines it.
	const title = layerKind && type && type.toLowerCase() !== layerKind.toLowerCase()
		? `${layerKind} — ${type}` : (type || layerKind || "Mine opening");
	const lines = [esc`<b>${title}</b>`];
	// mine_name is frequently "Unknown" — drop it rather than show noise.
	const named = mine && mine.toLowerCase() !== "unknown" ? mine : "";
	const bits = [named, commodity].filter(Boolean);
	if (bits.length) lines.push(_escHtml(bits.join(" · ")));
	// "None"/"No" mean nothing was done; only a real status is worth showing.
	const status = /^(none|no|n)$/i.test(rem) ? "" : (/^(yes|y)$/i.test(rem) ? "Remediated" : rem);
	const sub = [status, worksYear ? "works " + worksYear : ""].filter(Boolean).join(" · ");
	if (sub) lines.push(esc`<span class="dw-cad-sub">${sub}</span>`);
	return lines.join("<br>");
}

const LEASE_TYPES = { ML: "Mining lease", MC: "Mining claim", MDL: "Mineral development licence", MFS: "Mineral freehold selection" };

// Historic mining titles: lease/claim footprints (ML/MC/MDL) and the points
// that stand for older leases with no surveyed outline, most from the
// 1870s–1930s. /identify aliases, polygons: displayname→"Permit number",
// permittype→"Permit type", permitstate→"Permit sub-status",
// permitminerals→"Mineral", authorisedholdername→"Authorised holder name",
// "Lodge date"/"Grant date"/"Non-current date". Points: "Permit type" is the
// abbreviation, plus "Name", "Previous permit number" (the number it had at
// the time, e.g. GML95GYMP) and "Expiry date".
export function _formatLeaseTooltip(attrs) {
	const a = attrs || {};
	const num = _pickAny(a, ["Permit number", "displayname", "tenurenum"]);
	const rawType = _pickAny(a, ["Permit type", "permittype", "tenuretype"]);
	const type = LEASE_TYPES[rawType] || rawType;
	const status = _pickAny(a, ["Permit sub-status", "permitstate", "Permit status", "permitstatus"]);
	const mineral = _pickAny(a, ["Mineral", "permitminerals", "minerals"]);
	const holder = _pickAny(a, ["Authorised holder name", "authorisedholdername"]);
	const name = _pickAny(a, ["Name", "name", "Permit name", "permitname"]);
	const previous = _pickAny(a, ["Previous permit number", "previouspermits", "prev_ten_n"]);
	const from = _mineYear(_pickAny(a, ["Grant date", "approvedate", "date_grant"])) ||
		_mineYear(_pickAny(a, ["Lodge date", "lodgedate", "lodge_date"]));
	const to = _mineYear(_pickAny(a, ["Non-current date", "noncurrentdate", "Expiry date", "date_nc"]));

	// A bare number ("230671") reads better with its type in front.
	const title = /^\d+$/.test(num) && LEASE_TYPES[rawType] ? `${rawType} ${num}` : num;
	const lines = [esc`<b>${name || title || "Historic mining title"}</b>`];
	if (name && title) lines.push(_escHtml(title));
	const st = [type, status].filter(Boolean).join(" · ");
	if (st) lines.push(_escHtml(st));
	const years = from && to && from !== to ? `${from}–${to}` : (from || to);
	const facts = [years, mineral.replace(/,/g, ", ")].filter(Boolean).join(" · ");
	if (facts) lines.push(_escHtml(facts));
	if (previous) lines.push(esc`<span class="dw-cad-sub">Formerly ${previous}</span>`);
	if (holder) lines.push(esc`<span class="dw-cad-sub">${holder}</span>`);
	return lines.join("<br>");
}

// The three mining overlays as identify sources, for the location pop-up.
export function miningIdentifySources() {
	return [
		{ layerName: CFG.LAYER_HIST_MINES, heading: "Historic mines", baseUrl: CFG.QLD_MINING_SERVICE,
			layers: "all:" + CFG.QLD_MINING_LAYER_IDS, tolerance: 8, minZoom: CFG.QLD_MINING_HOVER_MIN_ZOOM, format: _formatMineTooltip },
		{ layerName: CFG.LAYER_MINE_SHAFTS, heading: "Shafts and workings", baseUrl: CFG.QLD_SHAFTS_SERVICE,
			layers: "all:" + CFG.QLD_SHAFTS_LAYER_IDS, tolerance: 6, minZoom: CFG.QLD_SHAFTS_HOVER_MIN_ZOOM, format: _formatShaftTooltip },
		{ layerName: CFG.LAYER_MINE_LEASES, heading: "Historic mining titles", baseUrl: CFG.QLD_LEASES_SERVICE,
			layers: "all:" + CFG.QLD_LEASES_LAYER_IDS, tolerance: 4, minZoom: CFG.QLD_LEASES_HOVER_MIN_ZOOM, format: _formatLeaseTooltip },
		{ layerName: CFG.LAYER_LEASE_POINTS, heading: "Old leases", baseUrl: CFG.QLD_LEASES_SERVICE,
			layers: "all:" + CFG.QLD_LEASE_POINTS_LAYER_IDS, tolerance: 8, minZoom: CFG.QLD_LEASE_POINTS_MIN_ZOOM, format: _formatLeaseTooltip },
	];
}

const MINING_SECTION_MAX = 12;

// Pop-up section listing every identify result for one mining overlay.
// The same feature can come back from two sublayers: list it once.
export function _miningSectionHtml(src, results) {
	const seen = new Set();
	const rows = [];
	for (const r of results || []) {
		const html = src.format(r.attributes || {}, r);
		if (seen.has(html)) continue;
		seen.add(html);
		rows.push(`<div class="dw-mine-row">${html}</div>`);
	}
	if (!rows.length) return "";
	const more = rows.length > MINING_SECTION_MAX ? `<div class="dw-cad-sub">and ${rows.length - MINING_SECTION_MAX} more: zoom in to separate them</div>` : "";
	return `<div class="dw-mine-hd">${_escHtml(src.heading)} here (${rows.length})</div>` +
		`<div class="dw-mine-list">${rows.slice(0, MINING_SECTION_MAX).join("")}${more}</div>`;
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

	const installLeasePointsHover = makeHoverIdentify({
		baseUrl:    CFG.QLD_LEASES_SERVICE,
		layers:     "all:" + CFG.QLD_LEASE_POINTS_LAYER_IDS,
		tolerance:  8,
		minZoom:    CFG.QLD_LEASE_POINTS_MIN_ZOOM,
		tipClass:   "dw-qpws-tip",
		formatTooltip: _formatLeaseTooltip,
	});

	const LeasePointsLayerProvider = arcgisExportProvider({
		baseUrl: CFG.QLD_LEASES_SERVICE,
		showLayers: CFG.QLD_LEASE_POINTS_LAYER_IDS,
		pane: "dwLeasePointsPane", paneZIndex: 394,
		opacity: 0.9, minZoom: CFG.QLD_LEASE_POINTS_MIN_ZOOM, maxZoom: 25,
		attribution:
			'Mining permits &copy; <a href="https://georesglobe.information.qld.gov.au/" ' +
			'target="_blank" rel="noreferrer">State of Queensland (Resources)</a>',
		onAdd: (layer, map) => installLeasePointsHover(layer, map),
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

	return { HistoricMinesLayerProvider, MineShaftsLayerProvider, HistoricLeasesLayerProvider, LeasePointsLayerProvider };
}
