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
