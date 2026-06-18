import { CFG } from "../config.js";
import { arcgisExportProvider } from "../layers/provider-factories.js";
import { _CACHE_TTL, cachedFetch, gmJsonGet } from "../utils/http.js";
import { _escHtml, esc, _fmtPrice, _fmtDate } from "../utils/html.js";

/* -- QLD Cadastre + OnTheHouse Sales ----------------------------------
 * Cadastre hover-identify renders a tooltip with a "Sales ↗" link;
 * clicking it fires the OnTheHouse fetch pipeline + opens a popup.
 * `installCadastreHover` is the entry point that wires both.
 */

// Filters out QLD's "Null" sentinel strings and genuinely empty values.
export function _cadVal(v) {
	if (v === null || v === undefined) return "";
	const s = String(v).trim();
	return s && s !== "Null" ? s : "";
}

// addressInfo is optional: { primary, extra } — primary is the headline
// address line, extra is a "+N more" hint when several addresses exist
// for the same lotplan (rural blocks with multiple dwellings, strata).
export function _formatCadastreTooltip(attrs, addressInfo, omitSalesLink) {
	const lotPlan =
		_cadVal(attrs["Lot/plan"]) ||
		(_cadVal(attrs.Lot) && _cadVal(attrs.Plan)
			? attrs.Lot + attrs.Plan
			: "");
	const lines = [];
	// attrs.* are ArcGIS DCDB attributes; addressInfo.* are ArcGIS
	// query fields. All external → escape before they hit the
	// tooltip/popup innerHTML.
	if (lotPlan) lines.push(esc`<b>${lotPlan}</b>`);

	const name  = _cadVal(attrs.Name);
	const alias = _cadVal(attrs.Alias);
	if (name)                  lines.push(_escHtml(name));
	else if (alias)            lines.push(_escHtml(alias));

	if (addressInfo && addressInfo.primary) {
		let addrLine = _escHtml(addressInfo.primary);
		if (addressInfo.extra) addrLine += esc` <span class="dw-cad-sub">${addressInfo.extra}</span>`;
		lines.push(addrLine);
	}

	const bits = [];
	const tenure = _cadVal(attrs.Tenure);
	if (tenure) bits.push(tenure);
	const parcelType = _cadVal(attrs["Parcel type"]);
	// Skip the redundant "Lot" parcel type — tenure already implies it.
	if (parcelType && parcelType.toLowerCase() !== "lot") bits.push(parcelType);
	const area = parseFloat(attrs["Lot area (m²)"]);
	if (isFinite(area) && area > 0) {
		bits.push(
			area >= 10000
				? (area / 10000).toFixed(2) + " ha"
				: Math.round(area) + " m²",
		);
	}
	if (bits.length) lines.push(bits.join(" · "));

	const locality = _cadVal(attrs.Locality);
	const lga      = _cadVal(attrs["Local authority"]);
	if (locality) lines.push(_escHtml(locality));
	if (lga)      lines.push(esc`<span class="dw-cad-sub">${lga}</span>`);

	const links = [];
	const smis = _cadVal(attrs["SmartMap link"]);
	// Validate scheme AND escape — a value like
	// `https://x" onmouseover="alert(1)` passes the regex but would
	// break out of the href attribute without quote-escaping.
	if (smis && /^https?:\/\//i.test(smis) && !/["'<>]/.test(smis)) {
		links.push(
			`<a class="dw-cad-link" href="${_escHtml(smis)}" target="_blank" rel="noreferrer">SmartMap ↗</a>`,
		);
	}
	// Only offer the OTH sales LINK once we have a numbered street
	// address — OTH's /odin/api/locations search only resolves to a
	// propertyId when we feed it both a street number and a street
	// name. Lat/lon is also required so the popup can anchor.
	// `omitSalesLink`: the location popup auto-loads + embeds sales
	// inline, so it suppresses this link (it'd be redundant there).
	if (
		!omitSalesLink &&
		addressInfo &&
		isFinite(addressInfo.lat) &&
		isFinite(addressInfo.lon) &&
		addressInfo.streetName &&
		addressInfo.streetNumber
	) {
		links.push(
			`<a class="dw-cad-link dw-cad-sales-link" href="#"` +
			` data-lat="${addressInfo.lat}" data-lon="${addressInfo.lon}"` +
			` data-lotplan="${(_cadVal(attrs["Lot/plan"]) || "").replace(/"/g, "&quot;")}"` +
			`>Sales ↗</a>`,
		);
	}
	if (links.length) lines.push(links.join(" &nbsp; "));

	return lines.join("<br>") || "Parcel";
}

/* -- Sales popup orchestration ---------------------------------------- */

// One-time delegated click handler installed when the cadastre layer is
// first attached. Catches clicks on the tooltip's "Sales ↗" link and
// drives the two-stage OnTheHouse lookup, rendering results into a
// Leaflet popup at the parcel location.
let _dwSalesHookInstalled = false;
let _dwSalesMap = null;
let _dwSalesGen = 0;

export function _renderSalesContent(result) {
	if (!result || !result.property) {
		const fallback = result && result.fallbackUrl
			? `<div class="dw-sales-row"><a href="${_escHtml(result.fallbackUrl)}" target="_blank" rel="noreferrer">Open OnTheHouse search ↗</a></div>`
			: "";
		return `<div class="dw-sales-pop">
			<div class="dw-sales-err">${_escHtml((result && result.error) || "No sales data.")}</div>
			${fallback}
		</div>`;
	}
	const p = result.property;
	const addr = p.address || {};
	const sale = p.lastSale || {};
	const guess = p.guesstimate || null;

	const headerAddr = addr.shortAddress || addr.formattedAddress || "";

	const stats = [];
	if (p.beds != null) stats.push(`<b>${p.beds}</b> bd`);
	if (p.baths != null) stats.push(`<b>${p.baths}</b> ba`);
	if (p.carSpaces != null) stats.push(`<b>${p.carSpaces}</b> car`);
	if (p.landSize) stats.push(`${p.landSize} m²`);
	if (p.yearBuilt) stats.push(`built ${p.yearBuilt}`);
	const statsLine = stats.length
		? `<div class="dw-sales-stats">${stats.join(" · ")}${p.type ? ` <span class="dw-sales-sub">${_escHtml(p.type)}</span>` : ""}</div>`
		: "";

	let saleBlock = "";
	if (sale.salePrice || sale.eventDate) {
		const price = sale.salePrice ? _fmtPrice(sale.salePrice) : "";
		const when = _fmtDate(sale.eventDate);
		const ag = sale.sellingAgency && sale.sellingAgency.name;
		saleBlock = `<div class="dw-sales-row"><span class="dw-sales-k">Last sale</span>
			<span class="dw-sales-v"><b>${_escHtml(price || "—")}</b> · ${_escHtml(when || "?")}
			${ag ? `<span class="dw-sales-sub">${_escHtml(ag)}</span>` : ""}</span></div>`;
	}

	let avmBlock = "";
	if (guess && guess.price) {
		const lo = guess.fromPrice ? _fmtPrice(guess.fromPrice) : "";
		const hi = guess.toPrice ? _fmtPrice(guess.toPrice) : "";
		const range = lo && hi ? ` <span class="dw-sales-sub">(${lo}–${hi})</span>` : "";
		avmBlock = `<div class="dw-sales-row"><span class="dw-sales-k">Estimate</span>
			<span class="dw-sales-v"><b>${_escHtml(_fmtPrice(guess.price))}</b>${range}</span></div>`;
	}

	// Sale events history (only "SoldEvent" type, last 6, oldest at bottom).
	let eventsBlock = "";
	const events = Array.isArray(p.events) ? p.events.filter((e) => e && e.type === "SoldEvent") : [];
	if (events.length > 1) {
		const rows = events.slice(0, 6).map((e) => {
			const px = e.salePrice ? _fmtPrice(e.salePrice) : "—";
			const dt = _fmtDate(e.eventDate);
			const ag = e.agencyName || "";
			return `<li><b>${_escHtml(px)}</b> <span class="dw-sales-sub">${_escHtml(dt)}${ag ? " · " + _escHtml(ag) : ""}</span></li>`;
		}).join("");
		eventsBlock = `<div class="dw-sales-row"><span class="dw-sales-k">History</span>
			<ul class="dw-sales-events">${rows}</ul></div>`;
	}

	const lotplan = (p.legalAttributes && p.legalAttributes["Lot/Plan"]) || "";
	const lotBlock = lotplan
		? `<div class="dw-sales-row"><span class="dw-sales-k">Lot/Plan</span><span class="dw-sales-v">${_escHtml(lotplan)}</span></div>`
		: "";

	const sourceLink = result.sourceUrl
		? `<a class="dw-sales-source" href="${_escHtml(result.sourceUrl)}" target="_blank" rel="noreferrer">Open on OnTheHouse ↗</a>`
		: "";

	return `<div class="dw-sales-pop">
		<div class="dw-sales-hd">${_escHtml(headerAddr)}</div>
		${statsLine}
		${saleBlock}
		${avmBlock}
		${eventsBlock}
		${lotBlock}
		${sourceLink}
	</div>`;
}

function _openSalesPopup(latlng, addrInfo, lotplan) {
	if (!_dwSalesMap) return;
	const map = _dwSalesMap;

	const popup = L.popup({
		minWidth: 280,
		maxWidth: 360,
		autoPan: true,
		autoClose: true,
		closeOnClick: false,
		className: "dw-sales-pop-wrap",
	})
		.setLatLng(latlng)
		.setContent(`<div class="dw-sales-pop"><div class="dw-sales-loading">Loading OnTheHouse data…</div></div>`)
		.openOn(map);

	const gen = ++_dwSalesGen;

	const finish = (result) => {
		if (gen !== _dwSalesGen) return;
		if (!popup.isOpen()) return;
		popup.setContent(_renderSalesContent(result));
	};

	// Cache the assembled popup model by lotplan in GM storage so a
	// re-hover on the same parcel hours later renders instantly. The
	// underlying OTH endpoints are themselves cached at finer grain
	// (locations / property / events) — this is the user-facing layer.
	if (!lotplan) { fetchOthSales(addrInfo, finish); return; }
	cachedFetch(
		"oth_sales_" + lotplan,
		_CACHE_TTL.OTH_PROPERTY,
		(done) => fetchOthSales(addrInfo, (result) => {
			// Don't persist transient network failures — only cache
			// definitive results (ok:true or ok:false with a structural
			// reason like "address not indexed").
			const persistable =
				result && (result.ok === true ||
				           (result.ok === false && !/rate-limit|status \d{3}/.test(result.error || "")));
			done(null, persistable ? result : null);
			if (!persistable) finish(result); // surface transient errors immediately
		}),
		(err, cached) => { if (cached) finish(cached); },
	);
}

function _onSalesLinkClick(e) {
	const a = e.target && e.target.closest && e.target.closest(".dw-cad-sales-link");
	if (!a) return;
	e.preventDefault();
	e.stopPropagation();
	const lat = parseFloat(a.dataset.lat);
	const lon = parseFloat(a.dataset.lon);
	const lotplan = a.dataset.lotplan || "";
	if (!isFinite(lat) || !isFinite(lon)) return;

	const cached = getCachedCadastreAddress(lotplan);
	if (cached) {
		_openSalesPopup(L.latLng(lat, lon), cached, lotplan);
		return;
	}
	// Address wasn't pre-resolved by hover (user clicked too fast or
	// the cache was wiped) — fetch on demand, then open the popup.
	fetchCadastreAddress(lotplan, (info) => {
		if (!info) return;
		_openSalesPopup(L.latLng(lat, lon), info, lotplan);
	});
}

export function _ensureSalesHook(map) {
	_dwSalesMap = map;
	if (_dwSalesHookInstalled) return;
	_dwSalesHookInstalled = true;
	// Capture-phase so we intercept before the underlying map gets the
	// click and tries to drop a waypoint at that location.
	document.addEventListener("click", _onSalesLinkClick, true);
}

export function _formatAddressLine(rec) {
	if (!rec) return "";
	// Query results are keyed by field name, not alias.
	const unit = (rec.unit_number || "").trim();
	const unitType = (rec.unit_type || "").trim();
	const street = (rec.street_full || "").trim();
	const propName = (rec.property_name || "").trim();
	const parts = [];
	if (unit) parts.push(unitType ? `${unitType} ${unit}` : unit);
	if (street) parts.push(street);
	let line = parts.join(" / ");
	if (!line && propName) line = propName;
	else if (propName && !line.toLowerCase().includes(propName.toLowerCase()))
		line = line ? `${line} (${propName})` : propName;
	return line;
}

export function fetchCadastreAddress(lotplan, cb) {
	if (!lotplan) { cb(null); return; }
	cachedFetch(
		"cad_addr_" + lotplan,
		_CACHE_TTL.CAD_ADDRESS,
		(done) => {
			const url =
				`${CFG.QLD_CADASTRE_SERVICE}/0/query` +
				`?where=${encodeURIComponent(`lotplan='${lotplan.replace(/'/g, "''")}'`)}` +
				`&outFields=street_full,unit_number,unit_type,property_name,` +
					`street_number,street_name,street_type,locality,latitude,longitude` +
				`&returnGeometry=false&f=json`;
			gmJsonGet(url, (err, data) => {
				if (err) { done(null, null); return; }
				const feats = (data.features || []).map((f) => f.attributes || {});
				const primaryRec =
					feats.find((a) => (a.street_full || "").trim()) || feats[0];
				const primary = _formatAddressLine(primaryRec);
				if (!primary) { done(null, null); return; }
				const extraCount = Math.max(0, feats.length - 1);
				done(null, {
					primary,
					extra: extraCount ? `+${extraCount} more` : "",
					// Structured bits the OnTheHouse lookup needs. Lat/lon
					// also anchors the sales popup at the parcel point.
					lat: parseFloat(primaryRec.latitude),
					lon: parseFloat(primaryRec.longitude),
					streetNumber: (primaryRec.street_number || "").trim(),
					streetName: (primaryRec.street_name || "").trim(),
					streetType: (primaryRec.street_type || "").trim(),
					locality: (primaryRec.locality || "").trim(),
				});
			});
		},
		(err, info) => cb(err ? null : info),
	);
}

// Public probe (no fetch) — used by the hover tooltip to render an
// address line synchronously if one was previously resolved.
function getCachedCadastreAddress(lotplan) {
	if (!lotplan) return null;
	try {
		const raw = GM_getValue("dw_cache_cad_addr_" + lotplan, null);
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		if (!parsed || (parsed.e !== 0 && parsed.e <= Date.now())) return null;
		return parsed.v || null;
	} catch (_) { return null; }
}

/* -- OnTheHouse sales lookup (click-triggered from cadastre tooltip) ---
 *
 *  Stage 1: resolve the address → propertyId via OTH's address
 *           autocomplete endpoint `/odin/api/locations?query=…`. Tiny
 *           JSON response, cached for a week. Found in OTH's main.js
 *           as the `addressSearchSagas` target.
 *  Stage 2: pull `/odin/api/properties/{id}` (core attributes) and
 *           `/odin/api/properties/{id}/events` (sales timeline) in
 *           parallel — about 5 KB combined, vs ~5 MB for the SSR HTML
 *           we previously scraped. Cached per propertyId (6 h for core,
 *           24 h for events).
 *
 *  Caching uses the shared `cachedFetch` helper (GM_setValue-backed,
 *  with TTLs in _CACHE_TTL). The api-gateway-alb.*.corelogic.io
 *  endpoints these reach are CORS-locked from browser JS but reachable
 *  via GM_xmlhttpRequest's privileged bypass.
 */

// (Persistent sales-popup caching lives in cachedFetch — see _openSalesPopup.)

export function _slugify(s) {
	return String(s || "")
		.toLowerCase()
		.replace(/&/g, " and ")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

// Map QLD's long-form street types to OnTheHouse's short slug form.
// Unknown types pass through slugified — OTH's URL routing is lenient
// enough that a near-miss still returns the fallback list, which is
// all we need to discover the focal property's othPropertyId.
const _OTH_STREET_TYPE = {
	STREET: "st", ROAD: "rd", AVENUE: "ave", DRIVE: "dr", LANE: "la",
	CRESCENT: "cres", PLACE: "pl", TERRACE: "tce", COURT: "ct",
	BOULEVARD: "bvd", BOULEVARDE: "bvd", CIRCUIT: "cct",
	HIGHWAY: "hwy", PARADE: "pde", CLOSE: "cl", WAY: "way",
	ESPLANADE: "esp", QUAY: "qy", CIRCLE: "cir", LINK: "lnk",
	MEWS: "mews", SQUARE: "sq", WALK: "wlk", ARCADE: "arc",
	ALLEY: "al", ROW: "row", VIEW: "vw", RIDGE: "rdge", RISE: "ri",
	BEND: "bend", LOOP: "loop", TRACK: "trk", TRAIL: "trl",
};

export function _othStreetTypeSlug(type) {
	const up = String(type || "").trim().toUpperCase();
	return _OTH_STREET_TYPE[up] || _slugify(type);
}

// Canonical OTH property URL — used only as the "Open on OnTheHouse ↗"
// link in the sales popup (we get the data itself via the JSON
// endpoints). Built from the locations API's authoritative fields so
// it always lands on a valid focal-property page. Example:
//   /property/qld/petrie-terrace-4000/256-petrie-tce-petrie-terrace-qld-4000-14995257
export function _othCanonicalUrlFromLocation(loc) {
	const suburbSlug = _slugify(loc.suburb);
	const streetSlug = _slugify(
		`${loc.streetNumber} ${loc.streetName} ${_othStreetTypeSlug(loc.streetType)}`,
	);
	const tail = `${streetSlug}-${suburbSlug}-qld-${loc.postCode}`;
	return `${CFG.OTH_BASE}/property/qld/${suburbSlug}-${loc.postCode}/${tail}-${loc.propertyId}`;
}

// OTH's address autocomplete endpoint. Returns up to 10 candidates
// keyed by free-text query — discovered in OTH's main.js as the
// `addressSearchSagas` target. Street-level placeholder rows (like
// { propertyId: "NAMBOUR+QLD+4560+ERBACHER+RD", streetNumber: "" })
// share the response and are filtered out by callers that require a
// numeric propertyId. Cached for a week — autocomplete suggestions
// don't change meaningfully on shorter timescales.
function fetchOthLocations(query, cb) {
	cachedFetch(
		"oth_loc_" + query.toLowerCase().replace(/\s+/g, "_"),
		_CACHE_TTL.OTH_LOCATIONS,
		(done) => {
			const url =
				`${CFG.OTH_BASE}/odin/api/locations?query=` + encodeURIComponent(query);
			gmJsonGet(url, (err, data, raw) => {
				if (err) { done(null, { error: err.message, status: raw && raw.status }); return; }
				done(null, { content: Array.isArray(data.content) ? data.content : [] });
			});
		},
		(_err, result) => cb(result || { error: "cache miss" }),
	);
}

// Resolve a parcel's address to an OTH property and pull its detail.
// Three API calls (each tiny JSON, cached aggressively):
//   1. /odin/api/locations?query=…       → candidate list with propertyIds
//   2. /odin/api/properties/{id}         → core attributes + lastSale
//   3. /odin/api/properties/{id}/events  → sales/listings history timeline
//
// Steps 2+3 fire in parallel. The combined object matches the shape
// `_renderSalesContent` expects (events merged into the property).
//
// Calls cb(result) with:
//   { ok: true,  property, sourceUrl }   — focal property data
//   { ok: false, error }                 — couldn't resolve
export function fetchOthSales(addrInfo, cb) {
	if (!addrInfo.streetNumber) {
		cb({
			ok: false,
			error: "This parcel has no street number in QLD's cadastre — OnTheHouse can't look it up.",
		});
		return;
	}

	// Build the autocomplete query. Suburb + state disambiguate same-
	// named streets in other states; postcode is harmless if present.
	const qParts = [];
	if (addrInfo.streetNumber) qParts.push(addrInfo.streetNumber);
	if (addrInfo.streetName)   qParts.push(addrInfo.streetName);
	if (addrInfo.streetType)   qParts.push(addrInfo.streetType);
	if (addrInfo.locality)     qParts.push(addrInfo.locality);
	qParts.push("QLD");
	const query = qParts.join(" ").trim();

	fetchOthLocations(query, (locResult) => {
		if (locResult && locResult.error) {
			cb({
				ok: false,
				error: locResult.status === 429
					? "OnTheHouse is rate-limiting us — try again in a minute."
					: `Couldn't reach OnTheHouse (${locResult.error}).`,
			});
			return;
		}

		// Filter to candidates with a numeric propertyId (real
		// property, not the street-level "ERBACHER+RD+NAMBOUR"
		// placeholder rows). Prefer exact street-number + name match.
		const candidates = (locResult.content || []).filter(
			(p) => p && /^\d+$/.test(String(p.propertyId || "")),
		);
		const wantNum  = String(addrInfo.streetNumber || "").toUpperCase();
		const wantName = String(addrInfo.streetName   || "").toUpperCase();
		const match =
			candidates.find(
				(p) =>
					String(p.streetNumber || "").toUpperCase() === wantNum &&
					String(p.streetName   || "").toUpperCase() === wantName,
			) ||
			candidates.find(
				(p) => String(p.streetNumber || "").toUpperCase() === wantNum,
			) ||
			candidates[0];

		if (!match) {
			cb({
				ok: false,
				error: "OnTheHouse doesn't have a record for this address.",
			});
			return;
		}

		const pid = match.propertyId;
		const sourceUrl = _othCanonicalUrlFromLocation(match);

		// Stage 2: fetch property core + events in parallel.
		let coreRes = null, eventsRes = null, done = false;
		const finish = () => {
			if (done) return;
			if (coreRes === null || eventsRes === null) return;
			done = true;
			if (coreRes.error) {
				cb({
					ok: false,
					error: "Couldn't fetch OnTheHouse property data.",
					fallbackUrl: sourceUrl,
				});
				return;
			}
			const property = Object.assign({}, coreRes.data, {
				events: (eventsRes.data && eventsRes.data.content) || [],
			});
			cb({ ok: true, property, sourceUrl });
		};

		// Pass fetch errors THROUGH as errors (first arg) — wrapping
		// them as `{error}` values made cachedFetch persist them, so a
		// single transient timeout/429 served "Couldn't fetch" for the
		// full 6-24 h TTL on that property (poisoned cache). With err
		// set, nothing is stored: the user sees the error once and the
		// next open refetches.
		cachedFetch(
			"oth_prop_" + pid,
			_CACHE_TTL.OTH_PROPERTY,
			(d) => gmJsonGet(
				`${CFG.OTH_BASE}/odin/api/properties/${pid}`,
				(err, data) => d(err, err ? undefined : { data }),
			),
			(e, r) => {
				coreRes = r || { error: e ? e.message : "cache miss" };
				finish();
			},
		);
		cachedFetch(
			"oth_evt_" + pid,
			_CACHE_TTL.OTH_EVENTS,
			(d) => gmJsonGet(
				`${CFG.OTH_BASE}/odin/api/properties/${pid}/events`,
				(err, data) => d(err, err ? undefined : { data }),
			),
			(e, r) => {
				eventsRes = r || { error: e ? e.message : "cache miss" };
				finish();
			},
		);
	});
}

// (Cadastre hover-identify removed — parcel info is delivered through
// the location popup now; see _injectIdentifyIntoPopup. The shared
// makeHoverIdentify factory is still used by QPWS.)

function installCadastreHover(layer, map) {
	// Cadastre identify is delivered through the location popup on
	// click / right-click (see _injectIdentifyIntoPopup), NOT a hover
	// tooltip. The hover fought the right-click menu and kept
	// re-popping over it; the popup is now the single surface, with
	// sales auto-loaded inline. We only ensure the delegated
	// sales-link handler exists (harmless belt-and-braces).
	_ensureSalesHook(map);
}

export const QldCadastreLayerProvider = arcgisExportProvider({
	baseUrl: CFG.QLD_CADASTRE_SERVICE,
	showLayers: String(CFG.QLD_CADASTRE_LAYER_ID),
	pane: "dwCadastrePane", paneZIndex: 385,
	opacity: 0.75, minZoom: 11, maxZoom: 25,
	attribution: 'Cadastre &copy; <a href="https://www.qld.gov.au/dnrme" target="_blank" rel="noreferrer">State of Queensland (DCDB)</a>',
	onAdd: (layer, map) => installCadastreHover(layer, map),
	onRemove: (layer) => {
		if (layer._dwHoverOff) { layer._dwHoverOff(); layer._dwHoverOff = null; }
	},
});


