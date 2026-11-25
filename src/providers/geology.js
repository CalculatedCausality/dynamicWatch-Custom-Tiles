import { CFG } from "../config.js";
import { arcgisExportProvider } from "../layers/provider-factories.js";
import { _escHtml, esc } from "../utils/html.js";

/* -- Geology ---------------------------------------------------------------
 * Geology (Australia): Geoscience Australia's Surface Geology service,
 *   lithology polygons at 1:2.5M (zoomed out, layer 4) and 1:1M (layer 11),
 *   the server choosing by scale, in GA's own rock-type colours.
 * Geology (QLD detailed): Queensland's 1:100,000 detailed surface geology
 *   (GeoscientificInformation/GeologyDetailed, layer 15) with faults and
 *   shear zones (layer 4), in the survey's own map colours.
 * Hover and the location pop-up name the rock unit, the rock in plain
 * words and its age, with a rough age in millions of years.
 */

// Geological periods and eras, youngest first: [name, start Ma, end Ma].
const PERIODS = [
	["holocene", 0.012, 0], ["pleistocene", 2.6, 0.012], ["quaternary", 2.6, 0], ["pliocene", 5.3, 2.6],
	["miocene", 23, 5.3], ["neogene", 23, 2.6], ["oligocene", 34, 23], ["eocene", 56, 34], ["paleocene", 66, 56],
	["palaeocene", 66, 56], ["paleogene", 66, 23], ["palaeogene", 66, 23], ["tertiary", 66, 2.6], ["cainozoic", 66, 0],
	["cenozoic", 66, 0], ["cretaceous", 145, 66], ["jurassic", 201, 145], ["triassic", 252, 201], ["mesozoic", 252, 66],
	["permian", 299, 252], ["carboniferous", 359, 299], ["devonian", 419, 359], ["silurian", 444, 419],
	["ordovician", 485, 444], ["cambrian", 539, 485], ["palaeozoic", 539, 252], ["paleozoic", 539, 252],
	["neoproterozoic", 1000, 539], ["mesoproterozoic", 1600, 1000], ["paleoproterozoic", 2500, 1600],
	["palaeoproterozoic", 2500, 1600], ["proterozoic", 2500, 539], ["neoarchean", 2800, 2500],
	["mesoarchean", 3200, 2800], ["archean", 4000, 2500], ["archaean", 4000, 2500],
];

const fmtMa = (ma) => ma >= 1000 ? `${(ma / 1000).toFixed(ma >= 10000 ? 0 : 1)} billion` : ma >= 1 ? `${Math.round(ma)} million` : `${Math.round(ma * 1000)} thousand`;

// "Late Triassic to Early Jurassic" → "about 252–145 million years old"; ""
// when no period is named. Uses the whole span of the periods mentioned.
export function geologyAgeYears(text) {
	const t = String(text || "").toLowerCase();
	let oldest = 0, youngest = Infinity;
	for (const [name, start, end] of PERIODS) {
		if (!new RegExp(`\\b${name}\\b`).test(t)) continue;
		oldest = Math.max(oldest, start);
		youngest = Math.min(youngest, end);
	}
	if (!oldest) return "";
	if (youngest < 0.02) return `up to about ${fmtMa(oldest)} years old`;
	return `about ${fmtMa(oldest).replace(/ (million|billion|thousand)$/, "")}–${fmtMa(youngest)} years old`;
}

const _val = (v) => { const s = v == null ? "" : String(v).trim(); return s && !/^(null|none|-999)$/i.test(s) ? s : ""; };
const sentence = (s) => { const t = _val(s); if (!t) return ""; return t === t.toUpperCase() ? t.charAt(0) + t.slice(1).toLowerCase() : t; };
const clip = (s, n) => { const t = _val(s); return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t; };

export function _formatGaGeology(attrs) {
	const a = attrs || {};
	// Unnamed units carry an internal record number: "mafic volcanic rocks 38495".
	const name = _val(a.name).replace(/\s+\d{3,}$/, "");
	const rock = _val(a.lithology).replace(/;\s*/g, ", ");
	const age = _val(a.geologicHistory);
	const desc = clip(a.description, 180);
	const lines = [esc`<b>${name || "Rock unit"}</b>`];
	if (rock) lines.push(_escHtml(rock.charAt(0).toUpperCase() + rock.slice(1)));
	const years = geologyAgeYears(age);
	if (age) lines.push(_escHtml(years ? `${age} (${years})` : age));
	if (desc) lines.push(esc`<span class="dw-cad-sub">${desc}</span>`);
	return lines.join("<br>");
}

export function _formatQldGeology(attrs) {
	const a = attrs || {};
	const name = _val(a["Rock Unit Name"]).replace(/-SEQ$/, "");
	const rock = sentence(a["Dominant Rock"]);
	const summary = clip(a["Lithological Summary"], 180);
	const age = sentence(a.Age);
	// A bare map code ("Tv") is not a name: lead with the rock instead.
	const codeOnly = name && !/\s/.test(name) && name.length <= 6;
	const lines = [esc`<b>${codeOnly ? `${rock || "Rock unit"} (${name})` : name || rock || "Rock unit"}</b>`];
	if (rock && !codeOnly && name) lines.push(_escHtml(rock));
	const years = geologyAgeYears(age);
	if (age) lines.push(_escHtml(years ? `${age} (${years})` : age));
	if (summary && summary.toLowerCase() !== rock.toLowerCase()) lines.push(esc`<span class="dw-cad-sub">${summary}</span>`);
	return lines.join("<br>");
}

export function geologyIdentifySources() {
	return [
		{ layerName: CFG.LAYER_GEOLOGY_QLD, heading: "Geology (QLD detailed)", baseUrl: CFG.QLD_GEOLOGY_SERVICE,
			layers: "visible:15", tolerance: 0, minZoom: 9, format: _formatQldGeology },
		{ layerName: CFG.LAYER_GEOLOGY_AU, heading: "Geology", baseUrl: CFG.GA_GEOLOGY_SERVICE,
			layers: "visible:4,11", tolerance: 0, minZoom: 5, format: _formatGaGeology },
	];
}

export function createGeologyProviders({ makeHoverIdentify }) {
	const [qld, au] = geologyIdentifySources();
	const off = (layer) => { if (layer._dwHoverOff) { layer._dwHoverOff(); layer._dwHoverOff = null; } };
	const hover = (src) => makeHoverIdentify({ baseUrl: src.baseUrl, layers: src.layers, tolerance: 0,
		minZoom: src.minZoom, tipClass: "dw-qpws-tip", formatTooltip: src.format });
	const installAu = hover(au), installQld = hover(qld);
	const GeologyAustraliaProvider = arcgisExportProvider({
		baseUrl: CFG.GA_GEOLOGY_SERVICE, showLayers: "4,11",
		pane: "dwGeologyAuPane", paneZIndex: 381, opacity: 0.55, minZoom: 4, maxZoom: 25,
		attribution: 'Surface geology &copy; <a href="https://www.ga.gov.au/" target="_blank" rel="noreferrer">Geoscience Australia</a> (CC BY 4.0)',
		onAdd: (layer, map) => installAu(layer, map), onRemove: off,
	});
	const GeologyQldProvider = arcgisExportProvider({
		baseUrl: CFG.QLD_GEOLOGY_SERVICE, showLayers: "15,4",
		pane: "dwGeologyQldPane", paneZIndex: 382, opacity: 0.6, minZoom: 9, maxZoom: 25,
		attribution: 'Detailed geology &copy; <a href="https://www.data.qld.gov.au/" target="_blank" rel="noreferrer">State of Queensland (Geological Survey of Queensland)</a>',
		onAdd: (layer, map) => installQld(layer, map), onRemove: off,
	});
	return { GeologyAustraliaProvider, GeologyQldProvider };
}
