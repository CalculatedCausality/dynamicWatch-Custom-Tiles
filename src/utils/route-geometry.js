// Route-corridor geometry for [lng, lat] paths: distances along the planned
// route, nearest-pass lookup, and the slippy-map tiles a corridor touches.
const EARTH_R = 6371008.8;
const RAD = Math.PI / 180;
const M_PER_DEG_LAT = EARTH_R * RAD;

const validPoint = (p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]);

export function haversine(a, b) {
	const dLat = (b[1] - a[1]) * RAD, dLng = (b[0] - a[0]) * RAD;
	const s = Math.sin(dLat / 2) ** 2 +
		Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLng / 2) ** 2;
	return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Join the planner's per-segment paths into continuous parts. Consecutive
// segments share their end/start marker; a larger gap starts a new part so
// distance along the route never includes the jump between separate lines.
export function routeParts(paths, joinMeters = 30) {
	const parts = [];
	let current = null;
	for (const path of paths || []) {
		const points = (path || []).filter(validPoint);
		if (points.length < 2) continue;
		const continues = current &&
			haversine(current[current.length - 1], points[0]) <= joinMeters;
		if (!continues) {
			current = [];
			parts.push(current);
		}
		for (const p of continues ? points.slice(1) : points) {
			const last = current[current.length - 1];
			if (!last || last[0] !== p[0] || last[1] !== p[1]) current.push([p[0], p[1]]);
		}
	}
	return parts.filter((part) => part.length > 1);
}

// Cumulative metres per vertex; later parts continue the running total.
export function measureRoute(parts) {
	let total = 0, latSum = 0, count = 0;
	const measured = [];
	for (const points of parts || []) {
		const cum = [total];
		for (let i = 1; i < points.length; i++) {
			total += haversine(points[i - 1], points[i]);
			cum.push(total);
		}
		for (const p of points) { latSum += p[1]; count++; }
		measured.push({ points, cum });
	}
	return { parts: measured, total, lat0: count ? latSum / count : 0 };
}

// Spatial index for nearest-pass queries. The route is projected onto a
// local equirectangular plane centred on its mean latitude, which keeps
// corridor offsets within a few percent across a long day's route.
export function createRouteIndex(route, radius) {
	const kx = M_PER_DEG_LAT * Math.cos(route.lat0 * RAD);
	const ky = M_PER_DEG_LAT;
	const cell = Math.max(radius * 2, 200);
	const grid = new Map();
	const add = (key, seg) => {
		const list = grid.get(key);
		if (list) list.push(seg);
		else grid.set(key, [seg]);
	};
	for (const { points, cum } of route.parts) {
		for (let i = 1; i < points.length; i++) {
			const seg = {
				ax: points[i - 1][0] * kx, ay: points[i - 1][1] * ky,
				bx: points[i][0] * kx, by: points[i][1] * ky,
				along: cum[i - 1], len: cum[i] - cum[i - 1],
			};
			const x0 = Math.floor((Math.min(seg.ax, seg.bx) - radius) / cell);
			const x1 = Math.floor((Math.max(seg.ax, seg.bx) + radius) / cell);
			const y0 = Math.floor((Math.min(seg.ay, seg.by) - radius) / cell);
			const y1 = Math.floor((Math.max(seg.ay, seg.by) + radius) / cell);
			for (let cx = x0; cx <= x1; cx++) {
				for (let cy = y0; cy <= y1; cy++) add(cx + "," + cy, seg);
			}
		}
	}
	return { kx, ky, cell, grid, radius, total: route.total };
}

// Every distinct pass of the route within `radius` of a point, earliest
// first: an out-and-back route returns one entry per direction. Each entry
// is the closest approach on that pass ({ along, offset } in metres).
export function routePasses(index, lng, lat) {
	const px = lng * index.kx, py = lat * index.ky;
	const segs = index.grid.get(Math.floor(px / index.cell) + "," + Math.floor(py / index.cell));
	if (!segs) return [];
	const hits = [];
	for (const s of segs) {
		const dx = s.bx - s.ax, dy = s.by - s.ay;
		const len2 = dx * dx + dy * dy;
		const t = len2 ? Math.max(0, Math.min(1, ((px - s.ax) * dx + (py - s.ay) * dy) / len2)) : 0;
		const offset = Math.hypot(px - (s.ax + t * dx), py - (s.ay + t * dy));
		if (offset <= index.radius) hits.push({ along: s.along + t * s.len, offset });
	}
	hits.sort((a, b) => a.along - b.along);
	const gap = Math.max(index.radius * 4, 400);
	const passes = [];
	let group = null;
	for (const hit of hits) {
		if (!group || hit.along - group.last > gap) {
			group = { best: hit, last: hit.along };
			passes.push(group);
		} else {
			group.last = hit.along;
			if (hit.offset < group.best.offset) group.best = hit;
		}
	}
	return passes.map((g) => g.best);
}

export function lngLatToTile(lng, lat, z) {
	const n = 2 ** z;
	const clampedLat = Math.max(-85.0511, Math.min(85.0511, lat)) * RAD;
	const x = Math.floor((lng + 180) / 360 * n);
	const y = Math.floor((1 - Math.log(Math.tan(clampedLat) + 1 / Math.cos(clampedLat)) / Math.PI) / 2 * n);
	return [Math.max(0, Math.min(n - 1, x)), Math.max(0, Math.min(n - 1, y))];
}

// Tiles covering the corridor within `radius` of the route. Samples every
// `step` metres and adds the tiles touching each sample's buffered box, so
// no corridor point lies outside the returned set.
export function routeTiles(route, radius, z, step = 200) {
	const tiles = new Map();
	const reach = radius + step;
	const addBox = (p) => {
		const dLat = reach / M_PER_DEG_LAT;
		const dLng = dLat / Math.max(0.01, Math.cos(p[1] * RAD));
		const [x0, y0] = lngLatToTile(p[0] - dLng, p[1] + dLat, z);
		const [x1, y1] = lngLatToTile(p[0] + dLng, p[1] - dLat, z);
		for (let x = x0; x <= x1; x++) {
			for (let y = y0; y <= y1; y++) tiles.set(x + "/" + y, [x, y]);
		}
	};
	for (const { points } of route.parts) {
		addBox(points[0]);
		for (let i = 1; i < points.length; i++) {
			const a = points[i - 1], b = points[i];
			const steps = Math.ceil(haversine(a, b) / step);
			for (let k = 1; k <= steps; k++) {
				const t = k / steps;
				addBox([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
			}
		}
	}
	return [...tiles.values()].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}
