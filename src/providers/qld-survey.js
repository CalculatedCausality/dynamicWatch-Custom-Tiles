import { CFG } from "../config.js";
import { arcgisExportProvider } from "../layers/provider-factories.js";
import { _escHtml, esc } from "../utils/html.js";

/* -- QLD Survey Marks -----------------------------------------------------
 * Queensland's survey control marks (Location/SurveyControl): brass
 * plaques, star pickets, bolts in concrete and trig stations, ~124k of
 * them, each with its condition, last visit, mark type, often a surveyed
 * height and a PDF report. The three "GDA coordinates" sublayers (datum,
 * derived, scaled) between them hold every mark once; they are redrawn
 * through `dynamicLayers` coloured by condition, with destroyed marks
 * left out. The server only draws them from about zoom 13.
 */

const FIELD = "sirpub.prop.qld_surveycontrol_scdb.mrkcnd_de";
const LAYERS = [3, 4, 16];
const WHERE = `${FIELD} <> 'Destroyed'`;

// Condition → colour. Anything not listed is drawn grey.
export const SURVEY_CONDITIONS = [
	{ value: "Good", rgb: [22, 163, 74] },
	{ value: "Not Found", rgb: [234, 88, 12] },
	{ value: "Disturbed", rgb: [202, 138, 4] },
	{ value: "Damaged", rgb: [202, 138, 4] },
	{ value: "Unstable", rgb: [202, 138, 4] },
	{ value: "Buried", rgb: [107, 114, 128] },
	{ value: "Submerged", rgb: [37, 99, 235] },
];

export function surveyDynamicLayers() {
	const sym = (rgb) => ({ type: "esriSMS", style: "esriSMSCircle", color: [...rgb, 235], size: 7,
		outline: { color: [255, 255, 255, 255], width: 1.2 } });
	const renderer = {
		type: "uniqueValue", field1: FIELD, defaultSymbol: sym([107, 114, 128]),
		uniqueValueInfos: SURVEY_CONDITIONS.map((c) => ({ value: c.value, label: c.value, symbol: sym(c.rgb) })),
	};
	return JSON.stringify(LAYERS.map((id) => ({
		id, source: { type: "mapLayer", mapLayerId: id }, definitionExpression: WHERE, drawingInfo: { renderer },
	})));
}

function _val(v) {
	if (v === null || v === undefined) return "";
	const s = String(v).trim();
	return s && !/^(null|none|unknown)$/i.test(s) ? s : "";
}

// "5/17/2025" (identify) or epoch ms → "2025"; "" otherwise.
export function _surveyYear(v) {
	const s = _val(v);
	if (!s) return "";
	if (/^\d{11,13}$/.test(s)) return String(new Date(Number(s)).getUTCFullYear());
	const m = /\b(1[89]\d\d|20\d\d)\b/.exec(s);
	return m ? m[1] : "";
}

// The report PDF, only when it is an https link on a Queensland Government host.
export function _surveyReportUrl(v) {
	const s = _val(v);
	if (!/^https:\/\//i.test(s) || /["\\\s]/.test(s)) return "";
	try {
		const u = new URL(s);
		return u.protocol === "https:" && (u.hostname === "qld.gov.au" || u.hostname.endsWith(".qld.gov.au")) &&
			!u.username && !u.password && !u.port ? u.href : "";
	} catch (_) { return ""; }
}

// Tooltip (and location pop-up row) for one mark. The report link only
// works in the pop-up, where it can be clicked.
export function _formatSurveyMark(attrs) {
	const a = attrs || {};
	const id = _val(a["Permanent mark"]);
	const name = _val(a["Alternate name 1"]);
	const type = _val(a["Mark type"]).replace(/^Other\s+/i, "");
	const cond = _val(a["Mark condition"]);
	const visited = _surveyYear(a["Last visit date"]);
	const installed = _surveyYear(a["Installed date"]);
	const by = _val(a["Installed by"]);
	const where = _val(a["Locality description"]);
	const height = Number(_val(a["AHD height"]));
	const report = _surveyReportUrl(a["Report link"] || a["Report Link"]);

	const title = name ? `${name} (PM ${id})` : (id ? `PM ${id}` : "Survey mark");
	const lines = [esc`<b>${title}</b>`];
	const kind = type ? type.charAt(0).toUpperCase() + type.slice(1).toLowerCase() : "";
	if (kind || where) lines.push(_escHtml([kind, where ? where.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : ""].filter(Boolean).join(" · ")));
	if (Number.isFinite(height) && _val(a["AHD height"])) lines.push(esc`Height ${height.toFixed(1)} m above sea level`);
	const state = [cond, visited ? `last visited ${visited}` : ""].filter(Boolean).join(", ");
	if (state) lines.push(cond && cond !== "Good" ? esc`<span class="dw-at-warn">${state}</span>` : _escHtml(state));
	const hist = [installed ? `installed ${installed}` : "", by ? `by ${by}` : ""].filter(Boolean).join(" ");
	if (hist) lines.push(esc`<span class="dw-cad-sub">${hist}</span>`);
	if (report) lines.push(esc`<a href="${report}" target="_blank" rel="noopener noreferrer">Survey report (PDF) ↗</a>`);
	return lines.join("<br>");
}

const LAYER_DEFS = Object.fromEntries(LAYERS.map((id) => [id, WHERE]));

// The overlay as an identify source, for the location pop-up.
export function surveyIdentifySource() {
	return { layerName: CFG.LAYER_SURVEY_MARKS, heading: "Survey marks", baseUrl: CFG.QLD_SURVEY_SERVICE,
		layers: "all:" + LAYERS.join(","), layerDefs: LAYER_DEFS, tolerance: 6,
		minZoom: CFG.QLD_SURVEY_MIN_ZOOM, format: _formatSurveyMark };
}

export function createQldSurveyProvider({ makeHoverIdentify }) {
	const src = surveyIdentifySource();
	const installHover = makeHoverIdentify({
		baseUrl: src.baseUrl, layers: src.layers, layerDefs: src.layerDefs, tolerance: 6,
		minZoom: CFG.QLD_SURVEY_MIN_ZOOM, tipClass: "dw-qpws-tip",
		// The tooltip cannot be clicked, so its report link is left to the pop-up.
		formatTooltip: (attrs) => _formatSurveyMark({ ...attrs, "Report link": "", "Report Link": "" }),
	});
	return arcgisExportProvider({
		baseUrl: CFG.QLD_SURVEY_SERVICE,
		extraParams: "&dynamicLayers=" + encodeURIComponent(surveyDynamicLayers()),
		pane: "dwSurveyPane", paneZIndex: 402,
		opacity: 1, minZoom: CFG.QLD_SURVEY_MIN_ZOOM, maxZoom: 25,
		attribution:
			'Survey marks &copy; <a href="https://www.qld.gov.au/environment/land/title/surveying" ' +
			'target="_blank" rel="noreferrer">State of Queensland (Resources)</a>',
		onAdd: (layer, map) => installHover(layer, map),
		onRemove: (layer) => { if (layer._dwHoverOff) { layer._dwHoverOff(); layer._dwHoverOff = null; } },
	});
}
