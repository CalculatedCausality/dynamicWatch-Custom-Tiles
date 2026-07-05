import { CFG } from "../config.js";
import { LayerProvider } from "../layers/provider-factories.js";
import { makeArcgisQueryLayer } from "./qld-environment.js";
import { gmJsonGet } from "../utils/http.js";
import { _escHtml, esc } from "../utils/html.js";

/* -- SCC Development / Building / Plumbing Applications ----------------
 * Sunshine Coast Council's Applications_SCRC MapServer only renders
 * attribute-less icon tiles through /export, but every sublayer is a
 * real Feature Layer with Query capability — so instead we pull the
 * application points as GeoJSON per viewport (same machinery as the
 * National Parks overlay) and render circle markers that carry the
 * application number, category, description and dates. Clicking a
 * marker opens a popup with the full record plus a deep link into
 * Development.i (FilterDirect?filters=DANumber%3D…).
 */

const PANE = "dwSccAppsPane";
const PANE_Z = 398; // above National Parks (397), below OIM water (400)

// Sublayer ids in Applications_SCRC. "live" = the In Progress layer of
// each pair; decided layers are huge (190k building apps) so they only
// query at close zoom and are ordered newest-first to survive the
// server's 2000-record cap meaningfully.
const _SUBLAYERS = [
	{ id: 0, kind: "DA", live: true  },
	{ id: 2, kind: "BA", live: true  },
	{ id: 4, kind: "PL", live: true  },
	{ id: 1, kind: "DA", live: false },
	{ id: 3, kind: "BA", live: false },
	{ id: 5, kind: "PL", live: false },
];

const _KIND = {
	DA: { label: "Development", color: "#8b5cf6", param: "DANumber"    },
	BA: { label: "Building",    color: "#f59e0b", param: "BANumber"    },
	PL: { label: "Plumbing",    color: "#0ea5e9", param: "PlumbNumber" },
};

const _APP_FIELDS =
	"ram_id,group_desc,category_desc,description,decision," +
	"progress,assessment_level,d_date_rec,d_decision_made";

// ArcGIS date fields arrive as epoch milliseconds (UTC midnight-ish in
// Brisbane time). Rendered in the viewer's locale — the audience is AEST.
export function _fmtSccDate(ms) {
	const n = Number(ms);
	if (!isFinite(n) || n <= 0) return "";
	const d = new Date(n);
	const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
		"Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
	return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

const _clip = (s, n) => {
	const t = String(s || "").trim().replace(/\s+/g, " ");
	return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

// Development.i deep link. FilterDirect serves the MapSearch page and
// the site's own JS applies the encoded `filters` querystring, focusing
// the map + result list on that application number. The id is validated
// before it's embedded in an href (external string → attribute sink).
export function _deviAppUrl(kind, ramId) {
	const meta = _KIND[kind];
	const id = String(ramId || "").trim();
	if (!meta || !id || !/^[A-Za-z0-9/\-. ]+$/.test(id)) return "";
	return (
		CFG.SCC_DEVI_BASE + "/Home/FilterDirect?filters=" +
		encodeURIComponent(meta.param + "=" + id)
	);
}

export function _formatSccTooltip(p, kind, live) {
	const meta = _KIND[kind];
	const lines = [];
	const status = live
		? (p.progress || "In Progress")
		: (p.decision || "Decided");
	lines.push(
		esc`<b>${p.ram_id || "Application"}</b> · ${meta.label} — ${status}`,
	);
	const cat = String(p.category_desc || "").trim();
	if (cat) lines.push(_escHtml(cat));
	const desc = _clip(p.description, 110);
	if (desc) lines.push(esc`<span class="dw-scc-sub">${desc}</span>`);
	const when = live
		? (p.d_date_rec ? "Lodged " + _fmtSccDate(p.d_date_rec) : "")
		: (p.d_decision_made ? "Decided " + _fmtSccDate(p.d_decision_made) : "");
	if (when) lines.push(esc`<span class="dw-scc-sub">${when}</span>`);
	return lines.join("<br>");
}

export function _formatSccPopup(p, kind, live) {
	const meta = _KIND[kind];
	const rows = [];
	rows.push(
		esc`<div class="dw-scc-pop-hd"><b>${p.ram_id || "Application"}</b>` +
		esc` <span class="dw-scc-sub">${meta.label} application</span></div>`,
	);
	const cat = String(p.category_desc || "").trim();
	const grp = String(p.group_desc || "").trim();
	if (cat || grp) {
		rows.push(esc`<div>${cat || grp}` +
			(cat && grp && grp !== cat
				? esc` <span class="dw-scc-sub">(${grp})</span>` : "") +
			"</div>");
	}
	const desc = _clip(p.description, 300);
	if (desc) rows.push(esc`<div class="dw-scc-pop-desc">${desc}</div>`);

	const bits = [];
	if (p.d_date_rec) bits.push("Lodged " + _fmtSccDate(p.d_date_rec));
	if (!live && p.d_decision_made)
		bits.push("Decided " + _fmtSccDate(p.d_decision_made));
	const status = live
		? (p.progress || "In Progress")
		: (p.decision || "");
	if (status) bits.push(status);
	if (bits.length)
		rows.push(esc`<div class="dw-scc-sub">${bits.join(" · ")}</div>`);

	const lvl = String(p.assessment_level || "").trim();
	if (lvl && lvl.toLowerCase() !== "other")
		rows.push(esc`<div class="dw-scc-sub">Assessment: ${lvl}</div>`);

	const url = _deviAppUrl(kind, p.ram_id);
	if (url) {
		rows.push(
			`<a class="dw-scc-link" href="${_escHtml(url)}"` +
			` target="_blank" rel="noreferrer">Open in Development.i ↗</a>`,
		);
	}
	return `<div class="dw-scc-pop">${rows.join("")}</div>`;
}

function _makeSubLayer(sub) {
	const meta = _KIND[sub.kind];
	return makeArcgisQueryLayer({
		label: `SCC ${meta.label} (${sub.live ? "in progress" : "decided"})`,
		pane: PANE,
		paneZIndex: PANE_Z,
		// In-progress sets are small council-wide (~600–3500 features);
		// decided sets run to 190k, so those wait for street-level zoom.
		minZoom: sub.live ? 13 : 16,
		queryUrl: `${CFG.SCC_APPS_SERVICE}/${sub.id}/query`,
		where: "1=1",
		outFields: _APP_FIELDS,
		orderBy: "d_date_rec DESC",
		pointToLayer: (f, latlng) =>
			L.circleMarker(latlng, {
				pane: PANE,
				radius: sub.live ? 6 : 4,
				color: sub.live ? "#ffffff" : meta.color,
				weight: sub.live ? 1.5 : 1,
				opacity: sub.live ? 0.9 : 0.5,
				fillColor: meta.color,
				fillOpacity: sub.live ? 0.85 : 0.35,
			}),
		tipClass: "dw-scc-tip",
		tooltip: (p) => _formatSccTooltip(p, sub.kind, sub.live),
		popup: (p) => _formatSccPopup(p, sub.kind, sub.live),
		popupOpts: { maxWidth: 320, className: "dw-scc-pop-wrap" },
		attribution:
			'Applications &copy; <a href="https://developmenti.sunshinecoast.qld.gov.au/"' +
			' target="_blank" rel="noreferrer">Sunshine Coast Council</a>',
	}, gmJsonGet);
}

export class SccApplicationsLayerProvider extends LayerProvider {
	create() {
		// One toggle, six viewport-query sublayers. Each child manages
		// its own fetch/debounce/zoom-gate; the group just add/removes
		// them together. 3D mode's recursive LayerGroup walker picks the
		// circle markers up as point features automatically.
		return L.layerGroup(_SUBLAYERS.map(_makeSubLayer));
	}
}
