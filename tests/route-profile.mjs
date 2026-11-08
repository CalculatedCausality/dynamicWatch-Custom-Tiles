// Run with `node --test tests/route-profile.mjs`; source modules only, no network.
// The route's sampled elevation profile, and how POI waypoints are named.
import test from "node:test";
import assert from "node:assert/strict";
import { measureRoute, routeParts } from "../src/utils/route-geometry.js";
import { resampleRoute, smoothElevations } from "../src/utils/route-profile.js";
import {
	decodeTerrarium, fetchRouteElevations, sampleTile, tilePosition,
} from "../src/providers/route-elevation.js";
import { RoutePoiController, waypointLabel } from "../src/providers/route-pois.js";

const north = (km) => [0, km / 111.195];
const route = (...km) => measureRoute(routeParts([km.map(north)]));
const near = (actual, expected, tolerance, label) =>
	assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected} (±${tolerance})`);

test("routes resample every 50 m, continuing distance across separate parts", () => {
	const samples = resampleRoute(route(0, 1));
	assert.equal(samples.length, 21);
	near(samples[20].along, 1000, 1, "last sample at the end");
	near(samples[10].lat, north(0.5)[1], 1e-7, "interpolated position");
	assert.deepEqual(samples.filter((s) => s.partStart).length, 1);
	const split = resampleRoute(measureRoute(routeParts([[north(0), north(0.12)], [[1, 0], [1, north(0.1)[1]]]])));
	assert.deepEqual(split.map((s) => Math.round(s.along)), [0, 50, 100, 120, 120, 170, 220]);
	assert.deepEqual(split.map((s) => s.partStart), [true, false, false, false, true, false, false]);
});

test("elevations are smoothed with a centred average that skips gaps", () => {
	assert.deepEqual([...smoothElevations([0, 10, NaN, 30, 40], 3)], [5, 5, 20, 35, 35]);
	assert.deepEqual([...smoothElevations([NaN, NaN, NaN], 3)].map(Number.isNaN), [true, true, true]);
});

test("Terrarium tiles decode and sample bilinearly", () => {
	const rgba = new Uint8ClampedArray([128, 0, 0, 255, 128, 100, 128, 255, 0, 0, 0, 255]);
	assert.deepEqual([...decodeTerrarium(rgba)], [0, 100.5, -32768]);
	assert.deepEqual(tilePosition(0, 0, 1), [1, 1]);
	const [x, y] = tilePosition(153.041, -26.6886, 12);
	assert.deepEqual([Math.floor(x), Math.floor(y)], [3789, 2363]);
	const ramp = new Float32Array(256 * 256).map((_, i) => i % 256);
	near(sampleTile(ramp, 10.5, 99), 10, 1e-6, "pixel centre");
	near(sampleTile(ramp, 11, 99), 10.5, 1e-6, "between pixels");
	near(sampleTile(ramp, 300, 99), 255, 0.01, "clamped at the edge");
});

test("route elevations fetch each tile once, cache it and tolerate a few failures", async () => {
	const fetched = [];
	const fetchTile = (url, cb) => { fetched.push(url); setTimeout(() => cb(null, url), 0); return { abort() {} }; };
	const decode = async () => new Float32Array(256 * 256).fill(42);
	const run = (samples, opts) => new Promise((resolve) => fetchRouteElevations(samples, opts,
		(err, values) => resolve({ err, values })));
	// About 9 km per tile at this latitude: a 20 km line spans three tiles.
	const samples = resampleRoute(measureRoute(routeParts([[[150, -30], [150, -30 + 20 / 111.195]]])), 500);
	const first = await run(samples, { fetchTile, decode });
	assert.equal(first.err, null);
	assert.ok(first.values.every((v) => v === 42));
	assert.equal(new Set(fetched).size, fetched.length, "one request per tile");
	assert.ok(fetched.length >= 2 && fetched.every((u) => /terrarium\/12\/\d+\/\d+\.png$/.test(u)));
	const again = fetched.length;
	await run(samples, { fetchTile, decode });
	assert.equal(fetched.length, again, "second run served from the cache");

	// One tile of several failing leaves NaN there; most failing is an error.
	const elsewhere = resampleRoute(measureRoute(routeParts([[[140, -20], [140 + 40 / 104.5, -20]]])), 500);
	let n = 0;
	const flaky = (url, cb) => { const fail = n++ === 0; setTimeout(() => cb(fail ? new Error("x") : null, url), 0); return { abort() {} }; };
	const partial = await run(elsewhere, { fetchTile: flaky, decode });
	assert.equal(partial.err, null);
	assert.ok(partial.values.some(Number.isNaN) && partial.values.some((v) => v === 42));
	const broken = await run(resampleRoute(route(500, 520), 500), { fetchTile: (u, cb) => { cb(new Error("down")); return {}; }, decode });
	assert.match(broken.err.message, /unavailable/);
	const far = resampleRoute(measureRoute(routeParts([[[100, 0], [110, 0]]])), 5000);
	assert.match((await run(far, { fetchTile, decode })).err.message, /too many/);
});

test("cancelling an elevation fetch aborts requests and never calls back", async () => {
	const aborted = [];
	let called = false;
	const job = fetchRouteElevations(resampleRoute(route(900, 930), 500), {
		fetchTile: (url, cb) => ({ abort: () => aborted.push(url) }),
		decode: async () => new Float32Array(256 * 256),
	}, () => { called = true; });
	job.cancel();
	await new Promise((r) => setTimeout(r, 5));
	assert.ok(aborted.length > 0);
	assert.equal(called, false);
});

test("waypoint names can lead with the distance and still fit the limit", () => {
	const poi = { name: "Kiosk", type: "cafe", category: "food", along: 4200 };
	assert.equal(waypointLabel(poi), "Kiosk");
	assert.equal(waypointLabel(poi, { mode: "km" }), "4.2k Kiosk");
	assert.equal(waypointLabel({ ...poi, along: 12600 }, { mode: "km" }), "13k Kiosk");
	assert.equal(waypointLabel(poi, { mode: "km", metric: false }), "2.6mi Kiosk");
	assert.equal(waypointLabel({ name: "", type: "toilets", category: "toilets", along: 900 }, { mode: "km" }), "0.9k Toilets");
	assert.equal(waypointLabel({ name: "Mapleton  Falls lookout", type: "viewpoint", category: "views", along: 0 },
		{ mode: "name", maxLength: 12 }), "Mapleton Fal");
});

test("POI waypoints use the chosen name mode; a saved distance-and-time mode falls back to distance", () => {
	const added = [];
	const plan = {
		waypoints: [], waypointNameLength: 16, waypointCountMax: 50, unitsMetric: true,
		addWaypoint(latLng, name) { added.push(name); const wp = { marker: { getLatLng: () => ({ lat: latLng[0], lng: latLng[1] }) }, name }; this.waypoints.push(wp); return wp; },
	};
	const store = { dw_route_poi_prefs: JSON.stringify({ nameMode: "km-time", pace: 300, start: "2026-11-09T06:00" }) };
	globalThis.GM_getValue = (key, fallback) => (key in store ? store[key] : fallback);
	globalThis.window = { leafletPlan: plan, confirm: () => true };
	try {
		const ctl = new RoutePoiController({});
		ctl._renderPanel = () => {};
		assert.deepEqual(ctl._prefs, { radius: 100, hidden: [], nameMode: "km" });
		const poi = (id, km) => ({ id, name: "Tap", type: "drinking_water", category: "water",
			lat: north(km)[1], lng: 0, passes: [{ along: km * 1000, offset: 0 }], along: km * 1000, offset: 0 });
		ctl._addWaypoint(poi("a", 5));
		ctl._prefs.nameMode = "name";
		ctl._addWaypoint(poi("b", 9));
		assert.deepEqual(added, ["5.0k Tap", "Tap"]);
		assert.equal(ctl._passesText(poi("c", 2.5)), "2.5 km");
	} finally { delete globalThis.window; delete globalThis.GM_getValue; }
});
