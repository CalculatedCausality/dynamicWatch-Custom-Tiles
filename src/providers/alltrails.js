import { CFG } from "../config.js";
import { LayerProvider } from "../layers/provider-factories.js";
import { makeVectorTileLayer } from "../layers/vector-tile-layer.js";
import { allTrailsChunkUrls, allTrailsExploreUrl, allTrailsTokenIn, allTrailsViewAround } from "../utils/alltrails.js";
import { _escHtml, esc } from "../utils/html.js";
import { gmGet } from "../utils/http.js";

/* -- AllTrails trail map --------------------------------------------------
 * The trail network AllTrails' own map draws, from the vector tiles it
 * hosts on Mapbox (tileset at_ways_production):
 *   at_routes_production             named, waymarked routes (z3+)
 *   at_osm_trail_segments_production every path and track (z11+), with
 *                                    short keys: n name, h highway type,
 *                                    s surface, sac difficulty, a/ac
 *                                    access, l length in km
 * Trails only: AllTrails' places tileset (parking, toilets, water…) is
 * deliberately not read; it buried the trails in parking pins.
 * This is the map AllTrails draws under its trail listings. The listings
 * themselves (ratings, reviews, photos) come from a separate search
 * service and are not read here.
 *
 * The tiles need AllTrails' public Mapbox token. It is not stored in this
 * script: it is read from AllTrails' pages in the user's own browser (with
 * the user's own cookies, so AllTrails' bot check sees the real browser)
 * and remembered in userscript storage.
 */

const clean = (v, max) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);

const ROUTE_COLORS = { hiking: "#15803d", mountain_biking: "#b45309", biking: "#1d4ed8", running: "#be123c" };
const ROUTE_NAMES = { hiking: "Walking route", mountain_biking: "Mountain bike route", biking: "Cycling route", running: "Running route" };
const NETWORKS = { lwn: "local", rwn: "regional", nwn: "national", iwn: "international",
	lcn: "local", rcn: "regional", ncn: "national", icn: "international" };
const SAC = {
	hiking: "easy walking", mountain_hiking: "mountain walking", demanding_mountain_hiking: "demanding mountain walking",
	alpine_hiking: "alpine", demanding_alpine_hiking: "demanding alpine", difficult_alpine_hiking: "difficult alpine",
};
const HIGHWAYS = { path: "Path", track: "Track", footway: "Footpath", cycleway: "Cycleway", bridleway: "Bridle path", steps: "Steps" };
// "private" / "no" / "permit" when a path is not open to walk, else "".
export function atAccess(props) {
	const p = props || {};
	for (const v of [p.f, p.a, p.ac]) {
		if (v === "private" || v === "no" || v === "permit") return v;
		if (v === "yes" || v === "designated" || v === "permissive") return "";
	}
	return "";
}

export function atSegmentHtml(props) {
	const p = props || {};
	const kind = HIGHWAYS[p.h] || "Trail";
	const access = atAccess(p);
	const facts = [
		clean(p.s, 30), SAC[p.sac] || "",
		Number(p.l) > 0 ? `${Number(p.l)} km section` : "",
	].filter(Boolean).join(" · ");
	return esc`<b>${clean(p.n, 100) || kind}</b>` +
		(p.n ? esc`<br>${kind}` : "") +
		(facts ? esc`<br>${facts}` : "") +
		(access ? esc`<br><span class="dw-at-warn">${access === "permit" ? "Permit needed" : access === "private" ? "Private: no public access" : "No access on foot"}</span>` : "");
}

export function atRouteHtml(props) {
	const p = props || {};
	const kind = ROUTE_NAMES[p.type] || "Waymarked route";
	const net = NETWORKS[p.network] ? `${NETWORKS[p.network]} route` : clean(p.network, 60);
	const sub = [kind, net, p.ref ? `marked "${clean(p.ref, 20)}"` : ""].filter(Boolean).join(" · ");
	return esc`<b>${clean(p.name, 100) || kind}</b><br>${sub}`;
}

// Pop-up for a clicked trail: its details and a link to AllTrails' Explore
// page for about 3 km around the click. The tiles identify a trail by its
// OpenStreetMap id, not by an AllTrails page, so the link is to the place.
export function atPopupHtml(detailsHtml, latlng) {
	const url = latlng && Number.isFinite(latlng.lat) && Number.isFinite(latlng.lng)
		? allTrailsExploreUrl(allTrailsViewAround(latlng.lat, latlng.lng, 3)) : "";
	return `<div class="dw-abw-pop">${detailsHtml}` +
		(url ? esc`<div><a href="${url}" target="_blank" rel="noopener noreferrer">See trails here on AllTrails ↗</a></div>` : "") +
		`</div>`;
}

// Tile features → the elements the shared vector-tile layer draws.
export function atToElements(layerName, props, geometryType, rings) {
	if (layerName === "at_routes_production" && geometryType === 2) {
		return rings.filter((r) => r.length > 1).map((r) => ({ type: "way", geometry: r, tags: props, kind: "route" }));
	}
	if (layerName === "at_osm_trail_segments_production" && geometryType === 2) {
		return rings.filter((r) => r.length > 1).map((r) => ({ type: "way", geometry: r, tags: props, kind: "segment" }));
	}
	return null;
}

/* -- Token lookup ---------------------------------------------------------- */

let _lookup = null;   // in-flight lookup: callbacks waiting on it

function storedToken() {
	try { const v = JSON.parse(GM_getValue(CFG.ALLTRAILS_TOKEN_KEY, "null")); return v && typeof v.tok === "string" ? v.tok : ""; }
	catch (_) { return ""; }
}
function storeToken(tok) {
	try { GM_setValue(CFG.ALLTRAILS_TOKEN_KEY, tok ? JSON.stringify({ tok, t: Date.now() }) : "null"); } catch (_) {}
}

// Find the token: stored, else read AllTrails' Explore page and its scripts.
// cb(token, reason): reason is "blocked" (bot check or sign-in wall),
// "network" or "notfound" when token is "".
export function lookupAllTrailsToken(cb, opts) {
	const fresh = opts && opts.fresh;
	if (!fresh) { const tok = storedToken(); if (tok) { cb(tok); return; } }
	if (_lookup) { _lookup.push(cb); return; }
	const waiting = _lookup = [cb];
	const done = (tok, reason) => { _lookup = null; if (tok) storeToken(tok); for (const fn of waiting) fn(tok, reason); };
	// The user's own cookies go with this request, so AllTrails sees the
	// browser that has already passed its bot check, not a stranger.
	gmGet(CFG.ALLTRAILS_PAGE, { anonymous: false, timeout: 25000 }, (err, r) => {
		if (err || !r) { done("", "network"); return; }
		if (r.status !== 200) { done("", r.status === 403 || r.status === 401 || r.status === 429 ? "blocked" : "network"); return; }
		const html = r.responseText || "";
		const inPage = allTrailsTokenIn(html);
		if (inPage) { done(inPage); return; }
		const urls = allTrailsChunkUrls(html);
		if (!urls.length) { done("", "notfound"); return; }
		let next = 0, active = 0, finished = false;
		const pump = () => {
			if (finished) return;
			if (next >= urls.length && !active) { finished = true; done("", "notfound"); return; }
			while (active < 4 && next < urls.length) {
				active++;
				gmGet(urls[next++], { timeout: 25000 }, (e2, r2) => {
					active--;
					if (finished) return;
					const tok = !e2 && r2 && r2.status === 200 ? allTrailsTokenIn(r2.responseText || "") : "";
					if (tok) { finished = true; done(tok); return; }
					pump();
				});
			}
		};
		pump();
	});
}

const NOTES = {
	blocked: "AllTrails asked for a human check. Open alltrails.com in this browser once, then switch this layer off and on.",
	network: "Couldn't reach AllTrails. Switch this layer off and on to try again.",
	notfound: "Couldn't find AllTrails' map key; their site may have changed.",
};

export class AllTrailsLayerProvider extends LayerProvider {
	create() {
		const PANE = "dwAllTrailsPane";
		let token = "";
		let retried = false;
		let note = null;
		const showNote = (map, reason) => {
			hideNote();
			if (!map || !reason) return;
			note = L.DomUtil.create("div", "dw-at-note", map.getContainer());
			note.innerHTML = _escHtml(NOTES[reason] || NOTES.network) +
				(reason === "blocked" ? ` <a href="${CFG.ALLTRAILS_PAGE}" target="_blank" rel="noopener noreferrer">Open AllTrails ↗</a>` : "");
			L.DomEvent.disableClickPropagation(note);
		};
		const hideNote = () => { if (note && note.parentNode) note.remove(); note = null; };
		const obtain = (layer, fresh) => lookupAllTrailsToken((tok, reason) => {
			token = tok;
			if (!layer._map) return;
			if (tok) { hideNote(); layer.refresh(); } else showNote(layer._map, reason);
		}, { fresh });

		const layer = makeVectorTileLayer({
			label:         "AllTrails",
			pane:          PANE,
			paneZIndex:    414,
			minZoom:       CFG.ALLTRAILS_MIN_ZOOM,
			padBounds:     0.05,
			maxNativeZoom: CFG.ALLTRAILS_MAX_NATIVE_Z,
			attribution:   'Trail map © <a href="https://www.alltrails.com/" target="_blank" rel="noreferrer">AllTrails</a>, ' +
				'© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>',
			isReady: () => !!token,
			tileUrl: (z, x, y) => `${CFG.ALLTRAILS_TILES}/${z}/${x}/${y}.vector.pbf?access_token=${token}`,
			missingIsEmpty: true,
			// A refused tile means the remembered key has been replaced: look it up again, once.
			onTileError: (status) => {
				if ((status !== 401 && status !== 403) || retried) return;
				retried = true;
				token = "";
				obtain(layer, true);
			},
			onAdd: () => { retried = false; if (!token) obtain(layer, false); },
			onRemove: () => hideNote(),
			toElements: atToElements,
			render: (group, elements, tz) => {
				// The drawn line is thin, so a wide invisible one on top takes
				// the hover and the click. A click opens a pop-up whose link
				// goes to AllTrails' Explore page around the clicked spot.
				const line = (el, style, html) => {
					const latlngs = el.geometry.map((g) => [g.lat, g.lon]);
					L.polyline(latlngs, { pane: PANE, interactive: false, ...style }).addTo(group);
					let clicked = null;
					L.polyline(latlngs, { pane: PANE, color: "#000", weight: 14, opacity: 0 })
						.on("click", (e) => { clicked = e.latlng; })
						.bindTooltip(html, { className: "dw-abw-tip", sticky: true })
						.bindPopup(() => atPopupHtml(html, clicked), { className: "dw-abw-popup", maxWidth: 280, autoPan: false })
						.addTo(group);
				};
				// Every path and track: thin, and only once zoomed in enough to tell them apart.
				if (tz >= 12) for (const el of elements) {
					if (el.kind !== "segment") continue;
					const closed = atAccess(el.tags);
					line(el, {
						color: closed ? "#b91c1c" : el.tags.h === "track" ? "#92400e" : "#166534",
						weight: 2, opacity: 0.85, dashArray: closed ? "2 5" : el.tags.h === "track" ? "7 4" : "4 4",
					}, atSegmentHtml(el.tags));
				}
				// Named, waymarked routes on top.
				for (const el of elements) {
					if (el.kind !== "route") continue;
					L.polyline(el.geometry.map((g) => [g.lat, g.lon]), { pane: PANE, color: "#fff", weight: 6, opacity: 0.8, interactive: false }).addTo(group);
					line(el, { color: ROUTE_COLORS[el.tags.type] || "#15803d", weight: 3, opacity: 0.95 }, atRouteHtml(el.tags));
				}
			},
		});
		return layer;
	}
}
