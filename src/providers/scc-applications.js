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
	const status = live
		? (p.progress || "In Progress")
		: (p.decision || "Decided");
	const chip = live ? "dw-scc-chip--live" : "dw-scc-chip--past";
	const lines = [];
	lines.push(
		esc`<span class="dw-scc-tip-hd"><b>${p.ram_id || "Application"}</b>` +
		`<span class="dw-scc-chip ${chip}">${_escHtml(status)}</span></span>`,
	);
	const cat = String(p.category_desc || "").trim();
	const catLine = [meta.label, cat && cat !== meta.label ? cat : ""]
		.filter(Boolean).join(" · ");
	if (catLine) lines.push(esc`<span class="dw-scc-tip-cat">${catLine}</span>`);
	const desc = _clip(p.description, 90);
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

// appType param for /Geo/GetApplicationById (Development.i's structured
// JSON: project officer, decision_desc, appeal_result, land_no…).
const _DEVI_APPTYPE = { DA: "development", BA: "building", PL: "plumbing" };

function _validRamId(ramId) {
	const id = String(ramId || "").trim();
	return id && /^[A-Za-z0-9/\-. ]+$/.test(id) ? id : "";
}

export function _deviDetailUrl(kind, ramId) {
	const type = _DEVI_TYPE[kind];
	const id = _validRamId(ramId);
	if (!type || !id) return "";
	return (
		CFG.SCC_DEVI_BASE + "/Home/ApplicationDetail?type=" + type +
		"&id=" + encodeURIComponent(id)
	);
}

export function _deviAppByIdUrl(kind, ramId) {
	const appType = _DEVI_APPTYPE[kind];
	const id = _validRamId(ramId);
	if (!appType || !id) return "";
	return (
		CFG.SCC_DEVI_BASE + "/Geo/GetApplicationById?applicationId=" +
		encodeURIComponent(id) + "&appType=" + appType
	);
}

// POST body for /Geo/GetApplicationFilterResults — Development.i's map
// query engine. Mirrors the site's own default filter object; we use
// it two ways: LandNumber → every application ever lodged on a parcel
// (history collation), and Progress "notification" + BBox → apps
// currently on public notification (open for submissions).
export function _deviFilterBody(o) {
	o = o || {};
	return {
		Progress: o.progress || "all",
		StartDateUnixEpochNumber: null, EndDateUnixEpochNumber: null,
		DateRangeField: "submitted", DateRangeDescriptor: null,
		LotPlan: null,
		LandNumber: o.landNumber != null ? o.landNumber : null,
		PropNumber: null, DANumber: null, BANumber: null, PlumbNumber: null,
		IncludeDA: true,
		IncludeBA: o.includeBA !== false,
		IncludePlumb: o.includePlumb !== false,
		LocalityId: null, DivisionId: null,
		ApplicationTypeId: null, SubCategoryUseId: null,
		ShowCode: true, ShowImpact: true, ShowOther: true,
		PagingStartIndex: 0, MaxRecords: o.maxRecords || 200,
		Boundary: null, ViewPort: null, IncludeAroundMe: false,
		SortField: "submitted", SortAscending: false,
		BBox: o.bbox || null,
		PixelWidth: 800, PixelHeight: 800,
	};
}

// Filter-results responses split matches between `features` and a
// `multiSpot` map (coordinate → feature[]) for co-located points.
// Flatten both and dedupe (multi-parcel applications repeat per spot).
export function _dedupeDeviFeatures(data) {
	if (!data) return [];
	const all = (Array.isArray(data.features) ? data.features : []).slice();
	const ms = data.multiSpot;
	if (ms && typeof ms === "object") {
		for (const key of Object.keys(ms)) {
			if (Array.isArray(ms[key])) all.push(...ms[key]);
		}
	}
	const seen = new Set();
	const out = [];
	for (const f of all) {
		const p = (f && f.properties) || {};
		const num = p.application_number;
		if (!num) continue;
		const coords = (f.geometry && f.geometry.coordinates) || [];
		const key = num + "@" + coords.join(",");
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(f);
	}
	return out;
}

// Development.i's `category` field → our kind key (drives marker
// colour dots and which FilterDirect param a deep link uses).
export function _deviKindFromCategory(category) {
	const c = String(category || "").toLowerCase();
	if (c === "building") return "BA";
	if (c === "plumbing") return "PL";
	return "DA";
}

// Shared extraction: filter-results payload → sorted history entries.
// Carries the actual DECISION ("Approved", "Refused", "Development
// Permit"…) and both dates — the decision chain is the story of a
// parcel (e.g. a 2004 subdivision approval still authorising works
// today), so the UI must show it, not just "Decided or Past".
export function _histFromFilterResults(data, excludeNum) {
	const seen = new Set(excludeNum ? [excludeNum] : []);
	const hist = [];
	for (const f of _dedupeDeviFeatures(data)) {
		const p = f.properties || {};
		const num = p.application_number;
		if (seen.has(num)) continue;
		seen.add(num);
		hist.push({
			num,
			kind: _deviKindFromCategory(p.category),
			desc: String(p.description || ""),
			progress: String(p.progress || ""),
			decision: String(p.decision_desc || "").trim(),
			dateMs: Date.parse(p.date_received || "") || 0,
			decidedMs: Date.parse(p.date_determined || "") || 0,
		});
	}
	hist.sort((a, b) => b.dateMs - a.dateMs);
	return hist;
}

// Colour-classify a decision string for the history rows: approvals
// green, refusals/withdrawals red, everything else neutral.
export function _decisionClass(decision) {
	const d = String(decision || "").toLowerCase();
	if (/refus|withdraw|not proceed|returned/.test(d)) return "dw-scc-dec--bad";
	if (/approv|permit|agree|finalis|accept|compl/.test(d)) return "dw-scc-dec--ok";
	return "";
}

// One history row, shared by the application popup and the location-
// popup property section. Shows the decision + determination date for
// decided applications ("Approved · 6 Dec 2004") and lodgement for
// in-progress ones; rows sharing the focal application's base number
// (REC02/0156.* siblings) get a "same approval" chip.
export function _histRowHtml(h, focalBase) {
	const url = _deviAppUrl(h.kind, h.num);
	const numHtml = url
		? `<a href="${_escHtml(url)}" target="_blank" rel="noreferrer"><b>${_escHtml(h.num)}</b></a>`
		: esc`<b>${h.num}</b>`;
	const related = focalBase && String(h.num).split(".")[0] === focalBase
		? '<span class="dw-scc-chip dw-scc-chip--rel">same approval</span>'
		: "";
	const inProgress = /in progress/i.test(h.progress);
	let meta, metaCls = "";
	if (!inProgress && h.decision) {
		meta = h.decision +
			(h.decidedMs > 0 ? " · " + _fmtSccDate(h.decidedMs) : "");
		metaCls = _decisionClass(h.decision);
	} else if (inProgress) {
		meta = "In Progress" +
			(h.dateMs > 0 ? " · lodged " + _fmtSccDate(h.dateMs) : "");
	} else {
		meta = [h.progress, h.dateMs > 0 ? _fmtSccDate(h.dateMs) : ""]
			.filter(Boolean).join(" · ");
	}
	return (
		`<div class="dw-scc-stage"><span class="dw-scc-stage-desc">` +
		`${numHtml}${related} ${_escHtml(_clip(h.desc, 56))}</span>` +
		(meta
			? `<span class="dw-scc-stage-val ${metaCls}">${_escHtml(meta)}</span>`
			: "") +
		"</div>"
	);
}

/* -- Property history for ANY parcel (location-popup section) ----------
 * lat/lng → /Geo/GetPropertyDetailsByLatLng (land number, address,
 * lot/plan) → filter-results POST for every application ever lodged
 * there. Surfaces in the site's location popup on click/right-click,
 * so parcels with no visible markers still expose their planning
 * history. History is cached per land number; the point lookup itself
 * is cheap and uncached (unbounded latlng keyspace).
 */

export function fetchSccPropertyHistory(lat, lng, cb) {
	if (!isFinite(lat) || !isFinite(lng)) { cb(null); return; }
	gmJsonGet(
		CFG.SCC_DEVI_BASE + "/Geo/GetPropertyDetailsByLatLng" +
			"?lat=" + lat.toFixed(6) + "&lng=" + lng.toFixed(6),
		(err, d) => {
			const f = (!err && d && Array.isArray(d.features) && d.features[0]) || null;
			const p = f && f.properties;
			if (!p || p.land_no == null) { cb(null); return; }
			const prop = {
				landNo: p.land_no,
				address: String(p.address_format || p.address_short || "").trim(),
				lotPlan: String(p.lot_plan || "").trim(),
			};
			cachedFetch(
				"scc_prophist_" + prop.landNo,
				_CACHE_TTL.SCC_DETAIL,
				(done) => gmJsonGet(
					CFG.SCC_DEVI_BASE + "/Geo/GetApplicationFilterResults",
					{
						method: "POST",
						data: JSON.stringify(_deviFilterBody({ landNumber: prop.landNo })),
						headers: { "Content-Type": "application/json" },
					},
					(err2, data) => {
						if (err2 || !data) { done(err2 || new Error("no data"), undefined); return; }
						done(null, _histFromFilterResults(data));
					},
				),
				(err2, hist) => cb(err2 ? null : { prop, hist: hist || [] }),
			);
		},
	);
}

// Location-popup section: parcel header + every application lodged on
// it, newest first, each number deep-linking into Development.i.
export function _renderSccPropertyHistory(res, maxRows) {
	if (!res || !res.hist.length) {
		return res && res.prop.address
			? esc`<b>SCC applications</b><br><span class="dw-scc-sub">None on record for ${res.prop.address}.</span>`
			: "";
	}
	const max = maxRows || 8;
	const rows = res.hist.slice(0, max)
		.map((h) => _histRowHtml(h, "")).join("");
	const extra = res.hist.length > max
		? esc`<div class="dw-scc-sub">+${res.hist.length - max} more on this parcel</div>`
		: "";
	return (
		esc`<b>SCC applications (${res.hist.length})</b>` +
		`<div class="dw-scc-stages">${rows}${extra}</div>`
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
	if (!d || (!d.properties.length && !d.stages.length &&
		!(d.history || []).length && !d.officer && !d.statusDesc)) {
		return '<span class="dw-scc-sub">No further detail available.</span>';
	}
	const bits = [];

	// Status/officer facts from the structured GetApplicationById JSON.
	const facts = [];
	if (d.statusDesc) facts.push(esc`${d.statusDesc}`);
	if (d.appType)    facts.push(esc`Type: ${d.appType}`);
	if (d.officer)    facts.push(esc`Officer: ${d.officer}`);
	if (d.appeal)     facts.push(esc`Appeal: ${d.appeal}`);
	if (facts.length) {
		bits.push(
			`<div class="dw-scc-det-sec dw-scc-sub">${facts.join("<br>")}</div>`,
		);
	}

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
	const hist = d.history || [];
	if (hist.length) {
		const focalBase = d.focal ? String(d.focal).split(".")[0] : "";
		// Same-approval siblings (REC02/0156.* of a REC02/0156.04 focal)
		// jump the newest-first order so the ROOT approval — the thing
		// that actually authorises works on the ground, however old —
		// is always visible above the row cap, not lost in "+N more".
		const isRel = (h) =>
			focalBase && String(h.num).split(".")[0] === focalBase ? 1 : 0;
		const ordered = hist.slice().sort(
			(a, b) => (isRel(b) - isRel(a)) || (b.dateMs - a.dateMs));
		const rows = ordered.slice(0, 8)
			.map((h) => _histRowHtml(h, focalBase)).join("");
		const extra = hist.length > 8
			? esc`<div class="dw-scc-sub">+${hist.length - 8} more on this parcel</div>`
			: "";
		bits.push(
			`<div class="dw-scc-det-sec"><b>Property history (${hist.length})</b>` +
			`<div class="dw-scc-stages">${rows}${extra}</div></div>`,
		);
	}
	return bits.join("");
}

// Collates three Development.i sources into one cached detail object:
//   1. /Home/ApplicationDetail (HTML fragment) → assessment stages +
//      associated parcel addresses
//   2. /Geo/GetApplicationById (JSON)          → project officer,
//      application type, appeal result, live status text, land_no
//   3. /Geo/GetApplicationFilterResults (POST) → every other
//      application on the same parcel (property history)
// 1+2 run in parallel; 3 chains off 2's land_no. One cache entry per
// application; transient failures aren't persisted.
export function fetchSccDetail(kind, ramId, cb) {
	const fragUrl = _deviDetailUrl(kind, ramId);
	const infoUrl = _deviAppByIdUrl(kind, ramId);
	if (!fragUrl || !infoUrl) { cb(null); return; }
	cachedFetch(
		"scc_detail_" + kind + "_" + ramId,
		_CACHE_TTL.SCC_DETAIL,
		(done) => {
			let frag = null, info = null, pending = 2;

			const finish = (history) => {
				const out = Object.assign(
					{ properties: [], stages: [], history: [], focal: ramId },
					frag || {},
				);
				if (history) out.history = history;
				if (info) {
					out.officer = String(info.project_officer || "").trim();
					out.appType = String(info.application_type || "").trim();
					out.statusDesc = String(info.decision_desc || "").trim();
					const appeal = String(info.appeal_result || "").trim();
					if (appeal && !/^not applicable$/i.test(appeal)) {
						out.appeal = appeal;
					}
				}
				const hasAnything = out.properties.length || out.stages.length ||
					out.history.length || out.officer || out.statusDesc;
				if (!hasAnything && !frag && !info) {
					// Both sources failed outright → transient, don't cache.
					done(new Error("devi detail unavailable"), undefined);
					return;
				}
				done(null, hasAnything ? out : null);
			};

			const step = () => {
				if (--pending) return;
				const landNo = info && info.land_no;
				if (landNo == null) { finish(); return; }
				gmJsonGet(
					CFG.SCC_DEVI_BASE + "/Geo/GetApplicationFilterResults",
					{
						method: "POST",
						data: JSON.stringify(_deviFilterBody({ landNumber: landNo })),
						headers: { "Content-Type": "application/json" },
					},
					(err, data) => {
						if (err || !data) { finish(); return; }
						finish(_histFromFilterResults(data, ramId));
					},
				);
			};

			gmGet(
				fragUrl,
				{ headers: { "X-Requested-With": "XMLHttpRequest", Accept: "text/html" } },
				(err, r) => {
					frag = (!err && r && r.status >= 200 && r.status < 300)
						? _parseSccDetailHtml(r.responseText) : null;
					step();
				},
			);
			gmJsonGet(infoUrl, (err, d) => {
				info = (!err && d && Array.isArray(d.features) && d.features[0])
					? (d.features[0].properties || null) : null;
				step();
			});
		},
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

/* -- "On public notification" sublayer ---------------------------------
 * Development.i tracks a status the ArcGIS service doesn't expose:
 * applications currently on public notification — the window where
 * anyone can lodge a submission/objection. Queried straight from the
 * filter-results POST API with Progress:"notification" + viewport
 * BBox; council-wide it's only ~a dozen applications, so this renders
 * from far out. All notifying apps are development applications.
 */

export function _formatNotifTooltip(p) {
	const lines = [
		esc`<span class="dw-scc-tip-hd"><b>${p.application_number || "Application"}</b>` +
		'<span class="dw-scc-chip dw-scc-chip--notif">On public notification</span></span>',
	];
	const desc = _clip(p.description, 90);
	if (desc) lines.push(esc`<span class="dw-scc-sub">${desc}</span>`);
	const alertMs = Date.parse(p.alertDate || "") || 0;
	if (alertMs) {
		lines.push(esc`<span class="dw-scc-sub">Submissions invited — listed ${_fmtSccDate(alertMs)}</span>`);
	}
	return lines.join("<br>");
}

// Adapt the Development.i property names onto the shared popup
// formatter (ArcGIS field names), so the notifying markers get the
// same enriched popup as regular application markers.
export function _notifPopupProps(p) {
	return {
		ram_id: p.application_number,
		group_desc: p.group_desc || p.application_type,
		category_desc: p.category_desc,
		description: p.description,
		progress: "In Progress — On Public Notification",
		assessment_level: p.assessment_level,
		d_date_rec: Date.parse(p.date_received || "") || null,
	};
}

function _makeNotifyingLayer() {
	return makeArcgisQueryLayer({
		label: "SCC notifying applications",
		pane: PANE,
		paneZIndex: PANE_Z,
		minZoom: 10,
		buildRequest: (bbox) => ({
			url: CFG.SCC_DEVI_BASE + "/Geo/GetApplicationFilterResults",
			gmOpts: {
				method: "POST",
				data: JSON.stringify(_deviFilterBody({
					progress: "notification",
					bbox,
					includeBA: false, includePlumb: false,
				})),
				headers: { "Content-Type": "application/json" },
			},
		}),
		transform: (data) => ({
			type: "FeatureCollection",
			features: _dedupeDeviFeatures(data),
		}),
		pointToLayer: (f, latlng) =>
			L.circleMarker(latlng, {
				pane: PANE,
				radius: 8,
				color: "#ffffff",
				weight: 2,
				opacity: 0.95,
				fillColor: "#dc2626",
				fillOpacity: 0.9,
			}),
		tipClass: "dw-scc-tip",
		tooltip: (p) => _formatNotifTooltip(p),
		popup: (p) => _formatSccPopup(_notifPopupProps(p), "DA", true),
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

// One flag per application type plus status flags that apply across
// all types: a sublayer renders iff its type AND its status are both
// ticked. "current" = the In Progress sets, "past" = Decided.
// "notif" is the standalone public-notification layer (Development.i
// data; always development applications, independent of type flags).
export function _sccDefaultState() {
	return { DA: true, BA: true, PL: true, live: true, past: false, notif: true };
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
		'<div class="dw-scc-row dw-scc-notif-row">' +
		'<label><input type="checkbox" data-key="notif">' +
		'<span class="dw-scc-dot" style="background:#dc2626"></span>' +
		"on public notification</label>" +
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
			const want = {};
			for (const kind of Object.keys(_KIND)) {
				for (const phase of ["live", "past"]) {
					want[kind + "_" + phase] =
						!!(this._state[kind] && this._state[phase]);
				}
			}
			// Public-notification layer is standalone (Development.i
			// source, development apps only) — type flags don't gate it.
			want.notif = !!this._state.notif;

			for (const key of Object.keys(want)) {
				const on = want[key];
				let sub = this._subs[key];
				if (on && !sub) {
					sub = this._subs[key] = key === "notif"
						? _makeNotifyingLayer()
						: _makeSubLayer(key.split("_")[0],
							key.split("_")[1] === "live");
				}
				if (!sub) continue;
				// addLayer/removeLayer on an attached group adds/removes
				// the child from the map immediately.
				if (on && !this.hasLayer(sub)) this.addLayer(sub);
				else if (!on && this.hasLayer(sub)) this.removeLayer(sub);
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
