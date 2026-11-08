// Run with `node --test tests/route-features.mjs`; source modules only, no network.
// Course features for Up Ahead: creek crossings, track sections and climbs.
import test from "node:test";
import assert from "node:assert/strict";
import { measureRoute, routeParts } from "../src/utils/route-geometry.js";
import { resampleRoute } from "../src/utils/route-profile.js";
import {
	abbreviate, climbLabel, climbTopLabel, creekCrossings, findClimbs, trackSections,
} from "../src/utils/route-features.js";
import {
	RoutePoiController, findRoutePois, thinClusters, waypointLabel, waypointPriority,
} from "../src/providers/route-pois.js";

// Routes run north from the equator, so offsets in both axes are metric.
const north = (km) => [0, km / 111.195];
const east = (m) => m / 111195;
const at = (km, m = 0) => [east(m), north(km)[1]];
const route = (...km) => measureRoute(routeParts([km.map(north)]));
const near = (actual, expected, tolerance, label) =>
	assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected} (±${tolerance})`);

test("creek crossings merge tile duplicates and wandering creeks, and share repeat passes", () => {
	const r = route(0, 3);
	const creek = { name: "Test Creek", cls: "stream", line: [at(1.003, -200), at(0.997, 200)] };
	const zigzag = { name: "", cls: "stream", line: [at(2.0, -30), at(2.02, 30), at(2.04, -30), at(2.06, 30), at(2.08, -30)] };
	const found = creekCrossings(r, [creek, { ...creek }, zigzag]);
	assert.equal(found.length, 2, "tile copy and zig-zag crossings merge");
	near(found[0].passes[0], 1000, 5, "named crossing along the route");
	assert.equal(found[0].name, "Test Creek");
	near(found[1].passes[0], 2010, 15, "first crossing of the wandering creek");
	assert.equal(found[1].passes.length, 1);

	const outAndBack = measureRoute(routeParts([[north(0), north(2)], [north(2), north(0)]]));
	const both = creekCrossings(outAndBack, [creek]);
	assert.equal(both.length, 1, "one feature for the same spot");
	assert.equal(both[0].passes.length, 2);
	near(both[0].passes[1], 3000, 5, "return pass");
	assert.deepEqual(creekCrossings(r, [{ name: "Far Creek", line: [at(1, 500), at(1, 900)] }]), []);
});

test("track sections start where the route moves onto a differently named way", () => {
	const samples = resampleRoute(route(0, 3));
	const road = (name, fromKm, toKm, m = 5, cls = "track") => ({ name, cls, line: [at(fromKm, m), at(toKm, m)] });
	const sections = trackSections(samples, [
		road("Alpha Road", 0, 1.2, 5, "minor"),
		road("Beta Track", 1.2, 2.0), road("Beta Track", 2.06, 3.0), // an unmapped 60 m gap
		{ name: "Gamma Lane", cls: "minor", line: [at(2.5, -80), at(2.5, 80)] }, // crossing side road
		road("Far Track", 0, 3, 200),
	]);
	assert.deepEqual(sections.map((s) => s.name), ["Beta Track"], "starts at 0 km, spurs and gaps don't count");
	near(sections[0].along, 1200, 60, "section start");
	near(sections[0].to, 3000, 60, "section end");
	assert.equal(sections[0].cls, "track");

	const back = trackSections(samples, [road("Alpha Road", 0.2, 1), road("Beta Track", 1, 2), road("Alpha Road", 2, 3)]);
	assert.deepEqual(back.map((s) => s.name), ["Alpha Road", "Beta Track", "Alpha Road"], "a name can return");
	[200, 1000, 2000].forEach((m, i) => near(back[i].along, m, 60, back[i].name + " start"));
	assert.deepEqual(trackSections(samples, [road("Short Way", 1, 1.2)]), [], "under 300 m");
	assert.deepEqual(trackSections(samples, []), []);
});

const profile = (samples, fn) => Float64Array.from(samples, (s) => fn(s.along));

test("climbs follow ClimbPro-style rules: enough gain, steep enough, small dips ignored", () => {
	const samples = resampleRoute(route(0, 6));
	const climbing = profile(samples, (m) => {
		let h = 100;
		if (m > 1000) h += Math.min(m - 1000, 2000) * 0.05; // 100 m over 2 km
		if (Math.abs(m - 2000) < 100) h -= 8; // a dip inside the climb
		if (m > 4000 && m <= 4500) h += (m - 4000) * 0.06; // a 30 m bump
		if (m > 4500 && m <= 5000) h += 30 - (m - 4500) * 0.06;
		return h;
	});
	const climbs = findClimbs(samples, climbing);
	assert.equal(climbs.length, 1, "the dip doesn't split it and the bump is too small");
	const [c] = climbs;
	near(c.from, 1000, 150, "base");
	near(c.to, 3000, 150, "top");
	near(c.gain, 100, 4, "gain");
	near(c.grade, 0.05, 0.01, "average grade");
	assert.ok(c.steepest >= c.grade, "steepest stretch");
	assert.equal(samples[c.startIndex].along, c.from);

	const gentle = profile(samples, (m) => 100 + m * 0.01); // 60 m at 1%
	assert.deepEqual(findClimbs(samples, gentle), [], "too gentle");
	assert.equal(findClimbs(samples, gentle, { minGrade: 0.005 }).length, 1);

	const seventy = profile(samples, (m) => 100 + Math.max(0, Math.min(m - 1000, 2000)) * 0.035);
	assert.equal(findClimbs(samples, seventy).length, 1, "70 m climb");
	const holed = seventy.map((v, i) => (samples[i].along > 1700 && samples[i].along < 2300 ? NaN : v));
	assert.deepEqual(findClimbs(samples, holed), [], "a missing tile splits it into halves too small to count");
	const pinhole = seventy.map((v, i) => (samples[i].along === 2000 ? NaN : v));
	assert.equal(findClimbs(samples, pinhole).length, 1, "smoothing bridges a single missing sample");
	const split = samples.map((s) => ({ ...s, partStart: s.along === 2000 }));
	assert.deepEqual(findClimbs(split, seventy), [], "a gap between route parts splits it too");
	assert.deepEqual(findClimbs(samples, null), []);
	assert.deepEqual(findClimbs(samples, seventy.slice(1)), [], "length mismatch");
});

test("climb names fit the watch, shortening rather than truncating", () => {
	const climb = { gain: 171.4, length: 3712 };
	assert.equal(climbLabel(climb), "Climb 171m 3.7k");
	assert.equal(climbLabel(climb, false), "Climb 562ft", "imperial full form is 17 characters");
	assert.equal(climbLabel(climb, true, 6), "+171m");
	assert.equal(climbTopLabel(climb), "Top 171m climb");
	assert.equal(climbTopLabel(climb, true, 8), "Top 171m");
	assert.equal(climbTopLabel(climb, true, 4), "Top");
	assert.equal(abbreviate("East Cedar Creek"), "East Cedar Ck");
	assert.equal(abbreviate("Mount Coot-tha Road"), "Mt Coot-tha Rd");
	assert.equal(abbreviate("Mountain Creek Track"), "Mtn Ck Trk");
	assert.equal(abbreviate("Creekside Drive"), "Creekside Dr", "whole words only");

	const item = { type: "climb", climb, name: "Climb 171m 3.7k", along: 13100 };
	assert.equal(waypointLabel(item), "Climb 171m 3.7k");
	assert.equal(waypointLabel(item, { mode: "km" }), "13k Climb 171m");
	assert.equal(waypointLabel(item, { mode: "km", maxLength: 10 }), "13k +171m", "very short name limits keep the gain");
	const top = { type: "climb_top", climb, name: "Top 171m climb", along: 16800 };
	assert.equal(waypointLabel(top, { mode: "km" }), "17k Top 171m");
	const creek = { type: "creek_crossing", name: "East Cedar Creek", along: 13040 };
	assert.equal(waypointLabel(creek), "East Cedar Creek", "fits without shortening");
	assert.equal(waypointLabel(creek, { mode: "km" }), "13k East Cedar C");
	assert.equal(waypointLabel({ type: "track_section", name: "Turpentine Track", along: 16800 }, { mode: "km" }),
		"17k Turpentine T");
	assert.equal(waypointLabel({ type: "track_section", name: "Python Break Track", along: 900 }), "Python Break Trk");
});

// One synthetic z14 tile per request: a creek across the route at 0.5 km.
const varint = (n) => { const out = []; do { let b = n & 0x7f; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b); } while (n); return out; };
const zig = (n) => (n << 1) ^ (n >> 31);
const bytes = (s) => [...Buffer.from(s, "utf8")];
const field = (num, wt, payload) => [...varint((num << 3) | wt), ...(wt === 2 ? [...varint(payload.length), ...payload] : payload)];
function creekTile(url, lat) {
	const [, z, x, y] = /\/(\d+)\/(\d+)\/(\d+)\.pbf$/.exec(url).map(Number);
	const n = 2 ** z, r = lat * Math.PI / 180;
	const py = Math.round(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n - y) * 4096);
	const feature = field(2, 2, [
		...field(2, 2, [0, 0, 1, 1].flatMap(varint)),
		...field(3, 0, varint(2)),
		...field(4, 2, [9, zig(0), zig(py), (1 << 3) | 2, zig(4096), zig(0)].flatMap(varint)),
	]);
	void x;
	return new Uint8Array(field(3, 2, [
		...field(15, 0, varint(2)), ...field(1, 2, bytes("waterway")), ...feature,
		...field(3, 2, bytes("class")), ...field(3, 2, bytes("name")),
		...field(4, 2, field(1, 2, bytes("stream"))), ...field(4, 2, field(1, 2, bytes("Sample Creek"))),
		...field(5, 0, varint(4096)),
	])).buffer;
}

test("a search returns POIs, creek crossings and climbs in route order, and survives missing elevations", async () => {
	const lng = 153.01, lat0 = -26.7;
	const paths = [[[lng, lat0], [lng, lat0 + 3 / 111.195]]];
	const creekLat = lat0 + 0.5 / 111.195;
	const opts = (fetchElevations) => ({
		resolveTemplate: (cb) => cb(null, "https://tiles.openfreemap.org/features/{z}/{x}/{y}.pbf"),
		fetchTile: (url, cb) => { setTimeout(() => cb(null, creekTile(url, creekLat)), 0); return { abort() {} }; },
		fetchElevations,
	});
	const search = (fetchElevations) => new Promise((resolve) => findRoutePois(paths, 100, opts(fetchElevations),
		(err, result) => resolve({ err, result })));
	const climbProfile = (samples, cb) => { cb(null, Float64Array.from(samples, (s) => 50 + Math.max(0, Math.min(s.along - 1000, 1500)) * 0.06)); return { cancel() {} }; };

	const { err, result } = await search(climbProfile);
	assert.equal(err, null);
	assert.deepEqual(result.pois.map((p) => p.type), ["creek_crossing", "climb", "climb_top"]);
	const [creek, climb, top] = result.pois;
	assert.equal(creek.name, "Sample Creek");
	near(creek.along, 500, 10, "creek");
	assert.equal(creek.offset, 0);
	near(climb.along, 1000, 150, "climb base");
	assert.equal(climb.name, "Climb 90m 1.5k");
	near(top.along, 2500, 150, "climb top");
	assert.equal(top.ele, 140);
	assert.equal(result.elevations.length, result.samples.length);
	assert.equal(result.elevationError, null);

	const failed = await search((samples, cb) => { cb(new Error("offline")); return { cancel() {} }; });
	assert.deepEqual(failed.result.pois.map((p) => p.type), ["creek_crossing"], "no climbs without elevations");
	assert.match(failed.result.elevationError.message, /offline/);
	assert.equal(failed.result.elevations, null);
	const thrown = await search(() => { throw new Error("no GM_xmlhttpRequest"); });
	assert.equal(thrown.err, null, "a throwing elevation fetch doesn't break the search");
});

const item = (id, category, type, along, km = along / 1000) => ({
	id, category, type, name: "", along, offset: 0, lat: north(km)[1], lng: 0, passes: [{ along, offset: 0 }],
});

test("bulk adding keeps only the most useful item per 100 m stretch", () => {
	const cluster = [
		item("wc", "toilets", "toilets", 19800), item("p", "parking", "parking", 19810),
		item("picnic", "parking", "picnic_site", 19850), item("top", "climbtop", "climb_top", 19900),
	];
	const creekThenClimb = [item("creek", "creek", "creek_crossing", 23900), item("climb", "climb", "climb", 23920)];
	const covered = [item("track", "track", "track_section", 30250)];
	const takenCreek = item("creek2", "creek", "creek_crossing", 30200);
	const kept = thinClusters([...cluster, ...creekThenClimb, ...covered], [takenCreek]);
	assert.deepEqual(kept.map((p) => p.id), ["wc", "climb"], "toilets beat the car park, picnic area and climb top");
	assert.ok(waypointPriority({ category: "water" }) < waypointPriority({ category: "toilets" }));
	assert.ok(waypointPriority({ category: "parking", type: "picnic_site" }) < waypointPriority({ category: "parking", type: "parking" }));
	const ties = thinClusters([item("a", "creek", "creek_crossing", 1000), item("b", "creek", "creek_crossing", 1050)]);
	assert.deepEqual(ties.map((p) => p.id), ["a"], "ties go to the first along the route");
	assert.deepEqual(thinClusters([item("x", "food", "cafe", 0), item("y", "food", "cafe", 101)]).map((p) => p.id), ["x", "y"]);
	assert.deepEqual(thinClusters([]), []);
});

test("Add shown as waypoints skips clustered items and says how many it left out", () => {
	const added = [];
	const plan = {
		waypoints: [], waypointNameLength: 16, waypointCountMax: 999999, unitsMetric: true,
		addWaypoint(latLng, name) {
			added.push(name);
			const wp = { marker: { getLatLng: () => ({ lat: latLng[0], lng: latLng[1] }) }, name };
			this.waypoints.push(wp);
			return wp;
		},
	};
	globalThis.window = { leafletPlan: plan, confirm: () => true };
	try {
		const ctl = new RoutePoiController({});
		ctl._renderPanel = () => {};
		ctl._pois = [
			{ ...item("wc", "toilets", "toilets", 19800), name: "Toilets" },
			{ ...item("p", "parking", "parking", 19810), name: "" },
			{ ...item("picnic", "parking", "picnic_site", 19850), name: "Day Use Area" },
			{ ...item("climb", "climb", "climb", 23920), name: "Climb 72m 0.7k" },
		];
		ctl._addAll();
		assert.deepEqual(added, ["Toilets", "Climb 72m 0.7k"]);
		assert.match(ctl._status.text, /^Added 2 waypoints \(2 next to a more useful one left out\)/);
		ctl._addAll();
		assert.match(ctl._status.text, /already has a waypoint/, "the covered stretches get nothing more");
		assert.equal(added.length, 2);
	} finally { delete globalThis.window; }
});
