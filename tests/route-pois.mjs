// Run with `node --test tests/route-pois.mjs`; source modules only, no network.
import test from "node:test";
import assert from "node:assert/strict";
import {
	createRouteIndex, lngLatToTile, longestGap, measureRoute, routeParts, routePasses,
	routeSignature, routeTiles, sliceRoute,
} from "../src/utils/route-geometry.js";
import {
	RoutePoiController, SUPPLY_GAPS, classifyPoi, decodePoiTile, findRoutePois, formatRange,
	formatRouteDistance, selectRoutePois, supplyGap, waypointName,
} from "../src/providers/route-pois.js";

// ~111 m per 0.001° of latitude; routes run north from the equator so
// longitude offsets are metric too.
const north = (km) => [0, km / 111.195];
const east = (m) => m / 111195;

test("planner segments join into continuous parts with cumulative distance", () => {
	const parts = routeParts([
		[north(0), north(1)],
		[north(1), north(2)],
		[[1, 0], [1, 0.009]], // a separate line, ~111 km away
		[[5, 5]], // single point: ignored
	]);
	assert.equal(parts.length, 2);
	assert.equal(parts[0].length, 3, "shared joint point not duplicated");
	const route = measureRoute(parts);
	assert.ok(Math.abs(route.parts[0].cum[2] - 2000) < 1);
	// The second line continues the running total without the 111 km jump.
	assert.ok(Math.abs(route.parts[1].cum[0] - 2000) < 1);
	assert.ok(Math.abs(route.total - 3000.7) < 2);
});

test("out-and-back routes report one pass per direction; distant points none", () => {
	const route = measureRoute(routeParts([[north(0), north(5), [east(30), north(0)[1]]]]));
	const index = createRouteIndex(route, 100);
	const passes = routePasses(index, east(20), north(1)[1]);
	assert.equal(passes.length, 2);
	assert.ok(Math.abs(passes[0].along - 1000) < 5, `outbound pass at ${passes[0].along}`);
	assert.ok(Math.abs(passes[1].along - 9000) < 5, `return pass at ${passes[1].along}`);
	assert.ok(passes[0].offset < 25 && passes[1].offset < 25);
	assert.deepEqual(routePasses(index, east(400), north(1)[1]), []);
	assert.deepEqual(routePasses(index, 40, 40), []);
});

test("corridor tiles include points a full radius from the route", () => {
	const route = measureRoute(routeParts([[[153.0, -26.7], [153.03, -26.7]]]));
	const tiles = routeTiles(route, 250, 14);
	const has = (lng, lat) => {
		const [x, y] = lngLatToTile(lng, lat, 14);
		return tiles.some((t) => t[0] === x && t[1] === y);
	};
	const dLat = 250 / 111195;
	for (const lng of [153.0, 153.007, 153.015, 153.029]) {
		assert.ok(has(lng, -26.7 + dLat) && has(lng, -26.7 - dLat), `corridor edge at ${lng}`);
	}
	assert.ok(tiles.length < 20, `${tiles.length} tiles for a 3 km corridor`);
});

test("OpenMapTiles classes map to POI categories", () => {
	assert.deepEqual(classifyPoi("poi", { class: "drinking_water", subclass: "drinking_water" }),
		{ category: "water", type: "drinking_water" });
	assert.deepEqual(classifyPoi("poi", { class: "grocery", subclass: "supermarket" }),
		{ category: "shop", type: "supermarket" });
	assert.deepEqual(classifyPoi("poi", { class: "attraction", subclass: "viewpoint" }),
		{ category: "views", type: "viewpoint" });
	assert.deepEqual(classifyPoi("mountain_peak", { class: "peak", ele: 210 }),
		{ category: "views", type: "peak" });
	assert.equal(classifyPoi("mountain_peak", { class: "saddle" }), null);
	assert.equal(classifyPoi("poi", { class: "parking", subclass: "parking" }), null);
	assert.equal(classifyPoi("poi", { class: "fuel", subclass: "charging_station" }), null);
	assert.equal(classifyPoi("transportation_name", { class: "toilets" }), null);
});

// -- Minimal MVT encoder for synthetic tiles --------------------------------
const varint = (n) => { const out = []; do { let b = n & 0x7f; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b); } while (n); return out; };
const zig = (n) => (n << 1) ^ (n >> 31);
const bytes = (s) => [...Buffer.from(s, "utf8")];
const field = (num, wt, payload) => [...varint((num << 3) | wt), ...(wt === 2 ? [...varint(payload.length), ...payload] : payload)];
function encodeLayer(name, features) {
	const keys = [], values = [], keyIdx = new Map(), valIdx = new Map();
	const enc = [];
	for (const { props, x, y } of features) {
		const tags = [];
		for (const [k, v] of Object.entries(props)) {
			if (!keyIdx.has(k)) { keyIdx.set(k, keys.length); keys.push(k); }
			const vk = typeof v + ":" + v;
			if (!valIdx.has(vk)) { valIdx.set(vk, values.length); values.push(v); }
			tags.push(keyIdx.get(k), valIdx.get(vk));
		}
		enc.push(field(2, 2, [
			...field(2, 2, tags.flatMap(varint)),
			...field(3, 0, varint(1)),
			...field(4, 2, [9, zig(x), zig(y)].flatMap(varint)),
		]));
	}
	return field(3, 2, [
		...field(15, 0, varint(2)),
		...field(1, 2, bytes(name)),
		...enc.flat(),
		...keys.flatMap((k) => field(3, 2, bytes(k))),
		...values.flatMap((v) => field(4, 2, typeof v === "number" ? field(4, 0, varint(v)) : field(1, 2, bytes(v)))),
		...field(5, 0, varint(4096)),
	]);
}

test("vector tiles decode to located POIs and bus stops", () => {
	const [x, y] = [15157, 9453];
	const buffer = new Uint8Array([
		...encodeLayer("poi", [
			{ props: { class: "drinking_water", subclass: "drinking_water", name: "Bubbler" }, x: 2048, y: 2048 },
			{ props: { class: "bus", subclass: "bus_stop", name: "Stop 1" }, x: 100, y: 100 },
			{ props: { class: "parking", subclass: "parking" }, x: 10, y: 10 },
		]),
		...encodeLayer("mountain_peak", [{ props: { class: "peak", name: "Mt Test", ele: 210 }, x: -50, y: 4100 }]),
		...encodeLayer("water", [{ props: { class: "lake" }, x: 1, y: 1 }]),
	]).buffer;
	const { pois, busStops } = decodePoiTile(buffer, 14, x, y);
	assert.equal(busStops.length, 1);
	assert.equal(pois.length, 2);
	const water = pois.find((p) => p.type === "drinking_water");
	assert.equal(water.name, "Bubbler");
	const n = 2 ** 14;
	assert.ok(Math.abs(water.lng - ((x + 0.5) / n * 360 - 180)) < 1e-9);
	const peak = pois.find((p) => p.type === "peak");
	assert.equal(peak.ele, 210);
	assert.equal(peak.category, "views");
});

test("route selection merges tile duplicates, drops bus shelters and orders by distance", () => {
	const route = measureRoute(routeParts([[north(0), north(3)]]));
	const poi = (type, category, km, offM, name = "") =>
		({ type, category, name, ele: null, lat: north(km)[1], lng: east(offM) });
	const tiles = [
		{ pois: [poi("cafe", "food", 2, 30, "Cafe A"), poi("toilets", "toilets", 1, 50),
			poi("shelter", "shelter", 1.5, 10), poi("drinking_water", "water", 0.5, 400)],
		busStops: [[east(12), north(1.5)[1]]] },
		// The same cafe from a neighbouring tile's buffer, sub-metre apart.
		{ pois: [poi("cafe", "food", 2, 30.4, "Cafe A"), poi("shelter", "shelter", 2.5, 20, "Lookout hut")],
			busStops: [] },
	];
	const kept = selectRoutePois(tiles, route, 100);
	assert.deepEqual(kept.map((p) => p.type), ["toilets", "cafe", "shelter"]);
	assert.ok(Math.abs(kept[0].along - 1000) < 5 && Math.abs(kept[0].offset - 50) < 2);
	assert.equal(new Set(kept.map((p) => p.id)).size, 3);
	assert.equal(kept[2].name, "Lookout hut");
});

test("waypoint names fit dynamic.watch's limit and fall back to the POI type", () => {
	assert.equal(waypointName({ name: "  Mooloolah   Valley General Store ", type: "convenience" }), "Mooloolah Valley");
	assert.equal(waypointName({ name: "", type: "drinking_water", category: "water" }), "Drinking water");
	assert.equal(waypointName({ name: "", type: "unknown", category: "water" }, 4), "Wate");
	assert.equal(formatRouteDistance(12345), "12.3 km");
	assert.equal(formatRouteDistance(1609.344, false), "1.0 mi");
});

function fakeTransport(failures = new Map()) {
	const calls = [];
	let active = 0, maxActive = 0;
	const pending = [];
	const fetchTile = (url, cb) => {
		calls.push(url);
		active++; maxActive = Math.max(maxActive, active);
		const left = failures.get(url) || 0;
		pending.push(() => {
			active--;
			if (left) { failures.set(url, left - 1); cb(new Error("boom")); }
			else cb(null, new Uint8Array(encodeLayer("poi", [
				{ props: { class: "toilets", subclass: "toilets" }, x: 0, y: 0 }])).buffer);
		});
		return { abort() {} };
	};
	const flush = async () => { while (pending.length) { pending.shift()(); await null; } };
	return { calls, fetchTile, flush, get maxActive() { return maxActive; } };
}

test("tile loading is bounded, retries once, reports partial failure and reuses its cache", async () => {
	const template = "https://tiles.openfreemap.org/test/{z}/{x}/{y}.pbf";
	const paths = [[[153.0, -26.7], [153.12, -26.7]]];
	const firstBad = "https://tiles.openfreemap.org/test/14/";
	const transport = fakeTransport();
	let failedUrl = null;
	const wrapped = {
		...transport,
		fetchTile: (url, cb) => {
			if (!failedUrl && url.startsWith(firstBad)) failedUrl = url;
			if (url === failedUrl) { transport.calls.push(url); cb(new Error("down")); return { abort() {} }; }
			return transport.fetchTile(url, cb);
		},
	};
	let result = null;
	findRoutePois(paths, 100, { resolveTemplate: (cb) => cb(null, template), fetchTile: wrapped.fetchTile },
		(err, value) => { assert.equal(err, null); result = value; });
	for (let i = 0; i < 200 && !result; i++) await transport.flush();
	assert.ok(result, "search completed");
	assert.equal(result.failedTiles, 1, "one tile failed after its retry");
	assert.equal(transport.calls.filter((u) => u === failedUrl).length, 2, "failed tile retried once");
	assert.ok(transport.maxActive <= 6, `concurrency ${transport.maxActive}`);
	const firstCalls = transport.calls.length;
	let again = null;
	findRoutePois(paths, 100, { resolveTemplate: (cb) => cb(null, template), fetchTile: wrapped.fetchTile },
		(err, value) => { again = value; });
	for (let i = 0; i < 20 && !again; i++) await transport.flush();
	assert.ok(again);
	assert.equal(transport.calls.length - firstCalls, 2, "only the uncached failed tile is requested again");
});

test("searches fail clearly without a route, when too long, or when no tile loads", () => {
	const errors = [];
	findRoutePois([], 100, {}, (err) => errors.push(err.code));
	findRoutePois([[[0, 0], [12, 0]]], 500, {}, (err) => errors.push(err.code));
	findRoutePois([[[10, 10], [10.01, 10]]], 100, {
		resolveTemplate: (cb) => cb(null, "https://tiles.openfreemap.org/x/{z}/{x}/{y}.pbf"),
		fetchTile: (_url, cb) => { cb(new Error("offline")); return { abort() {} }; },
	}, (err) => errors.push(err.code));
	findRoutePois([[[10, 10], [10.01, 10]]], 100, { resolveTemplate: (cb) => cb(new Error("dns")) },
		(err) => errors.push(err.code));
	assert.deepEqual(errors, ["noroute", "toolong", "tiles", "tiles"]);
});

test("adding POIs creates named planner waypoints once, without duplicates or overflow", () => {
	const added = [];
	const marker = (lat, lng) => ({ getLatLng: () => ({ lat, lng }) });
	const plan = {
		waypoints: [{ marker: marker(north(2)[1], 0) }],
		waypointNameLength: 16, waypointCountMax: 3, unitsMetric: true,
		addWaypoint(latLng, name, interactive) {
			added.push({ latLng, name, interactive });
			const wp = { marker: marker(latLng[0], latLng[1]), name };
			this.waypoints.push(wp);
			return wp;
		},
	};
	globalThis.window = { leafletPlan: plan, confirm: () => true };
	try {
		const ctl = new RoutePoiController({});
		const poi = (id, km, name) => ({ id, name, type: "drinking_water", category: "water",
			lat: north(km)[1], lng: 0, passes: [{ along: km * 1000, offset: 0 }], along: km * 1000, offset: 0 });
		const pois = [poi("a", 1, "Tank at the old school"), poi("b", 2, ""), poi("c", 3, ""), poi("d", 4, "")];
		assert.equal(ctl._addWaypoint(pois[0]), true);
		assert.deepEqual(added[0], { latLng: [pois[0].lat, 0], name: "Tank at the old", interactive: false });
		assert.equal(ctl._addWaypoint(pois[0]), false, "already added");
		assert.equal(ctl._addWaypoint(pois[1]), false, "existing waypoint at the same spot");
		ctl._pois = pois;
		ctl._addAll();
		assert.deepEqual(added.map((a) => a.name), ["Tank at the old", "Drinking water"]);
		assert.equal(plan.waypoints.length, 3);
		assert.match(ctl._status.text, /maximum of 3 waypoints/);
	} finally { delete globalThis.window; }
});

test("longest gap is bounded by the route's start and end", () => {
	assert.deepEqual(longestGap([], 10000), { from: 0, to: 10000, length: 10000 });
	assert.deepEqual(longestGap([2000, 9000, 3000], 10000), { from: 3000, to: 9000, length: 6000 });
	assert.deepEqual(longestGap([1000], 10000), { from: 1000, to: 10000, length: 9000 });
	assert.deepEqual(longestGap([-50, 12000, 9500], 10000), { from: 0, to: 9500, length: 9500 });
	assert.equal(longestGap([1], 0), null);
	assert.equal(formatRange(3100, 17300), "3.1–17.3 km");
	assert.equal(formatRange(1609.344, 3218.688, false), "1.0–2.0 mi");
});

test("water gaps count every pass and cafés/shops only for resupply", () => {
	const poi = (category, ...km) => ({ category, passes: km.map((k) => ({ along: k * 1000, offset: 0 })) });
	// Out-and-back: the tap at 2 km is passed again at 18 km.
	const pois = [poi("water", 2, 18), poi("food", 10), poi("toilets", 6), poi("shop", 14)];
	const water = supplyGap(pois, 20000, SUPPLY_GAPS.water);
	assert.deepEqual(water, { from: 2000, to: 18000, length: 16000, count: 1 });
	const resupply = supplyGap(pois, 20000, SUPPLY_GAPS.resupply);
	assert.deepEqual(resupply, { from: 2000, to: 10000, length: 8000, count: 3 });
	assert.deepEqual(supplyGap([poi("toilets", 5)], 20000, SUPPLY_GAPS.water),
		{ from: 0, to: 20000, length: 20000, count: 0 });
});

test("route slices interpolate the stretch, including across separate parts", () => {
	const route = measureRoute(routeParts([[north(0), north(4)], [[1, 0], [1, north(2)[1]]]]));
	const one = sliceRoute(route, 1000, 3000);
	assert.equal(one.length, 1);
	assert.ok(Math.abs(one[0][0][1] - north(1)[1]) < 1e-7 && Math.abs(one[0].at(-1)[1] - north(3)[1]) < 1e-7);
	const across = sliceRoute(route, 3000, 5000);
	assert.equal(across.length, 2, "one polyline per route part");
	assert.ok(Math.abs(across[1][0][1]) < 1e-9 && Math.abs(across[1].at(-1)[1] - north(1)[1]) < 1e-7);
	assert.deepEqual(sliceRoute(route, 7000, 9000), []);
});

test("route signature changes on edits but not when the same route is redrawn", () => {
	const a = [[north(0), north(1)], [north(1), north(2)]];
	const redrawn = a.map((path) => path.map((p) => [p[0], p[1]]));
	assert.equal(routeSignature(a), routeSignature(redrawn));
	assert.notEqual(routeSignature(a), routeSignature([[north(0), north(1)], [north(1), north(2.01)]]));
	assert.notEqual(routeSignature(a), routeSignature([a.flat()]), "segmenting is part of the route");
	assert.notEqual(routeSignature(a), routeSignature([a[1], a[0]]), "segment order matters");
	assert.equal(routeSignature([[]]), routeSignature([[[NaN, 1]]]), "invalid points are ignored");
});

test("an edited route re-runs the search once it has settled, not while it is changing", () => {
	const ctl = new RoutePoiController({});
	let paths = [[north(0), north(1)]];
	const searches = [];
	ctl._currentPaths = () => paths;
	ctl.search = (auto) => { searches.push(auto); ctl._searchedSig = routeSignature(paths); ctl._pendingSig = null; };
	ctl._state = "active";
	ctl._searchedSig = routeSignature(paths);
	ctl._checkRoute();
	assert.deepEqual(searches, [], "unchanged route");
	paths = [[north(0), north(1.5)]];
	ctl._checkRoute();
	paths = [[north(0), north(2)]];
	ctl._checkRoute();
	assert.deepEqual(searches, [], "still changing");
	ctl._checkRoute();
	assert.deepEqual(searches, [true], "settled for two polls");
	ctl._checkRoute();
	assert.deepEqual(searches, [true], "no repeat after the update");
	paths = [[north(0), north(3)]];
	ctl._state = "idle";
	ctl._checkRoute();
	ctl._checkRoute();
	assert.deepEqual(searches, [true], "cleared POIs stop following the route");
});
