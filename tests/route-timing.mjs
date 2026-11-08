// Run with `node --test tests/route-timing.mjs`; source modules only, no network.
// Arrival times, daylight, elevation sampling, forecast plumbing and the
// timing pieces of the route-POI panel.
process.env.TZ = "Australia/Brisbane";

import test from "node:test";
import assert from "node:assert/strict";
import { measureRoute, routeParts } from "../src/utils/route-geometry.js";
import {
	alongAt, formatDuration, formatPace, gradeFactor, parsePace, resampleRoute, routeTiming,
	smoothElevations, timeAt,
} from "../src/utils/route-timing.js";
import { darkIntervals, sunTimes } from "../src/utils/sun.js";
import {
	decodeTerrarium, fetchRouteElevations, sampleTile, tilePosition,
} from "../src/providers/route-elevation.js";
import {
	applyForecast, fetchRouteWeather, maxFeelsBetween, summarizeWeather, weatherPoints, weatherUrl,
} from "../src/providers/route-weather.js";
import {
	RoutePoiController, clock, defaultStart, formatClock, normaliseStart, replaceAround,
	toLocalInput, waterGuideLitres, waypointLabel,
} from "../src/providers/route-pois.js";

const north = (km) => [0, km / 111.195];
const route = (...km) => measureRoute(routeParts([km.map(north)]));
const near = (actual, expected, tolerance, label) =>
	assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected} (±${tolerance})`);

// Reference sunrise/sunset (UTC seconds) from Open-Meteo for 2026-11-08/09.
const SUN_REFERENCES = [
	["Buderim 8 Nov", -26.6886, 153.041, Date.UTC(2026, 10, 8, 2), 1794077610, 1794125400, 3],
	["Buderim 9 Nov", -26.6886, 153.041, Date.UTC(2026, 10, 9, 2), 1794163975, 1794211843, 3],
	["Sydney 9 Nov", -33.87, 151.21, Date.UTC(2026, 10, 9, 2), 1794163693, 1794213024, 3],
	["London 9 Nov", 51.5, -0.12, Date.UTC(2026, 10, 9, 12), 1794208084, 1794241204, 3],
	["Tromsø 9 Nov", 69.65, 18.96, Date.UTC(2026, 10, 9, 11), 1794210664, 1794229425, 6],
];

test("sunrise and sunset match Open-Meteo within a few minutes", () => {
	for (const [label, lat, lng, at, rise, set, minutes] of SUN_REFERENCES) {
		const sun = sunTimes(at, lat, lng);
		near(sun.sunrise / 1000, rise, minutes * 60, label + " sunrise");
		near(sun.sunset / 1000, set, minutes * 60, label + " sunset");
		assert.ok(sun.dawn < sun.sunrise && sun.dusk > sun.sunset, label + " civil twilight brackets the day");
	}
	const polar = sunTimes(Date.UTC(2026, 11, 21, 12), 78, 15);
	assert.equal(polar.sunrise, null, "polar night has no sunrise");
	assert.equal(polar.sunset, null);
});

test("dark intervals cover pre-dawn starts, evening finishes and polar night", () => {
	const lat = -26.6886, lng = 153.041;
	const rise = 1794163975e3, set = 1794211843e3; // 9 Nov, Buderim
	// 04:00 local start, 16 hours: dark until sunrise and again after sunset.
	const start = Date.UTC(2026, 10, 8, 18);
	const dark = darkIntervals(start, start + 16 * 3600e3, lat, lng);
	assert.equal(dark.length, 2);
	assert.equal(dark[0][0], start);
	near(dark[0][1], rise, 3 * 60e3, "first dark stretch ends at sunrise");
	near(dark[1][0], set, 3 * 60e3, "second starts at sunset");
	assert.equal(dark[1][1], start + 16 * 3600e3);
	// 07:00–12:00 is all daylight.
	assert.deepEqual(darkIntervals(Date.UTC(2026, 10, 8, 21), Date.UTC(2026, 10, 9, 2), lat, lng), []);
	assert.deepEqual(darkIntervals(10, 5, lat, lng), [], "empty window");
	const winter = Date.UTC(2026, 11, 21, 0);
	assert.deepEqual(darkIntervals(winter, winter + 3600e3, 78, 15), [[winter, winter + 3600e3]]);
	const summer = Date.UTC(2026, 5, 21, 0);
	assert.deepEqual(darkIntervals(summer, summer + 3600e3, 78, 15), [], "midnight sun");
});

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

test("grade factor follows Minetti uphill and eases off on steep descents", () => {
	assert.equal(gradeFactor(0), 1);
	near(gradeFactor(0.1), 1.658, 0.005, "10% climb");
	near(gradeFactor(0.3), 3.494, 0.005, "30% climb");
	near(gradeFactor(-0.1), 0.91, 1e-9, "fastest near -10%");
	assert.ok(gradeFactor(-0.05) > gradeFactor(-0.1) && gradeFactor(-0.2) > gradeFactor(-0.1));
	assert.ok(gradeFactor(-0.3) > 1, "steep descents are slower than flat");
	assert.equal(gradeFactor(0.9), gradeFactor(0.45), "clamped");
	assert.equal(gradeFactor("x"), 1);
});

test("route timing adds climbing cost, skips gaps and maps time back to distance", () => {
	const samples = resampleRoute(route(0, 10));
	const flat = routeTiming(samples, null, 360);
	near(flat.total, 3600, 0.5, "10 km at 6:00/km");
	assert.equal(flat.ascent, null);
	near(timeAt(flat, 2500), 900, 0.5, "time at 2.5 km");
	near(alongAt(flat, 900), 2500, 0.5, "distance after 15 min");
	assert.equal(timeAt(flat, -5), 0);
	assert.equal(alongAt(flat, 1e9), flat.alongs.at(-1));

	// A steady 5% climb for the first half, then back down.
	const elevations = samples.map((s) => (s.along <= 5000 ? s.along : 10000 - s.along) * 0.05);
	const hilly = routeTiming(samples, elevations, 360);
	near(hilly.ascent, 250, 10, "ascent");
	near(hilly.descent, 250, 10, "descent");
	assert.ok(hilly.total > flat.total, "the climb costs more than the descent saves");
	assert.ok(timeAt(hilly, 5000) > 1800 * gradeFactor(0.05) * 0.98);

	// A missing elevation tile falls back to flat pacing for those steps.
	const holes = elevations.map((v, i) => (i > 20 && i < 40 ? NaN : v));
	assert.ok(Number.isFinite(routeTiming(samples, holes, 360).total));

	const split = resampleRoute(measureRoute(routeParts([[north(0), north(1)], [[1, 0], [1, north(1)[1]]]])));
	near(routeTiming(split, null, 300).total, 600, 0.5, "the jump between parts takes no time");
	assert.deepEqual([...smoothElevations([0, 10, NaN, 30, 40], 3)], [5, 5, 20, 35, 35]);
});

test("pace and duration parsing and formatting", () => {
	assert.equal(parsePace("6:00"), 360);
	assert.equal(parsePace(" 5:45 "), 345);
	assert.equal(parsePace("7"), 420);
	assert.equal(parsePace("6:7"), null);
	assert.equal(parsePace("1:30"), null, "too fast to be a pace");
	assert.equal(parsePace("abc"), null);
	assert.equal(formatPace(345.4), "5:45");
	assert.equal(formatDuration(3 * 3600 + 50 * 60), "3 h 50");
	assert.equal(formatDuration(2 * 3600 + 5 * 60), "2 h 05");
	assert.equal(formatDuration(45 * 60 + 10), "45 min");
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

const startMs = Date.UTC(2026, 10, 8, 20); // 06:00 on 9 Nov in Brisbane
const sampleRoute = () => {
	const samples = resampleRoute(route(0, 30));
	return { samples, timing: routeTiming(samples, null, 360) };
};

test("weather points spread along the route at their arrival times", () => {
	const { samples, timing } = sampleRoute();
	const points = weatherPoints(samples, timing, startMs);
	assert.equal(points.length, 11);
	assert.equal(points[0].along, 0);
	near(points.at(-1).along, 30000, 1, "finish included");
	assert.equal(points[0].eta, startMs);
	near(points.at(-1).eta, startMs + 3 * 3600e3, 1000, "finish ETA");
	assert.equal(weatherPoints([], timing, startMs).length, 0);

	const url = new URL(weatherUrl(points));
	assert.equal(url.origin + url.pathname, "https://api.open-meteo.com/v1/forecast");
	assert.equal(url.searchParams.get("latitude").split(",").length, 11);
	assert.equal(url.searchParams.get("start_hour"), "2026-11-08T20:00");
	assert.equal(url.searchParams.get("end_hour"), "2026-11-09T00:00", "the hour after the finish");
	assert.equal(url.searchParams.get("start_date"), null, "start_date can't be combined with start_hour");
	assert.equal(url.searchParams.get("timeformat"), "unixtime");
});

const hourly = (startSec, temps, extra = {}) => ({
	hourly: {
		time: temps.map((_, i) => startSec + i * 3600),
		temperature_2m: temps,
		apparent_temperature: temps.map((t) => t + 2),
		precipitation_probability: temps.map(() => 10),
		precipitation: temps.map(() => 0),
		wind_speed_10m: temps.map(() => 12),
		wind_gusts_10m: temps.map(() => 25),
		uv_index: temps.map((_, i) => i * 2),
		weather_code: temps.map(() => 1),
		...extra,
	},
});

test("forecasts attach the hour nearest each point and summarise extremes", () => {
	const t0 = startMs / 1000;
	const points = [
		{ along: 0, lat: 0, lng: 0, eta: startMs },
		{ along: 10000, lat: 0, lng: 0, eta: startMs + 100 * 60e3 },
		{ along: 20000, lat: 0, lng: 0, eta: startMs + 170 * 60e3 },
	];
	const data = [
		hourly(t0, [18, 20, 22, 24]),
		hourly(t0, [19, 21, 33, 25], { weather_code: [1, 1, 95, 1] }),
		hourly(t0, [20, 22, 24, 26], { precipitation_probability: [0, 0, 40, 60] }),
	];
	const withWx = applyForecast(points, data);
	assert.equal(withWx[0].wx.temp, 18);
	assert.equal(withWx[1].wx.temp, 33, "1 h 40 → nearest hour is 2 h");
	assert.equal(withWx[2].wx.temp, 26, "2 h 50 → 3 h");
	assert.equal(withWx[1].wx.code, 95);
	const s = summarizeWeather(withWx);
	assert.equal(s.minTemp.value, 18);
	assert.equal(s.maxTemp.value, 33);
	assert.equal(s.maxTemp.along, 10000);
	assert.equal(s.maxFeels.value, 35);
	assert.equal(s.maxRainChance.value, 60);
	assert.equal(s.maxRainChance.along, 20000);
	assert.equal(s.maxUv.value, 6);
	assert.deepEqual(s.storm, { along: 10000, eta: points[1].eta });
	assert.equal(maxFeelsBetween(withWx, 15000, 25000), 28);
	assert.equal(maxFeelsBetween(withWx, 40000, 50000), null);

	// A single-location request returns an object, not an array.
	assert.equal(applyForecast([points[0]], hourly(t0, [17]))[0].wx.temp, 17);
	assert.equal(applyForecast([points[0]], [{}])[0].wx, null);
	assert.equal(summarizeWeather([{ ...points[0], wx: null }]), null);
});

test("forecast fetches skip past and far-future starts, cache results and report errors", async () => {
	const { samples, timing } = sampleRoute();
	const points = weatherPoints(samples, timing, startMs);
	const call = (pts, opts) => new Promise((resolve) => fetchRouteWeather(pts, opts, (err, r) => resolve({ err, r })));
	const now = startMs - 24 * 3600e3;
	assert.equal((await call(points, { now: startMs + 10 * 3600e3, fetchJson: () => assert.fail() })).r.status, "past");
	assert.equal((await call(points, { now: startMs - 20 * 864e5, fetchJson: () => assert.fail() })).r.status, "too-far");
	assert.equal((await call([], { now })).r.status, "none");
	const urls = [];
	const fetchJson = (url, opts, cb) => {
		urls.push(url);
		cb(null, points.map(() => hourly(startMs / 1000, [20, 21, 22, 23])));
	};
	const ok = await call(points, { now, fetchJson });
	assert.equal(ok.r.status, "ok");
	assert.equal(ok.r.points.length, points.length);
	assert.equal(ok.r.points.at(-1).wx.temp, 23);
	await call(points, { now: now + 60e3, fetchJson });
	assert.equal(urls.length, 1, "cached");
	const later = points.map((p) => ({ ...p, eta: p.eta + 3600e3 }));
	const failed = await call(later, { now, fetchJson: (u, o, cb) => cb(null, { error: true, reason: "bad" }) });
	assert.match(failed.err.message, /bad/);
});

test("waypoint labels can carry distance and arrival time within the name limit", () => {
	const poi = { name: "Kiosk", type: "cafe", category: "food", along: 4200 };
	const eta = new Date(2026, 10, 9, 7, 25).getTime();
	assert.equal(waypointLabel(poi), "Kiosk");
	assert.equal(waypointLabel(poi, { mode: "km" }), "4.2k Kiosk");
	assert.equal(waypointLabel(poi, { mode: "km-time", eta }), "4.2k 07:25 Kiosk");
	assert.equal(waypointLabel(poi, { mode: "km-time" }), "4.2k Kiosk", "no time without an estimate");
	assert.equal(waypointLabel({ ...poi, along: 12600 }, { mode: "km" }), "13k Kiosk");
	assert.equal(waypointLabel(poi, { mode: "km", metric: false }), "2.6mi Kiosk");
	assert.equal(waypointLabel({ name: "", type: "toilets", category: "toilets", along: 900 }, { mode: "km-time", eta }),
		"0.9k 07:25 Toile");
	assert.equal(waypointLabel({ name: "Mapleton  Falls lookout", type: "viewpoint", category: "view", along: 0 },
		{ mode: "name", maxLength: 12 }), "Mapleton Fal");
});

test("clock helpers, the drinking guide and start-time defaults", () => {
	const at = new Date(2026, 10, 9, 7, 5).getTime();
	assert.equal(clock(at), "07:05");
	assert.equal(formatClock(at, at), "07:05");
	assert.match(formatClock(at + 864e5, at), /^\S+ 07:05$/, "another day gets a weekday");
	assert.equal(toLocalInput(at), "2026-11-09T07:05");

	assert.equal(waterGuideLitres(0.4, 20), null, "short stretches get no guide");
	assert.deepEqual(waterGuideLitres(2, 20), [1, 1.5]);
	assert.deepEqual(waterGuideLitres(2, 27), [1, 2]);
	assert.deepEqual(waterGuideLitres(2, 32), [1.5, 2.5]);
	assert.deepEqual(waterGuideLitres(0.5, 15), [0.5, 0.5]);

	assert.equal(defaultStart(new Date(2026, 10, 9, 4, 0).getTime()), "2026-11-09T06:00");
	assert.equal(defaultStart(new Date(2026, 10, 9, 5, 30).getTime()), "2026-11-10T06:00");
	const now = new Date(2026, 10, 9, 12, 0).getTime();
	assert.equal(normaliseStart("2026-11-12T05:30", now), "2026-11-12T05:30", "future start kept");
	assert.equal(normaliseStart("2026-11-09T08:00", now), "2026-11-09T08:00", "this morning is kept");
	assert.equal(normaliseStart("2026-11-01T05:30", now), "2026-11-10T05:30", "rolled forward, same time of day");
	assert.equal(normaliseStart("nonsense", now), "2026-11-10T06:00");
});

// Just enough DOM for replaceAround.
class Node {
	constructor(name, className = "") { this.nodeName = name; this.className = className; this.childNodes = []; this.parentNode = null; }
	appendChild(c) { c.parentNode?.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c; }
	insertBefore(c, ref) { c.parentNode?.removeChild(c); c.parentNode = this; this.childNodes.splice(this.childNodes.indexOf(ref), 0, c); return c; }
	removeChild(c) { this.childNodes.splice(this.childNodes.indexOf(c), 1); c.parentNode = null; return c; }
}
const tree = (tag) => {
	const n = (name, cls, ...kids) => { const el = new Node(name, cls); el.tag = tag; kids.forEach((k) => el.appendChild(k)); return el; };
	const form = n("DIV", "form", n("INPUT", ""));
	const root = n("DIV", "panel",
		n("DIV", "hd"),
		n("DIV", "body", n("DIV", "status"), n("DIV", "timing", n("BUTTON", "head"), form, n("DIV", "out")), n("DIV", "opts")));
	return { root, form };
};

test("re-rendering keeps the focused timing form in place and swaps everything else", () => {
	const old = tree("old"), fresh = tree("new");
	const input = old.form.childNodes[0];
	assert.equal(replaceAround(old.root, fresh.root, old.form, fresh.form), true);
	const tags = (el) => el.childNodes.map((c) => c.className + ":" + c.tag);
	assert.deepEqual(tags(old.root), ["hd:new", "body:old"]);
	const body = old.root.childNodes[1];
	assert.deepEqual(tags(body), ["status:new", "timing:old", "opts:new"]);
	assert.deepEqual(tags(body.childNodes[1]), ["head:new", "form:old", "out:new"]);
	assert.equal(old.form.childNodes[0], input, "the input itself never left the document");

	const other = tree("x"), changed = tree("y");
	changed.form.parentNode.className = "something-else";
	assert.equal(replaceAround(other.root, changed.root, other.form, changed.form), false, "shape mismatch");
	assert.deepEqual(tags(other.root), ["hd:x", "body:x"], "untouched on mismatch");
});

test("POI waypoints use the chosen name mode with the estimated arrival time", () => {
	const added = [];
	const plan = {
		waypoints: [], waypointNameLength: 16, waypointCountMax: 50, unitsMetric: true,
		addWaypoint(latLng, name) { added.push(name); const wp = { marker: { getLatLng: () => ({ lat: latLng[0], lng: latLng[1] }) }, name }; this.waypoints.push(wp); return wp; },
	};
	globalThis.window = { leafletPlan: plan, confirm: () => true };
	try {
		const ctl = new RoutePoiController({});
		ctl._renderPanel = () => {};
		ctl._prefs.start = "2026-11-09T06:00";
		ctl._prefs.pace = 360;
		ctl._timing = { samples: resampleRoute(route(0, 10)), elevations: null };
		ctl._recomputeTiming(false);
		const poi = (id, km) => ({ id, name: "Tap", type: "drinking_water", category: "water",
			lat: north(km)[1], lng: 0, passes: [{ along: km * 1000, offset: 0 }], along: km * 1000, offset: 0 });
		ctl._prefs.nameMode = "km-time";
		ctl._addWaypoint(poi("a", 5));
		ctl._prefs.nameMode = "km";
		ctl._addWaypoint(poi("b", 7.5));
		ctl._prefs.nameMode = "name";
		ctl._addWaypoint(poi("c", 9));
		assert.deepEqual(added, ["5.0k 06:30 Tap", "7.5k Tap", "Tap"]);
		assert.match(ctl._passesText(poi("d", 2.5)), /^2\.5 km \(06:15\)$/);
		assert.match(ctl._gapTimingText({ from: 0, to: 10000, length: 10000 }), /^about 1 h 00, rough guide 0\.5–1 L$/);
	} finally { delete globalThis.window; }
});
