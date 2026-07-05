import { CFG } from "../config.js";
import { LayerProvider } from "../layers/provider-factories.js";
import { makeArcgisQueryLayer } from "./qld-environment.js";
import { _CACHE_TTL, cachedFetch, gmGet, gmJsonGet } from "../utils/http.js";
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

// Sublayer ids in Applications_SCRC: each kind is an (In Progress,
// Decided) pair. Decided layers are huge (190k building apps) so they
// only query at close zoom and are ordered newest-first to survive the
// server's 2000-record cap meaningfully.
const _KIND = {
	DA: { liveId: 0, pastId: 1, label: "Development", color: "#8b5cf6", param: "DANumber"    },
	BA: { liveId: 2, pastId: 3, label: "Building",    color: "#f59e0b", param: "BANumber"    },
	PL: { liveId: 4, pastId: 5, label: "Plumbing",    color: "#0ea5e9", param: "PlumbNumber" },
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

/* -- Development.i deep detail (assessment stages, parcels) ------------
 * /Home/ApplicationDetail is Development.i's own AJAX fragment (the
 * modal it opens when you click an application). It's served without
 * session/cookies; `type` is the WMS layer name + "_unique" and `id`
 * is the application number. We parse the fragment down to text-only
 * facts (never inject its HTML) and render them into the popup when
 * it opens — mirroring the cadastre popup's inline sales auto-load.
 */

const _DEVI_TYPE = {
	DA: "plan_scc_development_apps_unique",
	BA: "plan_scc_building_apps_unique",
	PL: "plan_scc_plumbing_apps_unique",
};

export function _deviDetailUrl(kind, ramId) {
	const type = _DEVI_TYPE[kind];
	const id = String(ramId || "").trim();
	if (!type || !id || !/^[A-Za-z0-9/\-. ]+$/.test(id)) return "";
	return (
		CFG.SCC_DEVI_BASE + "/Home/ApplicationDetail?type=" + type +
		"&id=" + encodeURIComponent(id)
	);
}

// Tag-strip + entity-decode for text pulled out of the detail fragment.
// The result is still treated as untrusted (escaped again on render).
function _deviText(s) {
	return String(s || "")
		.replace(/<[^>]*>/g, " ")
		.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
		.replace(/\s+/g, " ").trim();
}

// Regex-parse the fragment (regular, machine-generated markup) instead
// of DOMParser so the pure helper also runs in the unit-test sandbox.
export function _parseSccDetailHtml(html) {
	const h = String(html || "");
	const out = { properties: [], stages: [] };

	// Associated properties: anchor per parcel address.
	const propRe = /PropertyDetailsView\?landNumber=\d+'[^>]*>([^<]+)</g;
	let m;
	while ((m = propRe.exec(h))) {
		const addr = _deviText(m[1]);
		if (addr) out.properties.push(addr);
	}

	// Assessment stages table: <tr> with desc/decision cells and a
	// data-date-number date cell. Every cell carries a (?!<\/tr>) guard
	// so a match can never span rows — without it the dateless thead
	// row backtracks its cells across `</tr>` and splices itself onto
	// the first data row's date cell.
	const cell = "((?:(?!<\\/tr>)[\\s\\S])*?)";
	const rowRe = new RegExp(
		"<tr>\\s*<td>" + cell + "<\\/td>\\s*<td>" + cell + "<\\/td>\\s*" +
		'<td>(?:(?!<\\/tr>)[\\s\\S])*?data-date-number="(\\d+)"',
		"g",
	);
	while ((m = rowRe.exec(h))) {
		const desc = _deviText(m[1]);
		if (!desc) continue;
		out.stages.push({
			desc,
			decision: _deviText(m[2]),
			dateMs: Number(m[3]) || 0,
		});
	}
	return out;
}

export function _renderSccDetail(d) {
	if (!d || (!d.properties.length && !d.stages.length)) {
		return '<span class="dw-scc-sub">No further detail available.</span>';
	}
	const bits = [];
	if (d.properties.length) {
		const shown = d.properties.slice(0, 3).map(_escHtml).join("<br>");
		const extra = d.properties.length > 3
			? esc`<br><span class="dw-scc-sub">+${d.properties.length - 3} more</span>`
			: "";
		bits.push(
			`<div class="dw-scc-det-sec"><b>Properties</b><br>${shown}${extra}</div>`,
		);
	}
	if (d.stages.length) {
		const rows = d.stages.map((s) => {
			const when = s.dateMs > 0 ? _fmtSccDate(s.dateMs) : "";
			const right = [s.decision, when].filter(Boolean).join(" · ");
			return (
				esc`<div class="dw-scc-stage"><span class="dw-scc-stage-desc">${s.desc}</span>` +
				(right ? esc`<span class="dw-scc-stage-val">${right}</span>` : "") +
				"</div>"
			);
		}).join("");
		bits.push(
			`<div class="dw-scc-det-sec"><b>Assessment stages</b>` +
			`<div class="dw-scc-stages">${rows}</div></div>`,
		);
	}
	return bits.join("");
}

export function fetchSccDetail(kind, ramId, cb) {
	const url = _deviDetailUrl(kind, ramId);
	if (!url) { cb(null); return; }
	cachedFetch(
		"scc_detail_" + kind + "_" + ramId,
		_CACHE_TTL.SCC_DETAIL,
		(done) => gmGet(
			url,
			{ headers: { "X-Requested-With": "XMLHttpRequest", Accept: "text/html" } },
			(err, r) => {
				if (err || !r || r.status < 200 || r.status >= 300) {
					// Transient failure → don't persist (poisoned-cache
					// lesson from the OnTheHouse pipeline).
					done(err || new Error("http " + (r && r.status)), undefined);
					return;
				}
				const parsed = _parseSccDetailHtml(r.responseText);
				// Persist even an empty parse (as null) — a structurally
				// empty page won't grow rows within the TTL.
				done(null, (parsed.properties.length || parsed.stages.length)
					? parsed : null);
			},
		),
		(err, v) => cb(err ? null : v),
	);
}

// popupopen listener installed while the overlay is on the map: fills
// the .dw-scc-detail placeholder in whichever application popup opened.
function _onSccPopupOpen(e) {
	const el = e.popup && e.popup.getElement && e.popup.getElement();
	const slot = el && el.querySelector(".dw-scc-detail");
	if (!slot || slot.dataset.dwDone) return;
	slot.dataset.dwDone = "1";
	fetchSccDetail(slot.dataset.sccKind, slot.dataset.sccId, (detail) => {
		if (!slot.isConnected) return;
		slot.innerHTML = _renderSccDetail(detail);
	});
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

	// Deep-detail slot (assessment stages, associated parcels) — filled
	// asynchronously by the popupopen listener via fetchSccDetail.
	const id = String(p.ram_id || "").trim();
	if (_deviDetailUrl(kind, id)) {
		rows.push(
			`<div class="dw-scc-detail" data-scc-kind="${kind}"` +
			` data-scc-id="${_escHtml(id)}">` +
			'<span class="dw-scc-sub">Loading Development.i detail…</span></div>',
		);
	}

	const url = _deviAppUrl(kind, p.ram_id);
	if (url) {
		rows.push(
			`<a class="dw-scc-link" href="${_escHtml(url)}"` +
			` target="_blank" rel="noreferrer">Open in Development.i ↗</a>`,
		);
	}
	return `<div class="dw-scc-pop">${rows.join("")}</div>`;
}

function _makeSubLayer(kind, live) {
	const meta = _KIND[kind];
	return makeArcgisQueryLayer({
		label: `SCC ${meta.label} (${live ? "current" : "decided"})`,
		pane: PANE,
		paneZIndex: PANE_Z,
		// In-progress sets are small council-wide (~600–3500 features);
		// decided sets run to 190k, so those wait for street-level zoom.
		minZoom: live ? 13 : 16,
		queryUrl: `${CFG.SCC_APPS_SERVICE}/${live ? meta.liveId : meta.pastId}/query`,
		where: "1=1",
		outFields: _APP_FIELDS,
		orderBy: "d_date_rec DESC",
		pointToLayer: (f, latlng) =>
			L.circleMarker(latlng, {
				pane: PANE,
				radius: live ? 6 : 4,
				color: live ? "#ffffff" : meta.color,
				weight: live ? 1.5 : 1,
				opacity: live ? 0.9 : 0.5,
				fillColor: meta.color,
				fillOpacity: live ? 0.85 : 0.35,
			}),
		tipClass: "dw-scc-tip",
		tooltip: (p) => _formatSccTooltip(p, kind, live),
		popup: (p) => _formatSccPopup(p, kind, live),
		popupOpts: { maxWidth: 320, className: "dw-scc-pop-wrap" },
		attribution:
			'Applications &copy; <a href="https://developmenti.sunshinecoast.qld.gov.au/"' +
			' target="_blank" rel="noreferrer">Sunshine Coast Council</a>',
	}, gmJsonGet);
}

/* -- Sublayer selection state + on-map submenu -------------------------
 * The layer panel gets ONE "SCC Applications" entry; while it's on, a
 * small panel in the map corner picks which sublayers render
 * (dev/building/plumbing × current/decided). Defaults to the three
 * "current" sets so what's live is obvious; decided sets layer on top
 * as small muted dots when wanted. Selection persists in GM storage.
 */

// One flag per application type plus two status flags that apply
// across all types: a sublayer renders iff its type AND its status are
// both ticked. "current" = the In Progress sets, "past" = Decided.
export function _sccDefaultState() {
	return { DA: true, BA: true, PL: true, live: true, past: false };
}

export function _sccLoadState() {
	const state = _sccDefaultState();
	try {
		const saved = JSON.parse(GM_getValue(CFG.SCC_APPS_STATE_KEY, "{}"));
		for (const k of Object.keys(state)) {
			if (typeof saved[k] === "boolean") state[k] = saved[k];
		}
	} catch (_) { /* corrupt state → defaults */ }
	return state;
}

function _sccSaveState(state) {
	try { GM_setValue(CFG.SCC_APPS_STATE_KEY, JSON.stringify(state)); }
	catch (_) {}
}

function _buildSccPanel(state, onChange) {
	const el = document.createElement("div");
	el.className = "dw-scc-panel";
	// Static markup only — kind labels/colors are our own constants.
	el.innerHTML =
		'<div class="dw-scc-panel-hd">SCC Applications</div>' +
		Object.keys(_KIND).map((kind) => {
			const m = _KIND[kind];
			return (
				'<div class="dw-scc-row">' +
				`<label><input type="checkbox" data-key="${kind}">` +
				`<span class="dw-scc-dot" style="background:${m.color}"></span>` +
				`${m.label}</label>` +
				"</div>"
			);
		}).join("") +
		'<div class="dw-scc-row dw-scc-status">' +
		'<span class="dw-scc-row-label">Status</span>' +
		'<label><input type="checkbox" data-key="live"> current</label>' +
		'<label><input type="checkbox" data-key="past"> decided</label>' +
		"</div>" +
		'<div class="dw-scc-hint">decided sets appear from zoom 16</div>';
	el.querySelectorAll("input[data-key]").forEach((cb) => {
		cb.checked = !!state[cb.dataset.key];
		cb.addEventListener("change", () => onChange(cb.dataset.key, cb.checked));
	});
	// The panel floats over the map — don't let clicks/scrolls fall
	// through and pan/zoom underneath it.
	L.DomEvent.disableClickPropagation(el);
	L.DomEvent.disableScrollPropagation(el);
	return el;
}

// L.LayerGroup.extend is resolved lazily (first create() call) so this
// module can load in the unit-test sandbox, whose Leaflet stub only
// grows the classes the factories touch at runtime.
let _SccAppsLayer = null;

function _getSccAppsLayerClass() {
	if (_SccAppsLayer) return _SccAppsLayer;
	_SccAppsLayer = L.LayerGroup.extend({
		initialize() {
			L.LayerGroup.prototype.initialize.call(this, []);
			this._subs = {};   // "DA_live" → makeArcgisQueryLayer instance
			this._panel = null;
			this._state = _sccLoadState();
		},

		onAdd(map) {
			L.LayerGroup.prototype.onAdd.call(this, map);
			this._syncSubs();
			this._panel = _buildSccPanel(this._state, (key, on) => {
				this._state[key] = on;
				_sccSaveState(this._state);
				this._syncSubs();
			});
			map.getContainer().appendChild(this._panel);
			map.on("popupopen", _onSccPopupOpen);
		},

		onRemove(map) {
			map.off("popupopen", _onSccPopupOpen);
			if (this._panel) {
				this._panel.remove();
				this._panel = null;
			}
			L.LayerGroup.prototype.onRemove.call(this, map);
		},

		_syncSubs() {
			for (const kind of Object.keys(_KIND)) {
				for (const phase of ["live", "past"]) {
					const key = kind + "_" + phase;
					const on = this._state[kind] && this._state[phase];
					let sub = this._subs[key];
					if (on && !sub) {
						sub = this._subs[key] =
							_makeSubLayer(kind, phase === "live");
					}
					if (!sub) continue;
					// addLayer/removeLayer on an attached group
					// adds/removes the child from the map immediately.
					if (on && !this.hasLayer(sub)) this.addLayer(sub);
					else if (!on && this.hasLayer(sub)) this.removeLayer(sub);
				}
			}
		},
	});
	return _SccAppsLayer;
}

// Single layer-panel entry; sublayer choice lives in the on-map panel.
// 3D mode's recursive LayerGroup walker picks the circle markers up as
// point features automatically.
export class SccApplicationsLayerProvider extends LayerProvider {
	create() {
		const Cls = _getSccAppsLayerClass();
		return new Cls();
	}
}
