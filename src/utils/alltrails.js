// AllTrails has no layer here: its data service sits behind bot protection
// and its robots.txt disallows it. This only builds a normal link to its
// Explore page for a map view, using the page's own bounding-box parameters
// (b_tl_* = top-left corner, b_br_* = bottom-right).
export function allTrailsExploreUrl(view) {
	const v = view || {};
	const n = Number(v.north), s = Number(v.south), w = Number(v.west), e = Number(v.east);
	if (![n, s, w, e].every(Number.isFinite) || n <= s || e <= w) return "";
	if (n > 90 || s < -90 || w < -180 || e > 180) return "";
	const f = (x) => x.toFixed(5);
	return "https://www.alltrails.com/explore" +
		`?b_tl_lat=${f(n)}&b_tl_lng=${f(w)}&b_br_lat=${f(s)}&b_br_lng=${f(e)}`;
}

// A view of about `km` kilometres across centred on a point, for when the
// map itself is zoomed too far in or out to be a useful AllTrails search.
export function allTrailsViewAround(lat, lng, km) {
	const half = (km || 10) / 2;
	const dLat = half / 111.32;
	const dLng = half / (111.32 * Math.max(0.1, Math.cos(lat * Math.PI / 180)));
	return {
		north: Math.min(90, lat + dLat), south: Math.max(-90, lat - dLat),
		west: Math.max(-180, lng - dLng), east: Math.min(180, lng + dLng),
	};
}

/* -- AllTrails trail map -------------------------------------------------
 * AllTrails draws its map from vector tiles it hosts on Mapbox, read with
 * the public Mapbox token its own pages use. That token is not kept in this
 * script: it is looked up from AllTrails' pages in the user's browser and
 * remembered there. These helpers do the looking.
 */

// Script files AllTrails' Explore page loads, in page order. Only https
// "_next/static/chunks" files are returned; anything else in the HTML is ignored.
export function allTrailsChunkUrls(html) {
	const out = [];
	const re = /https:\/\/[a-z0-9.-]+\/[A-Za-z0-9_\-/]*_next\/static\/chunks\/[A-Za-z0-9_\-.]+\.js/g;
	for (const m of String(html || "").match(re) || []) if (!out.includes(m)) out.push(m);
	return out.slice(0, 150);
}

// The public Mapbox token for the "alltrails" account inside a script's
// text, or "". A token for any other account (Mapbox's own examples) is skipped.
export function allTrailsTokenIn(text) {
	for (const tok of String(text || "").match(/pk\.[A-Za-z0-9_-]{50,}\.[A-Za-z0-9_-]{15,}/g) || []) {
		try {
			const payload = JSON.parse(atob(tok.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
			if (payload && payload.u === "alltrails") return tok;
		} catch (_) { /* not a token */ }
	}
	return "";
}
