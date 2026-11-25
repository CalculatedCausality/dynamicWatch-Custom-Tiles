import { CFG } from "../config.js";
import { arcgisExportProvider } from "../layers/provider-factories.js";
import { _escHtml, esc } from "../utils/html.js";

/* -- QLD Tracks ------------------------------------------------------------
 * The tracks and walkways in Queensland's state road network
 * (Transportation/RoadsAndTracks, layer 10): fire trails, forestry breaks,
 * 4WD tracks and walking tracks, many of them missing from street maps.
 * Roads are left out. The layer is redrawn through `dynamicLayers` as five
 * passes over the same source, each with its own filter and line, so the
 * colour says what the track is for and whether you may use it.
 * (The auto-added "QLD Roads" layer draws every road and track in the
 * server's own style, only over QLD imagery, with no hover.)
 */

const TRACKS = "class IN ('Track','Walkway')";
const OPEN = "(user_access IS NULL OR user_access NOT IN ('Private','Restricted'))";
const NOT_FOOT = "(sub_class IS NULL OR sub_class <> 'Non vehicular track')";

// [label, filter, colour, ArcGIS line style, width]. The first is drawn on top.
export const TRACK_KINDS = [
	["Private or restricted", `${TRACKS} AND user_access IN ('Private','Restricted')`, [220, 38, 38], "esriSLSDash", 1.5],
	["Closed", `${TRACKS} AND ${OPEN} AND trafficability = 'Closed'`, [220, 38, 38], "esriSLSDot", 2],
	["Walking", `${OPEN} AND ((class = 'Track' AND (trafficability IN ('Pedestrian','Horse','Shared') OR sub_class = 'Non vehicular track')) OR class = 'Walkway')`, [22, 163, 74], "esriSLSDash", 2.25],
	["Vehicle", `class = 'Track' AND ${OPEN} AND trafficability IN ('4WD','2WD','Regular vehicle') AND ${NOT_FOOT}`, [146, 64, 14], "esriSLSDash", 2.25],
	["Other", `class = 'Track' AND ${OPEN} AND (trafficability IS NULL OR trafficability = 'Unknown') AND ${NOT_FOOT}`, [120, 113, 108], "esriSLSDash", 1.75],
];

export function tracksDynamicLayers() {
	return JSON.stringify(TRACK_KINDS.map(([label, where, rgb, style, width], i) => ({
		id: 101 + i,
		source: { type: "mapLayer", mapLayerId: CFG.QLD_TRACKS_LAYER_ID },
		definitionExpression: where,
		drawingInfo: { renderer: { type: "simple", label, symbol: { type: "esriSLS", style, color: [...rgb, 235], width } }, showLabels: false },
	})));
}

function _val(v) {
	if (v === null || v === undefined) return "";
	const s = String(v).trim();
	return s && !/^(null|none|unknown|na)$/i.test(s) ? s : "";
}

const OWNERS = {
	LG: "the local council", QPWS: "Queensland Parks and Wildlife Service",
	TMR: "Transport and Main Roads", Private: "a private owner",
};
const USES = {
	Pedestrian: "Walking track", Horse: "Horse track", Shared: "Shared track (walk, ride)",
	"4WD": "4WD track", "2WD": "2WD track", "Regular vehicle": "Vehicle track", Closed: "Closed track",
};

// Hover / location pop-up row for one track.
export function _formatTrack(attrs) {
	const a = attrs || {};
	const cls = _val(a.Class);
	const sub = _val(a["Sub class"]);
	const traffic = _val(a.Trafficability);
	const access = _val(a["User access"]);
	const owner = _val(a["Road owner"]);
	const maintainer = _val(a["Road maintainer"]);
	const name = _val(a["Full road name"]);
	const alias = _val(a["Road name alias (1)"]);

	const kind = cls === "Walkway" ? "Walkway"
		: USES[traffic] || (sub === "Non vehicular track" ? "Walking track" : sub === "4WD" ? "4WD track" : "Track");
	// "Track" and "Break" on their own are not names.
	const named = name && !/^(track|break|fire ?break|walkway)$/i.test(name) ? name : "";
	const lines = [esc`<b>${named || kind}</b>`];
	if (named) lines.push(_escHtml(kind));
	if (alias && alias !== named) lines.push(esc`Also known as ${alias}`);
	if (access === "Private" || access === "Restricted") lines.push(esc`<span class="dw-at-warn">${access} access</span>`);
	else if (traffic === "Closed") lines.push(`<span class="dw-at-warn">Closed</span>`);
	// Seasonality "F": fair-weather only (tracks); "U": all-weather.
	if (_val(a.Seasonality) === "F") lines.push("Fair-weather track");
	const care = [
		OWNERS[owner] ? `owned by ${OWNERS[owner]}` : "",
		maintainer === "Unmaintained" ? "not maintained" : "",
	].filter(Boolean).join(", ");
	if (care) lines.push(esc`<span class="dw-cad-sub">${care.charAt(0).toUpperCase() + care.slice(1)}</span>`);
	return lines.join("<br>");
}

const LAYER_DEFS = { [CFG.QLD_TRACKS_LAYER_ID]: TRACKS };

export function tracksIdentifySource() {
	return { layerName: CFG.LAYER_QLD_TRACKS, heading: "Tracks", baseUrl: CFG.QLD_TRACKS_SERVICE,
		layers: "all:" + CFG.QLD_TRACKS_LAYER_ID, layerDefs: LAYER_DEFS, tolerance: 5,
		minZoom: CFG.QLD_TRACKS_MIN_ZOOM, format: _formatTrack };
}

export function createQldTracksProvider({ makeHoverIdentify }) {
	const src = tracksIdentifySource();
	const installHover = makeHoverIdentify({
		baseUrl: src.baseUrl, layers: src.layers, layerDefs: src.layerDefs, tolerance: 5,
		minZoom: CFG.QLD_TRACKS_MIN_ZOOM, tipClass: "dw-qpws-tip", formatTooltip: _formatTrack,
	});
	return arcgisExportProvider({
		baseUrl: CFG.QLD_TRACKS_SERVICE,
		extraParams: "&dynamicLayers=" + encodeURIComponent(tracksDynamicLayers()),
		pane: "dwTracksPane", paneZIndex: 412,
		opacity: 1, minZoom: CFG.QLD_TRACKS_MIN_ZOOM, maxZoom: 25,
		attribution:
			'Tracks &copy; <a href="https://www.data.qld.gov.au/" ' +
			'target="_blank" rel="noreferrer">State of Queensland (Resources)</a>',
		onAdd: (layer, map) => installHover(layer, map),
		onRemove: (layer) => { if (layer._dwHoverOff) { layer._dwHoverOff(); layer._dwHoverOff = null; } },
	});
}
