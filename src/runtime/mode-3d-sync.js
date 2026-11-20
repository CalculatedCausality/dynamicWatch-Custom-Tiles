// Pure helpers for keeping the 3D (Mapbox) scene in step with Leaflet
// without rebuilding what hasn't changed. No DOM, no Mapbox: unit-tested.

// Identity of a mirrored raster source. Two specs with the same key draw the
// same tiles, so the existing Mapbox source can stay (no refetch, no flash).
export function rasterKey(spec) {
	return spec ? `${spec.url}|${spec.maxzoom}` : "";
}

// Decide which mirrored raster overlays to drop and which to add.
// `existing` maps key → entry (as recorded when it was added); `specs` is
// the wanted list, bottom-up. `force` rebuilds everything (a layer said its
// tiles changed behind an unchanged URL). Duplicate specs are added once.
export function planRasterOverlays(existing, specs, force = false) {
	const wanted = new Map();
	for (const spec of specs || []) {
		const key = rasterKey(spec);
		if (!wanted.has(key)) wanted.set(key, spec);
	}
	const remove = [], keep = [], add = [];
	for (const [key, entry] of existing || []) {
		if (!force && wanted.has(key)) keep.push({ key, entry, spec: wanted.get(key) });
		else remove.push({ key, entry });
	}
	const kept = new Set(keep.map((k) => k.key));
	for (const [key, spec] of wanted) if (!kept.has(key)) add.push({ key, spec });
	// Bottom-up draw order of the wanted keys.
	return { remove, keep, add, order: [...wanted.keys()] };
}

// Moves that put the layers of `want` (bottom-up) that exist into that
// order, as [id, beforeId] pairs to apply in sequence; beforeId undefined
// means "to the top". Working down from the top keeps every earlier move
// valid, whatever order the layers started in.
export function layerMoves(want, exists) {
	const present = (want || []).filter((id, i, all) => exists(id) && all.indexOf(id) === i);
	if (!present.length) return [];
	const moves = [[present[present.length - 1], undefined]];
	for (let i = present.length - 2; i >= 0; i--) moves.push([present[i], present[i + 1]]);
	return moves;
}

// One short line for a Mapbox `error` event, without query strings (tile
// URLs carry API keys and tokens). `key` groups repeats of the same fault.
export function describeMapError(event) {
	const raw = String(event?.error?.message || event?.message || "unknown error");
	const message = raw.replace(/\?[^\s"')]*/g, "").replace(/\s+/g, " ").trim().slice(0, 200);
	const source = event?.sourceId ? String(event.sourceId) : "";
	return { key: source + "|" + message.slice(0, 80), text: (source ? source + ": " : "") + message };
}
