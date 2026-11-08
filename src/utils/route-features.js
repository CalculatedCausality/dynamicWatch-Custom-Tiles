// Course features on the route itself, for the watch's Up Ahead list: creek
// crossings, named track and road sections, and climbs. Pure functions over
// a measured route (route-geometry.js), its 50 m samples (route-profile.js),
// map-tile lines as [lng, lat] arrays, and sampled elevations.
import { smoothElevations } from "./route-profile.js";

const M_PER_DEG = 6371008.8 * Math.PI / 180;

// Common words shortened when a waypoint name would not otherwise fit.
const ABBREVIATIONS = [
	["National Park", "NP"], ["Conservation Park", "CP"], ["Creek", "Ck"], ["Track", "Trk"],
	["Trail", "Trl"], ["Road", "Rd"], ["Street", "St"], ["Mountain", "Mtn"], ["Mount", "Mt"],
	["Drive", "Dr"], ["Avenue", "Ave"], ["Highway", "Hwy"], ["Lane", "Ln"], ["Parade", "Pde"],
	["Crescent", "Cres"], ["Terrace", "Tce"], ["Esplanade", "Esp"], ["Boulevard", "Bvd"],
	["Lookout", "Lkt"],
].map(([word, short]) => [new RegExp("\\b" + word + "\\b", "g"), short]);

export function abbreviate(name) {
	return ABBREVIATIONS.reduce((text, [re, short]) => text.replace(re, short), String(name || ""));
}

// Uniform grid over line segments for proximity and crossing queries.
function segmentGrid(segments, cell) {
	const grid = new Map();
	segments.forEach((s, i) => {
		const x0 = Math.floor(Math.min(s.a[0], s.b[0]) / cell), x1 = Math.floor(Math.max(s.a[0], s.b[0]) / cell);
		const y0 = Math.floor(Math.min(s.a[1], s.b[1]) / cell), y1 = Math.floor(Math.max(s.a[1], s.b[1]) / cell);
		for (let x = x0; x <= x1; x++) {
			for (let y = y0; y <= y1; y++) {
				const key = x + "," + y;
				if (!grid.has(key)) grid.set(key, []);
				grid.get(key).push(i);
			}
		}
	});
	return {
		near(minLng, minLat, maxLng, maxLat) {
			const found = new Set();
			for (let x = Math.floor(minLng / cell); x <= Math.floor(maxLng / cell); x++) {
				for (let y = Math.floor(minLat / cell); y <= Math.floor(maxLat / cell); y++) {
					for (const i of grid.get(x + "," + y) || []) found.add(i);
				}
			}
			return found;
		},
	};
}

function routeSegments(route) {
	const segments = [];
	for (const { points, cum } of route.parts) {
		for (let i = 1; i < points.length; i++) {
			segments.push({ a: points[i - 1], b: points[i], from: cum[i - 1], to: cum[i] });
		}
	}
	return segments;
}

// Fraction t along p→q where it crosses a→b, or null.
function crossAt(p, q, a, b) {
	const rx = q[0] - p[0], ry = q[1] - p[1], sx = b[0] - a[0], sy = b[1] - a[1];
	const d = rx * sy - ry * sx;
	if (!d) return null;
	const t = ((a[0] - p[0]) * sy - (a[1] - p[1]) * sx) / d;
	const u = ((a[0] - p[0]) * ry - (a[1] - p[1]) * rx) / d;
	return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

const metresBetween = (p, q) => {
	const k = Math.cos((p[1] + q[1]) / 2 * Math.PI / 180);
	return Math.hypot((q[0] - p[0]) * k, q[1] - p[1]) * M_PER_DEG;
};

// Where the route crosses a waterway. Crossings within `mergeM` along the
// route are one (a route that wanders along a creek, or a creek split across
// map tiles); repeat passes over the same spot share one feature.
export function creekCrossings(route, waterways, { mergeM = 150 } = {}) {
	const segments = routeSegments(route);
	if (!segments.length) return [];
	const grid = segmentGrid(segments, 0.01);
	const hits = [];
	for (const w of waterways || []) {
		const line = w.line || [];
		for (let i = 1; i < line.length; i++) {
			const p = line[i - 1], q = line[i];
			for (const k of grid.near(Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[0], q[0]), Math.max(p[1], q[1]))) {
				const s = segments[k];
				const t = crossAt(s.a, s.b, p, q);
				if (t == null) continue;
				hits.push({
					along: s.from + (s.to - s.from) * t, name: w.name || "", cls: w.cls || "",
					lng: s.a[0] + (s.b[0] - s.a[0]) * t, lat: s.a[1] + (s.b[1] - s.a[1]) * t,
				});
			}
		}
	}
	hits.sort((x, y) => x.along - y.along);
	const merged = [];
	for (const hit of hits) {
		const last = merged[merged.length - 1];
		if (last && hit.along - last.along <= mergeM) {
			if (!last.name && hit.name) Object.assign(last, { name: hit.name, cls: hit.cls });
			continue;
		}
		merged.push({ ...hit });
	}
	const features = [];
	for (const hit of merged) {
		const same = features.find((f) => metresBetween([f.lng, f.lat], [hit.lng, hit.lat]) < 30);
		if (same) { same.passes.push(hit.along); if (!same.name) same.name = hit.name; continue; }
		features.push({ lng: hit.lng, lat: hit.lat, name: hit.name, cls: hit.cls, passes: [hit.along] });
	}
	return features;
}

// Where the route moves onto a differently named track or road, judged from
// the named line nearest each sample. Gaps up to `gapM` (unnamed links) and
// brief runs under `briefM` on another way (side roads at a junction) don't
// break a stretch; stretches under `minM` don't count.
export function trackSections(samples, roads, { snapM = 15, minM = 300, gapM = 100, briefM = 150, skipStartM = 100 } = {}) {
	const segments = [];
	for (const r of roads || []) {
		if (!r.name) continue;
		for (let i = 1; i < (r.line || []).length; i++) segments.push({ a: r.line[i - 1], b: r.line[i], name: r.name, cls: r.cls || "" });
	}
	if (!segments.length || !samples.length) return [];
	const grid = segmentGrid(segments, 0.002);
	const pad = snapM / M_PER_DEG;
	const nearest = (s) => {
		const k = Math.cos(s.lat * Math.PI / 180);
		let best = null, bestD = snapM;
		for (const i of grid.near(s.lng - pad / k, s.lat - pad, s.lng + pad / k, s.lat + pad)) {
			const g = segments[i];
			const ax = (g.a[0] - s.lng) * k, ay = g.a[1] - s.lat, bx = (g.b[0] - s.lng) * k, by = g.b[1] - s.lat;
			const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
			const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
			const d = Math.hypot(ax + t * dx, ay + t * dy) * M_PER_DEG;
			if (d <= bestD) { best = g; bestD = d; }
		}
		return best;
	};
	const runs = [];
	let run = null;
	for (const s of samples) {
		if (s.partStart && run) { runs.push(run); run = null; }
		const road = nearest(s);
		if (!road) {
			if (run && s.along - run.to > gapM) { runs.push(run); run = null; }
			continue;
		}
		if (run && run.name === road.name) { run.to = s.along; continue; }
		if (run) runs.push(run);
		run = { name: road.name, cls: road.cls, from: s.along, to: s.along, lng: s.lng, lat: s.lat };
	}
	if (run) runs.push(run);
	const merged = [];
	for (const r of runs) {
		if (r.to - r.from < briefM) continue;
		const last = merged[merged.length - 1];
		if (last && last.name === r.name) last.to = r.to;
		else merged.push({ ...r });
	}
	const sections = [];
	let lastName = null;
	for (const r of merged) {
		if (r.to - r.from < minM) continue;
		if (r.name !== lastName && r.from >= skipStartM) sections.push({ along: r.from, to: r.to, name: r.name, cls: r.cls, lng: r.lng, lat: r.lat });
		lastName = r.name;
	}
	return sections;
}

// Highs and lows of a profile, ignoring reversals of `hysteresis` metres or less.
function turningPoints(values, hysteresis) {
	const points = [{ i: 0, v: values[0] }];
	let dir = 0, hi = { i: 0, v: values[0] }, lo = { i: 0, v: values[0] };
	for (let i = 1; i < values.length; i++) {
		const v = values[i];
		if (v > hi.v) hi = { i, v };
		if (v < lo.v) lo = { i, v };
		if (dir >= 0 && hi.v - v > hysteresis) {
			if (hi.i > points[points.length - 1].i) points.push(hi);
			dir = -1;
			lo = { i, v };
		} else if (dir <= 0 && v - lo.v > hysteresis) {
			if (lo.i > points[points.length - 1].i) points.push(lo);
			dir = 1;
			hi = { i, v };
		}
	}
	const end = dir > 0 ? hi : dir < 0 ? lo : { i: values.length - 1, v: values[values.length - 1] };
	if (end.i > points[points.length - 1].i) points.push(end);
	return points;
}

// Split a rise [ia, ib] wherever it levels out (`flatM` metres gaining less
// than `flatGrade`), then trim each piece to where it really climbs: from the
// last point within `trim` of the piece's gain above its low to the first
// within that of its high. Returns [start, end, low, high] per piece.
function climbPieces(samples, ele, ia, ib, flatM, flatGrade) {
	const flat = new Uint8Array(ib - ia + 1);
	for (let j = ia, k = ia; j <= ib; j++) {
		while (k < ib && samples[k].along - samples[j].along < flatM) k++;
		const run = samples[k].along - samples[j].along;
		if (run >= flatM && ele[k] - ele[j] < flatGrade * run) flat.fill(1, j - ia, k - ia + 1);
	}
	const pieces = [];
	for (let j = ia; j <= ib; j++) {
		if (flat[j - ia]) continue;
		let end = j;
		while (end < ib && !flat[end + 1 - ia]) end++;
		let s = j, e = end;
		while (s > ia && ele[s - 1] < ele[s]) s--;
		while (e < ib && ele[e + 1] > ele[e]) e++;
		let low = s, high = s;
		for (let m = s; m <= e; m++) if (ele[m] > ele[high]) high = m;
		for (let m = s; m <= high; m++) if (ele[m] <= ele[low]) low = m;
		const tol = Math.max(1, 0.03 * (ele[high] - ele[low]));
		let start = low, top = high;
		while (start < top && ele[start + 1] <= ele[low] + tol) start++;
		while (top > start && ele[top - 1] >= ele[high] - tol) top--;
		if (top > start) pieces.push([start, top, ele[low], ele[high]]);
		j = end;
	}
	return pieces;
}

// Climbs gaining at least `minGain` metres at `minGrade` or steeper on
// average, with the steepest stretch of about `steepM` metres. Elevations are
// smoothed first; descents over `hysteresis` metres, level stretches, unknown
// elevations and gaps between route parts end a climb.
export function findClimbs(samples, elevations, {
	minGain = 40, minGrade = 0.03, hysteresis = 12, steepM = 200, flatM = 400, flatGrade = 0.01,
} = {}) {
	if (!elevations || elevations.length !== samples.length) return [];
	const ele = smoothElevations(elevations, 5);
	const climbs = [];
	let start = 0;
	for (let i = 1; i <= samples.length; i++) {
		const breaks = i === samples.length || samples[i].partStart || !Number.isFinite(ele[i]) || !Number.isFinite(ele[start]);
		if (!breaks) continue;
		if (Number.isFinite(ele[start]) && i - start > 2) {
			const offset = start;
			const values = Array.from(ele.subarray ? ele.subarray(start, i) : ele.slice(start, i));
			const points = turningPoints(values, hysteresis);
			for (let k = 1; k < points.length; k++) {
				const a = points[k - 1], b = points[k];
				if (b.v <= a.v) continue;
				for (const [ia, ib, base, top] of climbPieces(samples, ele, a.i + offset, b.i + offset, flatM, flatGrade)) {
					const gain = top - base, length = samples[ib].along - samples[ia].along;
					if (gain < minGain || !(length > 0) || gain / length < minGrade) continue;
					let steepest = gain / length;
					for (let j = ia, m = ia; j < ib; j++) {
						while (m < ib && samples[m].along - samples[j].along < steepM) m++;
						const run = samples[m].along - samples[j].along;
						if (run >= steepM * 0.75) steepest = Math.max(steepest, (ele[m] - ele[j]) / run);
					}
					climbs.push({
						from: samples[ia].along, to: samples[ib].along, gain, length, grade: gain / length, steepest,
						base, top, startIndex: ia, endIndex: ib,
					});
				}
			}
		}
		start = i;
	}
	return climbs;
}

const gainText = (metres, metric) => metric ? Math.round(metres) + "m" : Math.round(metres * 3.28084) + "ft";

const firstFitting = (candidates, maxLength) =>
	candidates.find((text) => text.length <= maxLength) || candidates[candidates.length - 1];

// "Climb 171m 3.7k", shortening to "Climb 171m" or "+171m" to fit.
export function climbLabel(climb, metric = true, maxLength = 16) {
	const gain = gainText(climb.gain, metric);
	const d = climb.length / (metric ? 1000 : 1609.344);
	return firstFitting([`Climb ${gain} ${d.toFixed(1)}${metric ? "k" : "mi"}`, `Climb ${gain}`, `+${gain}`], maxLength);
}

// "Top 171m climb", shortening to "Top 171m" or "Top" to fit.
export function climbTopLabel(climb, metric = true, maxLength = 16) {
	const gain = gainText(climb.gain, metric);
	return firstFitting([`Top ${gain} climb`, `Top ${gain}`, "Top"], maxLength);
}
