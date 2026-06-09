// Unit tests for the pure helper functions inside the userscript.
// Catches regressions in tile projection, MVT decode, point-in-polygon,
// colour utilities, and the INTVL hover-helper logic. No network.

import { loadHelpers } from "./_loader.mjs";

const dw = loadHelpers();

// -- Test runner -------------------------------------------------------

const C_RED = "\x1b[31m", C_GREEN = "\x1b[32m", C_DIM = "\x1b[2m", C_OFF = "\x1b[0m";
let pass = 0, fail = 0;
const results = [];

function t(name, fn) {
	try { fn(); pass++; results.push([true, name, null]); }
	catch (e) { fail++; results.push([false, name, e.message]); }
}
function eq(actual, expected, msg) {
	if (actual !== expected) {
		throw new Error(`${msg || "expected equal"}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
	}
}
function close(actual, expected, eps, msg) {
	if (!Number.isFinite(actual) || Math.abs(actual - expected) > eps) {
		throw new Error(`${msg || "expected close"}: got ${actual}, want ~${expected} (eps ${eps})`);
	}
}
function deepEq(actual, expected, msg) {
	const a = JSON.stringify(actual), b = JSON.stringify(expected);
	if (a !== b) throw new Error(`${msg || "deep-eq"}: got ${a}, want ${b}`);
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

// -- Tests -------------------------------------------------------------

// ---- tile geometry ----

t("tileToBBox4326 z=0/0/0 covers world", () => {
	const b = dw.tileToBBox4326(0, 0, 0);
	eq(b.minLon, -180, "minLon");
	eq(b.maxLon, 180,  "maxLon");
	close(b.maxLat,  85.0511, 0.001, "maxLat");
	close(b.minLat, -85.0511, 0.001, "minLat");
});

t("tileToBBox4326 z=1 splits into four", () => {
	const a = dw.tileToBBox4326(1, 0, 0);
	const b = dw.tileToBBox4326(1, 1, 1);
	eq(a.minLon, -180);
	eq(a.maxLon, 0);
	eq(b.minLon, 0);
	eq(b.maxLon, 180);
});

t("tileToBBox4326 Brisbane tile (z=12, 3789, 2373)", () => {
	const b = dw.tileToBBox4326(12, 3789, 2373);
	if (!(153.025 >= b.minLon && 153.025 <= b.maxLon)) {
		throw new Error("lon not in bbox: " + JSON.stringify(b));
	}
	if (!(-27.47 >= b.minLat && -27.47 <= b.maxLat)) {
		throw new Error("lat not in bbox: " + JSON.stringify(b));
	}
});

t("tileToBBox3857 z=0/0/0 covers world in metres", () => {
	const b = dw.tileToBBox3857(0, 0, 0);
	close(b.west,  -20037508.34, 1, "west");
	close(b.east,   20037508.34, 1, "east");
	close(b.north,  20037508.34, 1, "north");
	close(b.south, -20037508.34, 1, "south");
});

t("tileToBBox3857 tile widths halve each zoom", () => {
	const a = dw.tileToBBox3857(0, 0, 0);
	const b = dw.tileToBBox3857(1, 0, 0);
	close(a.east - a.west, (b.east - b.west) * 2, 1, "z=0 width = 2× z=1 width");
});

// ---- zigzag + varint ----

t("zig decodes positive and negative", () => {
	eq(dw.zig(0), 0);  eq(dw.zig(1), -1);
	eq(dw.zig(2), 1);  eq(dw.zig(3), -2);
	eq(dw.zig(20), 10); eq(dw.zig(39), -20);
});
t("readVarint single-byte", () => {
	const r = dw.readVarint(new Uint8Array([0x05]), 0);
	eq(r.v, 5); eq(r.end, 1);
});
t("readVarint two-byte (4096)", () => {
	const r = dw.readVarint(new Uint8Array([0x80, 0x20]), 0);
	eq(r.v, 4096); eq(r.end, 2);
});

// ---- MVT geometry ----

t("decodeGeometry decodes triangle MoveTo+LineTo+ClosePath", () => {
	const geom = [9, 20, 20, 18, 20, 20, 39, 0, 15];
	const rings = dw.decodeGeometry(geom);
	deepEq(rings, [[[10, 10], [20, 20], [0, 20]]]);
});

t("decodeGeometry handles two rings (outer + inner)", () => {
	const geom = [
		9, 20, 20,           // MoveTo (10,10)
		18, 20, 20, 39, 0,   // LineTo (20,20), (0,20)
		15,                  // ClosePath
		9, 0, 0,             // MoveTo +(0,0) → (0,20)
	];
	const rings = dw.decodeGeometry(geom);
	eq(rings.length, 2, "expected 2 rings");
	eq(rings[0].length, 3, "first ring vertex count");
});

// ---- MVT decode ----

t("mvtDecode empty buffer returns []", () => {
	eq(dw.mvtDecode(new Uint8Array(0).buffer).length, 0);
});

t("mvtDecode parses minimal one-layer PBF", () => {
	const layerPayload = new Uint8Array([
		10, 1, 0x74,         // name = "t"
		40, 0x80, 0x20,      // extent = 4096
	]);
	const tile = new Uint8Array([
		26, layerPayload.length, ...layerPayload,
	]);
	const out = dw.mvtDecode(tile.buffer);
	eq(out.length, 1, "layer count");
	eq(out[0].name, "t");
	eq(out[0].extent, 4096);
	eq(out[0].features.length, 0);
});

// ---- colour + geometry ----

t("hexAlpha #rrggbb → rgba", () => {
	eq(dw.hexAlpha("#ff0000", 0.5), "rgba(255,0,0,0.5)");
	eq(dw.hexAlpha("#00ff00", 1),   "rgba(0,255,0,1)");
	eq(dw.hexAlpha("#abcdef", 0.25), "rgba(171,205,239,0.25)");
});

t("hexAlpha leaves non-#rrggbb input alone", () => {
	eq(dw.hexAlpha("#abc", 0.5), "#abc");
	eq(dw.hexAlpha("blue",   0.5), "blue");
});

t("pointInRing for unit square", () => {
	const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
	eq(dw.pointInRing(5, 5, sq), true,  "centre in");
	eq(dw.pointInRing(20, 5, sq), false, "right of");
	eq(dw.pointInRing(-1, 5, sq), false, "left of");
	eq(dw.pointInRing(5, 20, sq), false, "below");
});

// ---- intvl helpers ----

t("intvlActivityTime decodes cuid v1 prefix", () => {
	const ms = Date.UTC(2024, 5, 15, 0, 0, 0);
	const stamp = ms.toString(36);
	const cuid = "c" + stamp.padStart(8, "0") + "extras123";
	const d = dw.intvlActivityTime(cuid);
	if (!(d instanceof Date)) throw new Error("expected Date, got " + d);
	close(d.getTime(), ms, 1000, "decoded time");
});

t("intvlActivityTime rejects garbage", () => {
	eq(dw.intvlActivityTime(null), null);
	eq(dw.intvlActivityTime("xyz"), null);
	eq(dw.intvlActivityTime("c00000000extras"), null);
});

t("intvlAgo formats relative time", () => {
	const now = Date.now();
	eq(dw.intvlAgo(new Date(now)), "today");
	eq(dw.intvlAgo(new Date(now - 86400e3)), "yesterday");
	eq(dw.intvlAgo(new Date(now - 5 * 86400e3)), "5 days ago");
});

t("intvlArea formats m² → km²", () => {
	eq(dw.intvlArea(0), "0 m²");
	eq(dw.intvlArea(50000), "50,000 m²");
	if (!dw.intvlArea(1e6).startsWith("1.00 km²")) {
		throw new Error("1e6 should be 1.00 km², got " + dw.intvlArea(1e6));
	}
	if (!dw.intvlArea(50e6).startsWith("50.0 km²")) {
		throw new Error("50e6 should be 50.0 km², got " + dw.intvlArea(50e6));
	}
});

// ---- Cadastre value helpers ----

t("_cadVal normalises null / 'Null' sentinel / whitespace", () => {
	eq(dw._cadVal(null), "");
	eq(dw._cadVal(undefined), "");
	eq(dw._cadVal(""), "");
	eq(dw._cadVal("  "), "");
	eq(dw._cadVal("Null"), "",      "QLD's 'Null' sentinel string");
	eq(dw._cadVal("  Null  "), "",  "trimmed 'Null'");
	eq(dw._cadVal(" Brisbane "), "Brisbane");
	eq(dw._cadVal("Lot 42"), "Lot 42");
	eq(dw._cadVal(42), "42",        "numeric input coerced");
});

t("_escHtml escapes < > & \"", () => {
	eq(dw._escHtml("<b>Hi</b>"), "&lt;b&gt;Hi&lt;/b&gt;");
	eq(dw._escHtml('"quoted"'),  "&quot;quoted&quot;");
	eq(dw._escHtml("A & B"),     "A &amp; B");
	eq(dw._escHtml(null), "");
	eq(dw._escHtml(undefined), "");
});

t("_fmtPrice formats currency by magnitude", () => {
	eq(dw._fmtPrice(0),    "",        "zero/invalid → empty");
	eq(dw._fmtPrice(NaN),  "");
	eq(dw._fmtPrice(50),   "$50",     "small dollar");
	eq(dw._fmtPrice(1500), "$2k",     "round to nearest k");
	eq(dw._fmtPrice(950),  "$950",    "under 1000 stays raw");
	eq(dw._fmtPrice(5e6),  "$5.0M",   "round million");
	if (!dw._fmtPrice(1234567).startsWith("$1.")) {
		throw new Error("1.234M should start with $1., got " + dw._fmtPrice(1234567));
	}
});

t("_fmtDate extracts MMM YYYY from ISO-like input", () => {
	eq(dw._fmtDate("2024-03-15T00:00:00Z"), "Mar 2024");
	eq(dw._fmtDate("2021-12-31"),           "Dec 2021");
	eq(dw._fmtDate("2024-01-01"),           "Jan 2024");
	eq(dw._fmtDate(""),                     "",  "empty input");
	eq(dw._fmtDate("garbage"),              "garbage", "non-date passes through");
});

// ---- OnTheHouse URL builders ----

t("_slugify produces kebab case", () => {
	eq(dw._slugify("Hello World"),         "hello-world");
	eq(dw._slugify("Tom & Jerry"),         "tom-and-jerry",      "& becomes 'and'");
	eq(dw._slugify("  Multiple   spaces"), "multiple-spaces");
	eq(dw._slugify("Petrie Tce"),          "petrie-tce");
	eq(dw._slugify(null), "");
});

t("_othStreetTypeSlug maps QLD long-form to OTH short slug", () => {
	eq(dw._othStreetTypeSlug("STREET"),    "st");
	eq(dw._othStreetTypeSlug("Road"),      "rd",   "case-insensitive");
	eq(dw._othStreetTypeSlug("AVENUE"),    "ave");
	eq(dw._othStreetTypeSlug("BOULEVARD"), "bvd");
	eq(dw._othStreetTypeSlug("BOULEVARDE"), "bvd", "British spelling");
	eq(dw._othStreetTypeSlug("HIGHWAY"),   "hwy");
	// Unknown types fall through slugified
	eq(dw._othStreetTypeSlug("PROMENADE"), "promenade");
});

t("_othCanonicalUrlFromLocation builds a /property/qld/.../{id} URL", () => {
	const loc = {
		streetNumber: "161", streetName: "Queen", streetType: "STREET",
		suburb: "Brisbane City", postCode: "4000", propertyId: "4071799",
	};
	const url = dw._othCanonicalUrlFromLocation(loc);
	assert(url.startsWith("https://www.onthehouse.com.au/property/qld/"),
		"wrong host/path: " + url);
	assert(url.endsWith("-4071799"),  "missing propertyId tail: " + url);
	assert(url.includes("brisbane-city"), "missing suburb slug: " + url);
	assert(url.includes("161-queen-st"),  "missing street slug: " + url);
	assert(url.includes("qld-4000"),      "missing postcode tail: " + url);
});

// ---- Cadastre tooltip formatter ----

t("_formatCadastreTooltip renders lotplan + locality + area", () => {
	const html = dw._formatCadastreTooltip({
		"Lot/plan":     "12RP123456",
		"Name":         "BLOGGS JOE",
		"Lot area (m²)": "5500",
		"Tenure":       "Freehold",
		"Parcel type":  "Lot",     // Should be filtered out (redundant)
		"Locality":     "Toowong",
		"Local authority": "Brisbane City Council",
	}, null);
	assert(html.includes("12RP123456"),       "missing lotplan");
	assert(html.includes("BLOGGS JOE"),       "missing name");
	assert(html.includes("Toowong"),          "missing locality");
	assert(html.includes("Freehold"),         "missing tenure");
	assert(!html.includes("Lot ·"),           "'Lot' parcel type should be filtered");
	// 5500 m² → "5500 m²" (under 1 ha threshold)
	assert(html.includes("5500"),             "missing area");
});

t("_formatCadastreTooltip converts m² to ha at >=10000", () => {
	const html = dw._formatCadastreTooltip({
		"Lot/plan":      "1SP12345",
		"Lot area (m²)": "25000",
	}, null);
	assert(html.includes("2.50 ha"), "expected ha format, got: " + html);
});

t("_formatCadastreTooltip embeds Sales link when address present", () => {
	const html = dw._formatCadastreTooltip(
		{ "Lot/plan": "12RP123456" },
		{
			primary: "12 Queen St", lat: -27.47, lon: 153.025,
			streetName: "Queen", streetNumber: "12",
		});
	assert(html.includes("dw-cad-sales-link"),
		"Sales link missing when address resolved: " + html);
});

t("_formatAddressLine assembles unit + street + property name", () => {
	eq(dw._formatAddressLine({ street_full: "12 Queen St" }), "12 Queen St");
	eq(dw._formatAddressLine({
		unit_type: "Unit", unit_number: "3", street_full: "12 Queen St",
	}), "Unit 3 / 12 Queen St");
	eq(dw._formatAddressLine({
		street_full: "12 Queen St", property_name: "QV1",
	}), "12 Queen St (QV1)");
	eq(dw._formatAddressLine(null), "");
});

// ---- protobuf value parser ----

t("parseValue decodes string field", () => {
	// Value { string: "hi" } → field 1 (string) wire type 2, length 2, "hi"
	const buf = new Uint8Array([10, 2, 0x68, 0x69]);
	eq(dw.parseValue(buf), "hi");
});

t("parseValue decodes bool field", () => {
	// Value { bool: true } → field 7 wire type 0, 1
	eq(dw.parseValue(new Uint8Array([56, 1])), true);
	eq(dw.parseValue(new Uint8Array([56, 0])), false);
});

t("parseValue decodes uint field", () => {
	// Value { uint: 4096 } → field 5 wire type 0, 4096 (varint 0x80 0x20)
	eq(dw.parseValue(new Uint8Array([40, 0x80, 0x20])), 4096);
});

// ---- prepareLayers (INTVL feature pre-processor) ----

t("prepareLayers filters non-'territories' layers", () => {
	const layers = [
		{ name: "other", extent: 4096, keys: [], values: [], features: [] },
		{ name: "territories", extent: 4096, keys: [], values: [], features: [] },
	];
	const out = dw.prepareLayers(layers, 0.5);
	eq(out.length, 1, "expected only the 'territories' layer");
	eq(out[0].name, "territories");
});

t("prepareLayers sorts features by startTime ASC", () => {
	// Build a layer with three POLYGON features carrying different startTime
	// values via the keys/values pool.
	const keys = ["colour", "startTime"];
	const values = ["#abc", 100, 50, 200];
	const mkFeat = (colourIdx, stIdx) => ({
		type: 3, tags: [0, colourIdx, 1, stIdx],
		geom: [9, 0, 0, 18, 2, 0, 0, 2, 15], // tiny triangle so bbox computes
	});
	const layer = {
		name: "territories", extent: 4096, keys, values,
		features: [
			mkFeat(0, 1), // startTime 100
			mkFeat(0, 2), // startTime 50
			mkFeat(0, 3), // startTime 200
		],
	};
	const out = dw.prepareLayers([layer], 0.5);
	const order = out[0].features.map((f) => f.startTime);
	deepEq(order, [50, 100, 200], "expected ASC order");
});

t("prepareLayers memoises fillStyle per colour", () => {
	const keys = ["colour"];
	const values = ["#abcdef"];
	const layer = {
		name: "territories", extent: 4096, keys, values,
		features: [
			{ type: 3, tags: [0, 0], geom: [9, 0, 0, 18, 2, 0, 0, 2, 15] },
			{ type: 3, tags: [0, 0], geom: [9, 0, 0, 18, 2, 0, 0, 2, 15] },
		],
	};
	const out = dw.prepareLayers([layer], 0.55);
	eq(out[0].features[0].fillStyle, out[0].features[1].fillStyle,
		"same colour should share fillStyle string");
	eq(out[0].features[0].fillStyle, "rgba(171,205,239,0.55)");
});

t("prepareLayers computes per-feature bbox", () => {
	const keys = ["colour"]; const values = ["#abcdef"];
	const layer = {
		name: "territories", extent: 4096, keys, values,
		features: [{
			type: 3, tags: [0, 0],
			// MoveTo(5,10), LineTo(20,20), LineTo(0,30) — triangle
			geom: [9, 10, 20, 18, 30, 20, 39, 20, 15],
		}],
	};
	const out = dw.prepareLayers([layer], 0.5);
	const f = out[0].features[0];
	eq(f.mnX, 0, "min X");  eq(f.mxX, 20, "max X");
	eq(f.mnY, 10, "min Y"); eq(f.mxY, 30, "max Y");
});

// ---- decodeGeometry edge cases ----

t("decodeGeometry handles empty stream", () => {
	deepEq(dw.decodeGeometry([]), []);
});

t("decodeGeometry handles MoveTo + ClosePath without LineTo (degenerate)", () => {
	// Renderer skips rings with <3 verts; decoder still returns the 1-vert ring.
	const rings = dw.decodeGeometry([9, 20, 20, 15]);
	eq(rings.length, 1);
	eq(rings[0].length, 1);
});

t("decodeGeometry decodes nested MultiPolygon (3 rings)", () => {
	const rings = dw.decodeGeometry([
		9, 0, 0,  18, 2, 0, 0, 2,  15,
		9, 10, 0, 18, 2, 0, 0, 2,  15,
		9, 0, 10, 18, 2, 0, 0, 2,  15,
	]);
	eq(rings.length, 3);
});

// -- Summary -----------------------------------------------------------

console.log("");
console.log("unit tests");
console.log("==========");
for (const [ok, name, err] of results) {
	if (ok) console.log(`  ${C_GREEN}PASS${C_OFF}  ${name}`);
	else    console.log(`  ${C_RED}FAIL${C_OFF}  ${name}\n        ${C_DIM}${err}${C_OFF}`);
}
console.log("");
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
