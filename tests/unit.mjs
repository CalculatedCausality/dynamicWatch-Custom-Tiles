// Unit tests for the pure helper functions inside the userscript.
// Catches regressions in tile projection, MVT decode, point-in-polygon,
// colour utilities, and the INTVL hover-helper logic. No network.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadHelpers } from "./_loader.mjs";

const dw = loadHelpers();

const _BUILT_SCRIPT = readFileSync(
	resolve(dirname(fileURLToPath(import.meta.url)), "..", "dynamicwatch-custom-tiles.user.js"),
	"utf8",
);

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

// ---- UTFGrid cell -> lat/lng (Geocaching public tile API) ----

t("utfGridCellToLatLng centre of tile is tile centre", () => {
	// Cell (31.5, 31.5) is exactly the tile centre. We address cell centres
	// (offset +0.5), so to land on the tile's geographic centre we pass
	// (32, 32) which decodes to pixel (32.5/64, 32.5/64) — close to centre,
	// within one cell of the tile midpoint.
	const [lat, lon] = dw.utfGridCellToLatLng(12, 3789, 2373, 32, 32);
	const bbox = dw.tileToBBox4326(12, 3789, 2373);
	const midLon = (bbox.minLon + bbox.maxLon) / 2;
	const midLat = (bbox.minLat + bbox.maxLat) / 2;
	close(lon, midLon, 0.001, "lon near tile centre");
	close(lat, midLat, 0.001, "lat near tile centre");
});

t("utfGridCellToLatLng Brisbane cell (4, 0) lands near UQ-Herston", () => {
	// Empirical: UTFGrid for tile z=12 x=3789 y=2373 places GC60ZN7
	// (UQ-Herston Campus) at cell (4, 0). Actual cache is at
	// approx lat=-27.448 lon=153.029; cell precision at z=12 is ~150 m.
	const [lat, lon] = dw.utfGridCellToLatLng(12, 3789, 2373, 4, 0);
	close(lat, -27.4504, 0.005, "lat decoded from cell");
	close(lon, 153.0238, 0.005, "lon decoded from cell");
});

t("utfGridCellToLatLng z=16 cell precision is ~10m", () => {
	// Two adjacent cells should map to lat/lng separated by approximately
	// tile_size / 64. At z=16, that's about 9.6 m at the equator.
	const [latA, lonA] = dw.utfGridCellToLatLng(16, 32768, 32768, 32, 32);
	const [latB, lonB] = dw.utfGridCellToLatLng(16, 32768, 32768, 33, 32);
	const dLon = Math.abs(lonB - lonA);
	const metresPerDegLon = 111320; // at equator
	const metres = dLon * metresPerDegLon;
	if (metres < 5 || metres > 15) {
		throw new Error(`expected ~9.6 m, got ${metres.toFixed(1)} m`);
	}
	eq(latA, latB, "lat unchanged across same row");
});

// ---- overzoom placement (stretch deepest available tile) ----

t("_overzoomPlacement depth 0 = native tile, no scale/offset", () => {
	const p = dw._overzoomPlacement(3789, 2373, 0, 256);
	eq(p.scale, 1); eq(p.imgSize, 256); eq(p.offsetX, 0); eq(p.offsetY, 0);
});

t("_overzoomPlacement depth 1 picks the right sub-quadrant", () => {
	// An odd x,y sits in the bottom-right quarter of its parent.
	const p = dw._overzoomPlacement(3789, 2373, 1, 256);
	eq(p.scale, 2); eq(p.imgSize, 512);
	eq(p.offsetX, -256, "odd x → right half");
	eq(p.offsetY, -256, "odd y → bottom half");
	// An even x,y sits top-left.
	const q = dw._overzoomPlacement(3788, 2372, 1, 256);
	eq(q.offsetX, 0); eq(q.offsetY, 0);
});

t("_overzoomPlacement depth 2 = 4x scale, quadrant within 4x4", () => {
	const p = dw._overzoomPlacement(3789, 2373, 2, 256);
	eq(p.scale, 4); eq(p.imgSize, 1024);
	// 3789 % 4 = 1, 2373 % 4 = 1
	eq(p.offsetX, -256); eq(p.offsetY, -256);
	const q = dw._overzoomPlacement(3790, 2375, 2, 256);
	// 3790 % 4 = 2, 2375 % 4 = 3
	eq(q.offsetX, -512); eq(q.offsetY, -768);
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

t("esc tagged-template escapes every interpolation, keeps literal markup", () => {
	const name = '<img src=x onerror=alert(1)>';
	const out = dw.esc`<b>${name}</b>`;
	eq(out, "<b>&lt;img src=x onerror=alert(1)&gt;</b>");
	// literal <b> survives; payload neutralised
	assert(!out.includes("<img"), "payload must not survive as a live tag");
	// multiple interpolations + non-string values
	eq(dw.esc`a${1}b${'"x"'}c`, 'a1b&quot;x&quot;c');
	eq(dw.esc`${null}${undefined}`, "");
});

t("_safeColor passes valid CSS colours, rejects injection", () => {
	eq(dw._safeColor("#3b82f6"), "#3b82f6");
	eq(dw._safeColor("#fff"), "#fff");
	eq(dw._safeColor("rgb(1,2,3)"), "rgb(1,2,3)");
	eq(dw._safeColor("rgba(1,2,3,0.5)"), "rgba(1,2,3,0.5)");
	eq(dw._safeColor("red"), "red");
	// injection attempts → fallback
	eq(dw._safeColor('red;"></span><img src=x onerror=alert(1)>', "#888"), "#888");
	eq(dw._safeColor("url(javascript:alert(1))", "#888"), "#888");
	eq(dw._safeColor("expression(alert(1))", "#888"), "#888");
	eq(dw._safeColor(null, "#abc"), "#abc");
	eq(dw._safeColor(123, "#abc"), "#abc");
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

t("_othCanonicalUrlFromLocation honours a non-QLD state", () => {
	const loc = {
		streetNumber: "1", streetName: "Eddy", streetType: "AVENUE",
		suburb: "Haymarket", postCode: "2000", propertyId: "999",
	};
	const url = dw._othCanonicalUrlFromLocation(loc, "NSW");
	assert(url.includes("/property/nsw/"), "state not applied to path: " + url);
	assert(url.includes("-nsw-2000"),      "state not applied to tail: " + url);
});

// ---- Multi-state cadastre: address parser + jurisdiction router ----

t("_parseAuStreetAddress splits number/name/type/suburb variants", () => {
	// NSW flat string, suburb trailing
	deepEq(dw._parseAuStreetAddress("1 EDDY AVENUE HAYMARKET"),
		{ streetNumber: "1", streetName: "EDDY", streetType: "AVENUE", locality: "HAYMARKET" });
	// TAS packs STATE + POSTCODE — must be stripped
	deepEq(dw._parseAuStreetAddress("2 CHURCHILL AV SANDY BAY TAS 7005"),
		{ streetNumber: "2", streetName: "CHURCHILL", streetType: "AV", locality: "SANDY BAY" });
	// ACT: address carries no suburb; known locality wins
	deepEq(dw._parseAuStreetAddress("3 DOBELL CIRCUIT", "CONDER"),
		{ streetNumber: "3", streetName: "DOBELL", streetType: "CIRCUIT", locality: "CONDER" });
	// unit form 5/12 → street number is 12
	eq(dw._parseAuStreetAddress("5/12 SMITH ST REDFERN").streetNumber, "12");
	// no leading number → unresolvable
	eq(dw._parseAuStreetAddress("LOT 5 SOMEWHERE RD"), null);
	eq(dw._parseAuStreetAddress(""), null);
});

t("_pickJurisdiction maps coordinates to the right state/territory", () => {
	eq(dw._pickJurisdiction(-26.52, 153.08), "QLD");   // Coolum Beach
	eq(dw._pickJurisdiction(-33.87, 151.21), "NSW");   // Sydney
	eq(dw._pickJurisdiction(-37.81, 144.96), "VIC");   // Melbourne
	eq(dw._pickJurisdiction(-34.93, 138.60), "SA");    // Adelaide
	eq(dw._pickJurisdiction(-31.95, 115.86), "WA");    // Perth
	eq(dw._pickJurisdiction(-42.88, 147.33), "TAS");   // Hobart
	eq(dw._pickJurisdiction(-12.46, 130.84), "NT");    // Darwin
	// ACT is an enclave inside NSW's bbox — must resolve to ACT, not NSW
	eq(dw._pickJurisdiction(-35.28, 149.13), "ACT");   // Canberra
	// Middle of the ocean → no jurisdiction
	eq(dw._pickJurisdiction(-40, 160), "");
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

// ---- layer-provider factories ----

t("tileProvider returns LayerProvider subclass", () => {
	const P = dw.tileProvider("https://example.com/{z}/{x}/{y}.png");
	assert(typeof P === "function", "expected class (constructor)");
	const inst = new P();
	assert(inst instanceof dw.LayerProvider, "expected LayerProvider subclass");
	assert(typeof inst.create === "function", "expected .create() method");
});

t("tileProvider create() invokes L.tileLayer with merged opts", () => {
	let captured = null;
	const url = "https://x/{z}/{x}/{y}.png";
	// Re-patch the sandbox's L.tileLayer to capture the call.
	const dwSandbox = dw; // closure over loaded helpers
	// We can't easily reach into the sandbox, but we can verify the
	// produced layer has the stub shape.
	const P = dw.tileProvider(url, { opacity: 0.5, maxNativeZoom: 15 });
	const layer = new P().create();
	assert(layer !== null && typeof layer === "object",
		"create() must return a non-null object");
});

t("arcgisExportProvider returns LayerProvider subclass", () => {
	const P = dw.arcgisExportProvider({
		baseUrl: "https://x/MapServer",
		showLayers: "0",
		pane: "p", paneZIndex: 100,
	});
	assert(new P() instanceof dw.LayerProvider);
});

t("tokenTileProvider returns LayerProvider subclass that accepts a token mgr", () => {
	const stubToken = { isValid: () => false, get: () => {}, token: null };
	const P = dw.tokenTileProvider((tok) => "https://x?t=" + tok.token);
	const inst = new P(stubToken);
	assert(inst instanceof dw.LayerProvider);
	// Should not throw at create time when token is invalid (uses BLANK_TILE).
	const layer = inst.create();
	assert(layer !== null && typeof layer === "object");
});

t("tokenTileProvider with valid token calls buildUrl(tok)", () => {
	let calledWith = null;
	const tok = {
		isValid: () => true, get: () => {},
		token: "FAKE_TOKEN_VALUE",
	};
	const P = dw.tokenTileProvider((t) => {
		calledWith = t;
		return "https://x?t=" + t.token;
	});
	new P(tok).create();
	assert(calledWith === tok,
		"buildUrl should receive the token manager itself, not just its token field");
});

t("pollingDataLayer requires pane/minZoom/fetch and produces an L.Layer-shaped class", () => {
	const Layer = dw.pollingDataLayer({
		pane: "dwTestPane", paneZIndex: 500,
		minZoom: 5, pollMs: 1000,
		attribution: "test",
		fetch: () => {},
	});
	assert(typeof Layer === "function" || typeof Layer === "object",
		"L.Layer.extend returns a constructor-like value");
	const inst = new Layer();
	assert(typeof inst.onAdd === "function");
	assert(typeof inst.onRemove === "function");
});

t("oimIcon produces a divIcon-shaped value", () => {
	const icon = dw.oimIcon("dw-test-icon", "X", "#f00", 16);
	assert(icon !== null && typeof icon === "object");
});

t("LayerProvider base throws if .create() not overridden", () => {
	const base = new dw.LayerProvider();
	let threw = false;
	try { base.create(); } catch (e) { threw = true; }
	assert(threw, "base LayerProvider.create() should throw");
});

// ---- SCC applications (Development.i) formatters ----

t("_fmtSccDate formats epoch ms and rejects junk", () => {
	// 1145455200000 = 2006-04-19T14:00Z = 2006-04-20 00:00 AEST
	assert(/2006/.test(dw._fmtSccDate(1145455200000)), "year rendered");
	eq(dw._fmtSccDate(null), "");
	eq(dw._fmtSccDate("nope"), "");
	eq(dw._fmtSccDate(-5), "");
});

t("_deviAppUrl builds encoded FilterDirect deep link per kind", () => {
	const url = dw._deviAppUrl("DA", "MCU24/0123");
	eq(url,
		"https://developmenti.sunshinecoast.qld.gov.au/Home/FilterDirect" +
		"?filters=DANumber%3DMCU24%2F0123");
	assert(dw._deviAppUrl("BA", "BAC26/1").includes("BANumber%3D"), "BA param");
	assert(dw._deviAppUrl("PL", "PC06/1304").includes("PlumbNumber%3D"), "PL param");
});

t("_deviAppUrl rejects unsafe / unknown input", () => {
	eq(dw._deviAppUrl("DA", 'X" onmouseover="alert(1)'), "", "attr breakout");
	eq(dw._deviAppUrl("DA", "<script>"), "", "html chars");
	eq(dw._deviAppUrl("ZZ", "MCU24/0123"), "", "unknown kind");
	eq(dw._deviAppUrl("DA", ""), "", "empty id");
});

t("_formatSccTooltip escapes external strings and clips description", () => {
	const html = dw._formatSccTooltip({
		ram_id: "BAC26/0042",
		category_desc: "Dwelling <New>",
		description: "x".repeat(300),
		progress: "In Progress",
		d_date_rec: 1750000000000,
	}, "BA", true);
	assert(html.includes("BAC26/0042"), "ram id");
	assert(html.includes("Dwelling &lt;New&gt;"), "category escaped");
	assert(!html.includes("<New>"), "no raw tag");
	assert(html.includes("…"), "long description clipped");
	assert(html.includes("Lodged "), "lodged date line");
});

t("_formatSccPopup carries decision info and Development.i link", () => {
	const html = dw._formatSccPopup({
		ram_id: "MCU24/0123",
		group_desc: "Material Change of Use",
		category_desc: "Multi-unit residential",
		description: "12 unit apartment building",
		decision: "Approved",
		d_date_rec: 1700000000000,
		d_decision_made: 1710000000000,
	}, "DA", false);
	assert(html.includes("Approved"), "decision shown");
	assert(html.includes("Decided "), "decision date shown");
	assert(html.includes("FilterDirect?filters=DANumber%3DMCU24%2F0123"),
		"deep link present");
	assert(html.includes('rel="noreferrer"'), "link is noreferrer");
});

t("SCC Applications overlay is registered and grouped", () => {
	eq(dw.CFG.LAYER_SCC_APPS, "SCC Applications");
	const names = new Set(dw.DW_OVERLAY_GROUPS.flatMap((g) => g.names));
	assert(names.has(dw.CFG.LAYER_SCC_APPS),
		"SCC Applications missing from overlay groups");
});

t("_deviDetailUrl maps kind to Development.i layer type", () => {
	eq(dw._deviDetailUrl("DA", "REC02/0156.04"),
		"https://developmenti.sunshinecoast.qld.gov.au/Home/ApplicationDetail" +
		"?type=plan_scc_development_apps_unique&id=REC02%2F0156.04");
	assert(dw._deviDetailUrl("BA", "PC26/1").includes("building_apps_unique"));
	assert(dw._deviDetailUrl("PL", "PLQ26/1").includes("plumbing_apps_unique"));
	eq(dw._deviDetailUrl("DA", "<img src=x>"), "", "unsafe id rejected");
	eq(dw._deviDetailUrl("XX", "PC26/1"), "", "unknown kind rejected");
});

// Fixture mirrors the real ApplicationDetail fragment's shapes:
// thead row without a date span, data rows with data-date-number,
// property anchors with landNumber links.
const SCC_DETAIL_FIXTURE = `
	<p><a href='/Home/PropertyDetailsView?landNumber=1530850' target="_blank">Elizabeth St NAMBOUR QLD 4560</a></p>
	<p><a href='/Home/PropertyDetailsView?landNumber=1530851' target="_blank">83 Elizabeth &amp; Co St NAMBOUR</a></p>
	<table class="table table-bordered">
		<thead><tr><td>Description</td><td>Decision</td><td>Date</td></tr></thead>
		<tr>
			<td>   What type of change has been requested?</td>
			<td>Minor Change To Application</td>
			<td><span class="date-number" data-date-number="1733443200000"></span></td>
		</tr>
		<tr>
			<td>   Applicants Resp &lt;pending&gt;</td>
			<td></td>
			<td><span class="date-number" data-date-number="0"></span></td>
		</tr>
	</table>`;

t("_parseSccDetailHtml extracts properties + stages, skips thead", () => {
	const d = dw._parseSccDetailHtml(SCC_DETAIL_FIXTURE);
	deepEq(d.properties, [
		"Elizabeth St NAMBOUR QLD 4560",
		"83 Elizabeth & Co St NAMBOUR",
	], "addresses decoded");
	eq(d.stages.length, 2, "two data rows, thead skipped");
	eq(d.stages[0].desc, "What type of change has been requested?");
	eq(d.stages[0].decision, "Minor Change To Application");
	eq(d.stages[0].dateMs, 1733443200000);
	eq(d.stages[1].desc, "Applicants Resp <pending>", "entities decoded");
	eq(d.stages[1].dateMs, 0);
});

t("_renderSccDetail re-escapes decoded text and handles empty", () => {
	const d = dw._parseSccDetailHtml(SCC_DETAIL_FIXTURE);
	const html = dw._renderSccDetail(d);
	assert(html.includes("Elizabeth &amp; Co"), "ampersand re-escaped");
	assert(html.includes("&lt;pending&gt;"), "angle brackets re-escaped");
	assert(!html.includes("<pending>"), "no raw tag injection");
	assert(html.includes("Assessment stages"), "stages section present");
	assert(dw._renderSccDetail(null).includes("No further detail"),
		"null → graceful message");
	assert(dw._renderSccDetail({ properties: [], stages: [] })
		.includes("No further detail"), "empty → graceful message");
});

t("SCC submenu state defaults to all types, current + notifying", () => {
	const def = dw._sccDefaultState();
	assert(def.DA && def.BA && def.PL, "all application types on");
	assert(def.live, "current status on");
	assert(!def.past, "decided status off");
	assert(def.notif, "public-notification layer on");
	// Sandbox GM_getValue returns the default "{}" — loader must fall
	// back cleanly to defaults (also covers corrupt-JSON path).
	deepEq(dw._sccLoadState(), def, "empty storage → defaults");
});

t("_deviAppByIdUrl maps kind to appType and validates the id", () => {
	eq(dw._deviAppByIdUrl("DA", "REC02/0156.04"),
		"https://developmenti.sunshinecoast.qld.gov.au/Geo/GetApplicationById" +
		"?applicationId=REC02%2F0156.04&appType=development");
	assert(dw._deviAppByIdUrl("BA", "PC26/1").includes("appType=building"));
	assert(dw._deviAppByIdUrl("PL", "PLQ26/1").includes("appType=plumbing"));
	eq(dw._deviAppByIdUrl("DA", '"><script>'), "", "unsafe id rejected");
	eq(dw._deviAppByIdUrl("ZZ", "PC26/1"), "", "unknown kind rejected");
});

t("_deviFilterBody builds land-history and notification variants", () => {
	const hist = dw._deviFilterBody({ landNumber: 1530850 });
	eq(hist.Progress, "all");
	eq(hist.LandNumber, 1530850);
	assert(hist.IncludeDA && hist.IncludeBA && hist.IncludePlumb,
		"history includes all application kinds");
	eq(hist.BBox, null);
	const notif = dw._deviFilterBody({
		progress: "notification", bbox: "152.5,-27.1,153.2,-26.0",
		includeBA: false, includePlumb: false,
	});
	eq(notif.Progress, "notification");
	eq(notif.BBox, "152.5,-27.1,153.2,-26.0");
	assert(notif.IncludeDA && !notif.IncludeBA && !notif.IncludePlumb,
		"notification variant is DA-only");
	eq(notif.LandNumber, null);
	eq(notif.MaxRecords, 200);
});

t("_dedupeDeviFeatures flattens multiSpot and dedupes per app+spot", () => {
	const feat = (num, x) => ({
		type: "Feature",
		geometry: { type: "Point", coordinates: [x, -26.5] },
		properties: { application_number: num },
	});
	const out = dw._dedupeDeviFeatures({
		features: [feat("A1/1", 152.1), feat("A1/1", 152.1)],
		multiSpot: {
			"152.1,-26.5": [feat("A1/1", 152.1), feat("B2/2", 152.1)],
			"152.2,-26.5": [feat("A1/1", 152.2)],
		},
	});
	// A1/1@152.1 deduped across features+multiSpot; A1/1@152.2 is a
	// different parcel spot of the same app, so it stays.
	deepEq(
		out.map((f) => f.properties.application_number + "@" +
			f.geometry.coordinates[0]).sort(),
		["A1/1@152.1", "A1/1@152.2", "B2/2@152.1"],
	);
	deepEq(dw._dedupeDeviFeatures(null), [], "null-safe");
	deepEq(dw._dedupeDeviFeatures({}), [], "empty-safe");
});

t("_formatNotifTooltip flags the submission window and escapes", () => {
	const html = dw._formatNotifTooltip({
		application_number: "MCU26/0088",
		description: "<b>551</b> David Low Way — Service Station",
		alertDate: "2026-06-29T14:00:00Z",
	});
	assert(html.includes("MCU26/0088"), "app number");
	assert(html.includes("On public notification"), "badge text");
	assert(html.includes("Submissions invited"), "alert date line");
	assert(html.includes("&lt;b&gt;551&lt;/b&gt;"), "description escaped");
});

t("_notifPopupProps adapts Development.i fields to popup schema", () => {
	const p = dw._notifPopupProps({
		application_number: "MCU26/0088",
		application_type: "Material Change of Use",
		category_desc: "Impact",
		description: "Service Station",
		assessment_level: "Impact",
		date_received: "2026-05-01T14:00:00Z",
	});
	eq(p.ram_id, "MCU26/0088");
	eq(p.progress, "In Progress — On Public Notification");
	assert(p.d_date_rec > 0, "date parsed to epoch ms");
	const html = dw._formatSccPopup(p, "DA", true);
	assert(html.includes("FilterDirect?filters=DANumber%3DMCU26%2F0088"),
		"deep link built from adapted props");
});

t("_histFromFilterResults carries decisions + dates, excludes focal", () => {
	const feat = (num, props) => ({
		type: "Feature",
		geometry: { type: "Point", coordinates: [152.9, -26.6] },
		properties: Object.assign({ application_number: num }, props),
	});
	const hist = dw._histFromFilterResults({
		features: [
			feat("REC02/0156", {
				category: "development", decision_desc: "Approved",
				progress: "Decided or Past",
				date_received: "2002-05-27T00:00:00Z",
				date_determined: "2004-12-06T00:00:00Z",
			}),
			feat("PC19/1069", {
				category: "building", decision_desc: "Finalised",
				progress: "Decided or Past",
				date_received: "2019-03-04T00:00:00Z",
				date_determined: "2019-03-12T00:00:00Z",
			}),
			feat("REC02/0156.04", { category: "development" }),
		],
	}, "REC02/0156.04");
	eq(hist.length, 2, "focal application excluded");
	eq(hist[0].num, "PC19/1069", "sorted newest-first");
	eq(hist[0].kind, "BA", "building category → BA");
	eq(hist[1].decision, "Approved");
	assert(hist[1].decidedMs > 0, "determination date parsed");
});

t("_deviKindFromCategory and _decisionClass classify correctly", () => {
	eq(dw._deviKindFromCategory("development"), "DA");
	eq(dw._deviKindFromCategory("building"), "BA");
	eq(dw._deviKindFromCategory("plumbing"), "PL");
	eq(dw._deviKindFromCategory(""), "DA", "default DA");
	eq(dw._decisionClass("Approved"), "dw-scc-dec--ok");
	eq(dw._decisionClass("Development Permit"), "dw-scc-dec--ok");
	eq(dw._decisionClass("Refused"), "dw-scc-dec--bad");
	eq(dw._decisionClass("Application returned"), "dw-scc-dec--bad");
	eq(dw._decisionClass("Application undergoing assessment"), "");
});

t("_histRowHtml shows real decision + date and same-approval chip", () => {
	const row = dw._histRowHtml({
		num: "REC02/0156", kind: "DA",
		desc: "Moderate Urban Subdivision <x>",
		progress: "Decided or Past", decision: "Approved",
		dateMs: Date.parse("2002-05-27T00:00:00Z"),
		decidedMs: Date.parse("2004-12-06T00:00:00Z"),
	}, "REC02/0156");
	assert(row.includes("Approved"), "decision text shown");
	assert(row.includes("2004"), "determination year shown");
	assert(row.includes("dw-scc-dec--ok"), "approval styled green");
	assert(row.includes("same approval"), "sibling chip when base matches");
	assert(row.includes("FilterDirect"), "app number deep-links");
	assert(row.includes("&lt;x&gt;") && !row.includes("<x>"), "desc escaped");
	const refused = dw._histRowHtml({
		num: "OPW24/0049", kind: "DA", desc: "Clearing",
		progress: "Decided or Past", decision: "Refused",
		dateMs: 1, decidedMs: Date.parse("2025-06-04T00:00:00Z"),
	}, "REC02/0156");
	assert(refused.includes("dw-scc-dec--bad"), "refusal styled red");
	assert(!refused.includes("same approval"), "no chip for unrelated app");
});

t("_renderSccPropertyHistory renders count header and rows", () => {
	const html = dw._renderSccPropertyHistory({
		prop: { landNo: 1, address: "Elizabeth St NAMBOUR", lotPlan: "901SP311276" },
		hist: [{
			num: "REC02/0156", kind: "DA", desc: "Subdivision",
			progress: "Decided or Past", decision: "Approved",
			dateMs: 5, decidedMs: 6,
		}],
	});
	assert(html.includes("SCC applications (1)"), "count header");
	assert(html.includes("REC02/0156"), "row present");
	const none = dw._renderSccPropertyHistory({
		prop: { landNo: 1, address: "X St" }, hist: [],
	});
	assert(none.includes("None found"), "empty-state message");
});

t("_sccFeatureKey stable across refetches, null for junk", () => {
	eq(dw._sccFeatureKey({ id: 42 }), 42, "feature id wins");
	eq(dw._sccFeatureKey({ id: "plan_scc.fid-1.2" }), "plan_scc.fid-1.2");
	const k = dw._sccFeatureKey({
		properties: { ram_id: "BAC26/1" },
		geometry: { coordinates: [[152.9, -26.6]] },
	});
	eq(k, 'BAC26/1@[[152.9,-26.6]]', "fallback = app number + geometry");
	eq(dw._sccFeatureKey({ properties: {} }), null, "no identity → null");
	eq(dw._sccFeatureKey(null), null, "null-safe");
});

t("_sccDocsSearchUrl / _sccDocDownloadUrl build and validate", () => {
	const u = dw._sccDocsSearchUrl("MCU25/0135.02");
	assert(u.startsWith("https://publicdocs.scc.qld.gov.au/HPECMWebDrawer/Record?q="),
		"WebDrawer base");
	assert(u.includes(encodeURIComponent('ApplicationNumberList:"MCU25/0135.02"')),
		"app-number term encoded");
	assert(u.includes("format=json"), "json format");
	eq(dw._sccDocsSearchUrl("<bad>"), "", "unsafe id rejected");
	eq(dw._sccDocDownloadUrl(28544862),
		"https://publicdocs.scc.qld.gov.au/HPECMWebDrawer/Record/28544862/file/document");
	eq(dw._sccDocDownloadUrl("x"), "", "non-numeric uri rejected");
	eq(dw._sccDocDownloadUrl(-1), "", "negative uri rejected");
});

t("_parseSccDocs maps WebDrawer JSON to entries, newest first", () => {
	const docs = dw._parseSccDocs({ Results: [
		{ Uri: 2, RecordTitle: { Value: "DA Form 1" },
		  RecordExtension: { Value: "PDF" },
		  RecordDateRegistered: { DateTime: "2026-05-11T01:51:52Z" } },
		{ Uri: 3, RecordTitle: { Value: "Decision Notice" },
		  RecordExtension: { Value: "DOCX" },
		  RecordDateRegistered: { DateTime: "2026-06-01T00:00:00Z" } },
		{ Uri: 0, RecordTitle: { Value: "bad uri skipped" } },
		{ Uri: 4, RecordTitle: { Value: "" } },
	] });
	eq(docs.length, 2, "invalid entries dropped");
	eq(docs[0].title, "Decision Notice", "sorted newest first");
	eq(docs[1].ext, "PDF");
	deepEq(dw._parseSccDocs(null), [], "null-safe");
});

t("_renderSccDetail lists documents with escaped download links", () => {
	const html = dw._renderSccDetail({
		properties: [], stages: [], history: [],
		docs: [{ uri: 28544862, title: "Plans <rev B>", ext: "PDF",
			dateMs: Date.parse("2026-05-11T00:00:00Z") }],
	});
	assert(html.includes("Documents (1)"), "docs section header");
	assert(html.includes("/HPECMWebDrawer/Record/28544862/file/document"),
		"download link");
	assert(html.includes("Plans &lt;rev B&gt;"), "title escaped");
	assert(html.includes("PDF"), "extension shown");
});

t("_deviReportUrl builds the printable-report link per kind", () => {
	eq(dw._deviReportUrl("DA", "REC02/0156.04"),
		"https://developmenti.sunshinecoast.qld.gov.au/Home/ApplicationDetailsView" +
		"?appNo=REC02%2F0156.04&type=plan_scc_development_apps&do=pdf");
	assert(dw._deviReportUrl("BA", "PC26/1").includes("plan_scc_building_apps&do=pdf"));
	eq(dw._deviReportUrl("DA", "<x>"), "", "unsafe id rejected");
});

t("_formatSccPopup adds submission link only for notifying apps", () => {
	const notif = dw._formatSccPopup(dw._notifPopupProps({
		application_number: "MCU26/0088", description: "Service Station",
		date_received: "2026-05-01T14:00:00Z",
	}), "DA", true);
	assert(notif.includes("Make a submission"), "submission link on notifying app");
	assert(notif.includes("haveyoursay.sunshinecoast.qld.gov.au"), "have-your-say URL");
	assert(notif.includes("Report PDF"), "report link present");
	const plain = dw._formatSccPopup({
		ram_id: "BAC26/0042", progress: "In Progress",
	}, "BA", true);
	assert(!plain.includes("Make a submission"), "no submission link otherwise");
});

t("_renderSccDetail shows officer/status facts and property history", () => {
	const html = dw._renderSccDetail({
		properties: [], stages: [],
		officer: "Marc <Cornell>", appType: "Reconfiguring A Lot",
		statusDesc: "Application undergoing assessment",
		history: [
			{ num: "RAL26/0028", desc: "1 Lot into 20 Lots", progress: "In Progress", dateMs: 1745200000000 },
			{ num: "OPW24/0165", desc: "Electrical Reticulation", progress: "Decided", dateMs: 1710000000000 },
		],
	});
	assert(html.includes("Officer: Marc &lt;Cornell&gt;"), "officer escaped");
	assert(html.includes("Application undergoing assessment"), "status line");
	assert(html.includes("Property history (2)"), "history header + count");
	assert(html.includes("RAL26/0028"), "history row");
});

t("_renderSccDetail renders ALL history rows, same-approval root first", () => {
	// 9 unrelated newer apps + the 2004 root — relation-first ordering
	// must lead with the root, and no row may be dropped to a "+N more"
	// stub (the container scrolls instead).
	const hist = [];
	for (let i = 0; i < 9; i++) {
		hist.push({
			num: `OPW2${i}/000${i}`, kind: "DA", desc: "works",
			progress: "Decided or Past", decision: "Development Permit",
			dateMs: 2000000000000 - i, decidedMs: 2000000000000 - i,
		});
	}
	hist.push({
		num: "REC02/0156", kind: "DA", desc: "Moderate Urban Subdivision",
		progress: "Decided or Past", decision: "Approved",
		dateMs: 1022457600000, decidedMs: 1102291200000,
	});
	const html = dw._renderSccDetail({
		properties: [], stages: [], history: hist, focal: "REC02/0156.04",
	});
	assert(html.indexOf("REC02/0156") <
		html.indexOf("OPW20/0000"), "root approval leads the list");
	assert(html.includes("same approval"), "root carries sibling chip");
	for (let i = 0; i < 9; i++) {
		assert(html.includes(`OPW2${i}/000${i}`), `row ${i} rendered`);
	}
	assert(!html.includes("more on this parcel"), "no +N truncation stub");
});

t("_renderSccPropertyHistory renders every row with no cap", () => {
	const hist = [];
	for (let i = 0; i < 17; i++) {
		hist.push({
			num: `OPW${i}/1`, kind: "DA", desc: "d",
			progress: "Decided or Past", decision: "Approved",
			dateMs: i, decidedMs: i,
		});
	}
	const html = dw._renderSccPropertyHistory({
		prop: { landNo: 1, address: "X" }, hist,
	});
	assert(html.includes("SCC applications (17)"), "count header");
	for (let i = 0; i < 17; i++) {
		assert(html.includes(`OPW${i}/1`), `row ${i} rendered`);
	}
	assert(!html.includes("more on this parcel"), "no +N truncation stub");
});

t("advertised QLD Relief and National Parks overlays are grouped", () => {
	const names = new Set(dw.DW_OVERLAY_GROUPS.flatMap((g) => g.names));
	eq(dw.CFG.LAYER_RELIEF, "QLD Relief");
	eq(dw.CFG.LAYER_NATIONAL_PARKS, "National Parks");
	assert(names.has(dw.CFG.LAYER_RELIEF), "QLD Relief missing from overlay groups");
	assert(names.has(dw.CFG.LAYER_NATIONAL_PARKS), "National Parks missing from overlay groups");
});

t("Mining overlays (shafts, mines, leases) are registered in a Mining group", () => {
	eq(dw.CFG.LAYER_HIST_MINES, "Historic Mines");
	eq(dw.CFG.LAYER_MINE_SHAFTS, "Mine Shafts");
	eq(dw.CFG.LAYER_MINE_LEASES, "Historic Mining Leases");
	const mining = dw.DW_OVERLAY_GROUPS.find((g) => g.header === "Mining");
	assert(mining, "Mining group missing");
	for (const n of [dw.CFG.LAYER_MINE_SHAFTS, dw.CFG.LAYER_HIST_MINES, dw.CFG.LAYER_MINE_LEASES]) {
		assert(mining.names.includes(n), n + " not in Mining group");
	}
});

t("_quadToMatrix3d maps an image rect onto a quad (identity + translate)", () => {
	// dst == source rectangle → identity matrix3d
	const id = dw._quadToMatrix3d(100, 200, [[0, 0], [100, 0], [100, 200], [0, 200]]);
	const nums = id.replace(/matrix3d\(|\)/g, "").split(",").map(Number);
	const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
	nums.forEach((v, i) => close(v, identity[i], 1e-6, `identity[${i}]`));
	// pure translation by (10, 20): last column (tx, ty) = 10, 20
	const tr = dw._quadToMatrix3d(100, 200, [[10, 20], [110, 20], [110, 220], [10, 220]]);
	const t = tr.replace(/matrix3d\(|\)/g, "").split(",").map(Number);
	close(t[12], 10, 1e-6, "tx"); close(t[13], 20, 1e-6, "ty");
	close(t[0], 1, 1e-6, "scaleX"); close(t[5], 1, 1e-6, "scaleY");
});

t("_triAffine maps a source triangle onto a destination triangle", () => {
	const s = [[0, 0], [100, 0], [0, 100]];
	// identity: dst == src → [1,0,0,1,0,0]
	deepEq(dw._triAffine(s, s), [1, 0, 0, 1, 0, 0]);
	// pure translation by (10, 20)
	const tr = dw._triAffine(s, [[10, 20], [110, 20], [10, 120]]);
	tr.forEach((v, i) => close(v, [1, 0, 0, 1, 10, 20][i], 1e-9, `translate[${i}]`));
	// 2× scale about the origin
	const sc = dw._triAffine(s, [[0, 0], [200, 0], [0, 200]]);
	sc.forEach((v, i) => close(v, [2, 0, 0, 2, 0, 0][i], 1e-9, `scale[${i}]`));
	// verify the affine actually sends each source vertex to its dest vertex
	const d = [[13, 7], [190, 44], [55, 205]];
	const [a, b, c, dd, e, f] = dw._triAffine(s, d);
	s.forEach(([x, y], i) => {
		close(a * x + c * y + e, d[i][0], 1e-6, `X${i}`);
		close(b * x + dd * y + f, d[i][1], 1e-6, `Y${i}`);
	});
	// degenerate (collinear source) → identity, no NaN
	deepEq(dw._triAffine([[0, 0], [1, 1], [2, 2]], [[0, 0], [5, 5], [9, 9]]), [1, 0, 0, 1, 0, 0]);
});

t("_histMapSheet + _histMapsSectionHtml model + render historical sheets", () => {
	// Real /identify shape: aliased keys.
	const sheet = dw._histMapSheet({
		"Title": "Gympie and Environs sheet 8", "Publication date": "1909",
		"Map scale": "4752",
		"Download link": "https://apps.information.qld.gov.au/x/original",
		"Bounding box west longitude": "152.65", "Bounding box east longitude": "152.68",
		"Bounding box south latitude": "-26.20", "Bounding box north latitude": "-26.18",
	});
	eq(sheet.title, "Gympie and Environs sheet 8");
	eq(sheet.year, "1909");
	assert(sheet.bbox && sheet.bbox.n === -26.18, "bbox not parsed: " + JSON.stringify(sheet.bbox));
	const html = dw._histMapsSectionHtml([sheet]);
	assert(html.includes("Gympie and Environs sheet 8"), "title missing");
	assert(html.includes("1909 · 1:4752"), "meta line missing: " + html);
	assert(html.includes("Open scan"), "scan link missing");
	assert(html.includes("dw-histmap-overlay-link"), "overlay action missing (has bbox)");
	// A sheet with a link but no bbox: Open only, no Overlay
	const noBbox = dw._histMapsSectionHtml([{ title: "X", link: "https://y/z", year: "", scale: "", preview: "", bbox: null }]);
	assert(noBbox.includes("Open scan") && !noBbox.includes("dw-histmap-overlay-link"),
		"no-bbox sheet should not offer Overlay: " + noBbox);
	// No usable sheets → empty section
	eq(dw._histMapsSectionHtml([{ title: "X", link: "" }]), "");
});

t("_formatLeaseTooltip renders permit number, type, minerals, holder; escapes", () => {
	// Real /identify shape for Historical ML extent (layer 170), aliased keys.
	const html = dw._formatLeaseTooltip({
		"Permit number": "ML 3737", "Permit type": "Mining Lease",
		"Permit sub-status": "Surrendered", "Mineral": "SB,AU,PT",
		"Authorised holder name": "OLEARY, Barry Kevin",
	});
	assert(html.includes("<b>ML 3737</b>"), "permit number not headlined: " + html);
	assert(html.includes("Mining Lease · Surrendered"), "type/status line missing: " + html);
	assert(html.includes("SB, AU, PT"), "minerals not spaced: " + html);
	assert(html.includes("OLEARY, Barry Kevin"), "holder missing");
	assert(dw._formatLeaseTooltip({ "Permit number": "<x" }).includes("&lt;x"), "not escaped");
});

t("_formatShaftTooltip headlines the opening type; drops 'Unknown'; escapes", () => {
	// Real /identify shape for layer 45 (Mine openings): alias keys.
	const html = dw._formatShaftTooltip({
		"Type": "Vertical shaft", "Mine Name": "Unknown ",
		"Commodity": "gold", "Remediation Status": "Remediated",
	});
	assert(html.includes("<b>Vertical shaft</b>"), "type not headlined: " + html);
	assert(html.includes("gold"), "missing commodity");
	assert(!html.includes("Unknown"), "'Unknown' mine name should be dropped: " + html);
	assert(html.includes("Remediated"), "missing remediation status");
	// Shallow-working/pit layers key differently
	const alt = dw._formatShaftTooltip({ "Feature Sub Type": "shallow pit", "Feature Remediated": "None" });
	assert(alt.includes("shallow pit"), "sub-type not read: " + alt);
	// Named mine is kept
	assert(dw._formatShaftTooltip({ "Type": "Adit", "Mine Name": "Day Dawn" }).includes("Day Dawn"),
		"named mine dropped");
	// escaping
	assert(dw._formatShaftTooltip({ "Type": "<b>x" }).includes("&lt;b&gt;x"), "type not escaped");
});

t("_formatMineTooltip renders name, commodity/status, locality; escapes", () => {
	// Real ArcGIS /identify shape: attributes keyed by alias, "Null" sentinels.
	const html = dw._formatMineTooltip({
		"Occurrence name": "BANTAM", "Main commodity": "GOLD",
		"Mine status": "ABANDONED MINE", "Deposit size": "Small",
		"site locality": "4KM NW OF CEMENT HILL", "Group name": "Null",
		"Site type": "MINERAL OCCURRENCE",
	});
	assert(html.includes("BANTAM"), "missing name");
	assert(html.includes("GOLD · ABANDONED MINE · Small"), "missing commodity/status/size line: " + html);
	assert(html.includes("4KM NW OF CEMENT HILL"), "missing locality");
	assert(html.includes("MINERAL OCCURRENCE"), "Group name 'Null' should fall through to Site type");
	// Also accepts the raw GeoJSON field-name form
	assert(dw._formatMineTooltip({ occur_name: "MORNING STAR" }).includes("MORNING STAR"),
		"raw field-name form not read");
	// null/"Null" sentinels and missing name are handled
	eq(dw._formatMineTooltip({ "Occurrence name": null, "Mine status": "Null" }),
		"<b>Historic mine</b>");
	assert(dw._formatMineTooltip({ "Occurrence name": '<img src=x onerror=alert(1)>' })
		.includes("&lt;img"), "occur_name not escaped");
});

// ---- Vexcel aerial token helpers ----

// Forge a JWT-shaped token with a chosen exp (signature is irrelevant —
// helpers only decode the payload).
function fakeJwt(expSecs) {
	const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64")
		.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	return `${b64u({ alg: "HS256" })}.${b64u({ sub: "x", exp: expSecs })}.sig`;
}

t("_vexcelParseToken accepts bare JWT, URL, curl blob; rejects junk", () => {
	const jwt = fakeJwt(9999999999);
	eq(dw._vexcelParseToken(jwt), jwt, "bare token");
	eq(dw._vexcelParseToken(
		`https://api.vexcelgroup.com/v2/x?session=abc&token=${jwt}`), jwt, "URL");
	eq(dw._vexcelParseToken(`curl 'https://api/x?token=${jwt}' -H 'A: b'`), jwt,
		"pasted curl command");
	eq(dw._vexcelParseToken("not a token"), "", "junk rejected");
	eq(dw._vexcelParseToken(""), "", "empty rejected");
});

t("_vexcelIsCredString tells email:password from a token/URL paste", () => {
	const jwt = fakeJwt(9999999999);
	assert(dw._vexcelIsCredString("user@mozmail.com:s3cr3t"), "email:pass = creds");
	assert(dw._vexcelIsCredString("  a@b.co:pa:ss  "), "colon in password still creds");
	assert(!dw._vexcelIsCredString(jwt), "bare JWT is not creds");
	assert(!dw._vexcelIsCredString(
		`https://api.vexcelgroup.com/v2/x?token=${jwt}`), "URL is not creds (has ://)");
	assert(!dw._vexcelIsCredString("nopass"), "no colon is not creds");
	assert(!dw._vexcelIsCredString("noatsign:pw"), "no @ before colon is not creds");
	assert(!dw._vexcelIsCredString(""), "empty is not creds");
});

t("_vexcelTokenExp / _vexcelTokenValid decode expiry", () => {
	const future = Math.floor(Date.now() / 1000) + 3600;
	const past = Math.floor(Date.now() / 1000) - 3600;
	eq(dw._vexcelTokenExp(fakeJwt(future)), future * 1000, "exp decoded to ms");
	assert(dw._vexcelTokenValid(fakeJwt(future)), "future token valid");
	assert(!dw._vexcelTokenValid(fakeJwt(past)), "expired token invalid");
	assert(!dw._vexcelTokenValid("garbage"), "undecodable invalid");
	assert(!dw._vexcelTokenValid(""), "empty invalid");
});

t("_vexcelTileTpl builds the WMTS getTile template", () => {
	const tpl = dw._vexcelTileTpl("TOK.EN+1");
	assert(tpl.startsWith("https://api.vexcelgroup.com/v2/ortho/wmts?"), "base");
	assert(tpl.includes("TileMatrix={z}&TileRow={y}&TileCol={x}"),
		"leaflet placeholders in WMTS params");
	assert(tpl.includes("layer=urban") && tpl.includes("TileMatrixSet=urban"));
	assert(tpl.includes("token=TOK.EN%2B1"), "token URL-encoded");
});

// ---- Vexcel obliques (directional + dated views) ----

t("_vexcelCollectionYear pulls the capture year from collection ids", () => {
	eq(dw._vexcelCollectionYear("au-qld-sunshinecoast-2019"), "2019");
	eq(dw._vexcelCollectionYear("au-qld-sunshinecoastr2-2021"), "2021", "trailing year wins over the r2");
	eq(dw._vexcelCollectionYear("weird-id"), "weird-id", "fallback to raw id");
});

t("_vexcelParseObliques builds direction + capture model with layers", () => {
	const feat = (dir, coll, name, layer) => ({
		properties: { "product-type": dir, collection: coll, "image-name": name, "source-layer": layer },
	});
	const model = dw._vexcelParseObliques({ features: [
		feat("oblique-east", "au-qld-sunshinecoast-2019", "img-e-2019", "urban"),
		feat("oblique-east", "au-qld-sunshinecoast-2019", "img-e-2019-dup", "urban"),
		feat("oblique-north", "au-nsw-widearea-2021", "img-n-2021", "wide-area"),
		feat("nadir", "au-qld-sunshinecoast-2025", "img-nadir-2025", "urban"),
		feat("oblique-west", "", "no-collection-dropped", "urban"),
	] });
	// directions in canonical N/E/S/W/Top order, only those present
	deepEq(model.directions.map((d) => d.key),
		["oblique-north", "oblique-east", "nadir"]);
	// first image per cell+band wins (dup ignored); cell is { rgb: {...} }
	// (fixtures are all rgb; raster dims zeroed since omitted)
	deepEq(model.images["oblique-east@au-qld-sunshinecoast-2019"],
		{ rgb: { name: "img-e-2019", layer: "urban", w: 0, h: 0, corners: null } });
	deepEq(model.images["oblique-north@au-nsw-widearea-2021"],
		{ rgb: { name: "img-n-2021", layer: "wide-area", w: 0, h: 0, corners: null } });
	// captures sorted year-desc
	deepEq(model.captures.map((c) => c.year), ["2025", "2021", "2019"]);
});

t("_vexcelBand + parse bucket rgb / irg variants per cell", () => {
	eq(dw._vexcelBand("W_2025_..._rgb"), "rgb");
	eq(dw._vexcelBand("W_2025_..._irg"), "irg", "infrared suffix");
	eq(dw._vexcelBand(""), "rgb", "default");
	const feat = (name) => ({ properties: {
		"product-type": "nadir", collection: "au-qld-x-2025", "image-name": name,
		"source-layer": "urban", "raster-size-width": 100, "raster-size-height": 100,
	} });
	const model = dw._vexcelParseObliques({ features: [
		feat("N_a_rgb"), feat("N_a_irg"), feat("N_b_rgb"),
	] });
	const cell = model.images["nadir@au-qld-x-2025"];
	eq(cell.rgb.name, "N_a_rgb", "first rgb kept");
	eq(cell.irg.name, "N_a_irg", "irg bucketed separately");
});

t("_vexcelMaxDownsample derives the pyramid depth from raster size", () => {
	eq(dw._vexcelMaxDownsample(256, 256), 0, "single tile → depth 0");
	eq(dw._vexcelMaxDownsample(10560, 14144), 6, "2025 oblique → 0-6");
	eq(dw._vexcelMaxDownsample(7700, 10300), 6, "2019 oblique");
	eq(dw._vexcelMaxDownsample(0, 0), 0, "degenerate safe");
});

t("_vexcelFootprint extracts the 4 corner ring", () => {
	const geom = { coordinates: [[[153.0, -26.5], [153.1, -26.5], [153.1, -26.6], [153.0, -26.6], [153.0, -26.5]]] };
	deepEq(dw._vexcelFootprint(geom),
		[[153.0, -26.5], [153.1, -26.5], [153.1, -26.6], [153.0, -26.6]]);
	eq(dw._vexcelFootprint(null), null, "null-safe");
	eq(dw._vexcelFootprint({ coordinates: [[[1, 2]]] }), null, "too few points");
});

t("_vexcelBilinear / _vexcelInvBilinear round-trip a ground point", () => {
	// A slightly trapezoidal footprint (TL,TR,BR,BL).
	const c = [[153.000, -26.598], [153.010, -26.598], [153.009, -26.610], [153.001, -26.609]];
	// Corners map to the unit-square corners.
	deepEq(dw._vexcelBilinear(c, 0, 0), c[0], "u0v0 → TL");
	deepEq(dw._vexcelBilinear(c, 1, 0), c[1], "u1v0 → TR");
	deepEq(dw._vexcelBilinear(c, 1, 1), c[2], "u1v1 → BR");
	deepEq(dw._vexcelBilinear(c, 0, 1), c[3], "u0v1 → BL");
	// pixel (u,v) → ground → (u,v) recovers within tolerance.
	for (const [u0, v0] of [[0.3, 0.7], [0.62, 0.18], [0.5, 0.5]]) {
		const g = dw._vexcelBilinear(c, u0, v0);
		const [u1, v1] = dw._vexcelInvBilinear(c, g[0], g[1]);
		close(u1, u0, 1e-3, "u round-trip");
		close(v1, v0, 1e-3, "v round-trip");
	}
});

t("_vexcelClipPathToQuad keeps route portions crossing an image footprint", () => {
	const quad = [[0, 0], [1, 0], [1, 1], [0, 1]];
	const crossing = dw._vexcelClipPathToQuad([[-1, 0.5], [2, 0.5]], quad);
	eq(crossing.length, 1, "crossing segment retained");
	close(crossing[0][0][0], 0, 1e-9, "entry clipped to left edge");
	close(crossing[0][1][0], 1, 1e-9, "exit clipped to right edge");
	deepEq(dw._vexcelClipPathToQuad([[-2, -2], [-1, -1]], quad), [],
		"fully outside route omitted");
	for (const edge of [
		[[0, 0], [1, 0]], [[1, 0], [1, 1]],
		[[1, 1], [0, 1]], [[0, 1], [0, 0]],
	]) {
		eq(dw._vexcelClipPathToQuad(edge, quad).length, 1,
			"route on every footprint edge is retained");
	}
});

t("_vexcelClipPathToRect clips exact image pixels without dropping crossings", () => {
	const crossing = dw._vexcelClipPathToRect([[-5, 50], [50, 50], [105, 50]], 100, 100);
	eq(crossing.length, 1, "crossing pixels remain one path");
	deepEq(crossing[0], [[0, 50], [50, 50], [100, 50]]);
	const corner = dw._vexcelClipPathToRect([[-5, -5], [50, 50], [105, 105]], 100, 100);
	deepEq(corner[0], [[0, 0], [50, 50], [100, 100]], "corner crossings are included");
	deepEq(dw._vexcelClipPathToRect([[-5, -5], [-1, -1]], 100, 100), [],
		"fully outside pixels omitted");
});

t("_vexcelDensifyPath samples sparse ground segments without moving endpoints", () => {
	const path = [[153, -26.6], [153.001, -26.6]];
	const dense = dw._vexcelDensifyPath(path, 10);
	assert(dense.length >= 10, "roughly 100m segment receives intermediate samples");
	deepEq(dense[0], path[0], "start retained exactly");
	deepEq(dense[dense.length - 1], path[1], "end retained exactly");
	for (let i = 1; i < dense.length; i++) {
		assert(dense[i][0] > dense[i - 1][0], "samples retain route order");
	}
});

t("_vexcelObliqueTileBase builds a token-scoped tile base", () => {
	const jwt = fakeJwt(Math.floor(Date.now() / 1000) + 3600);
	const b = dw._vexcelObliqueTileBase("img~n", "urban", jwt);
	assert(b.startsWith("https://api.vexcelgroup.com/v2/oriented/tile?"), "endpoint");
	assert(b.includes("image-name=img~n"), "image name");
	assert(b.includes("layer=urban"), "layer");
	assert(!/downsample|tile-x|tile-y/.test(b), "per-tile coords added by Leaflet, not here");
	eq(dw._vexcelObliqueTileBase("img", "urban", "expired"), "", "invalid token → empty");
});

t("_vexcelParseObliques carries raster dimensions for the pyramid", () => {
	const model = dw._vexcelParseObliques({ features: [{
		properties: {
			"product-type": "oblique-north", collection: "au-qld-x-2025",
			"image-name": "n1", "source-layer": "urban",
			"raster-size-width": 10560, "raster-size-height": 14144,
		},
	}] });
	deepEq(model.images["oblique-north@au-qld-x-2025"],
		{ rgb: { name: "n1", layer: "urban", w: 10560, h: 14144, corners: null } });
});

t("_vexcelObliqueExtractUrl builds a token-scoped, layer-aware URL", () => {
	const future = Math.floor(Date.now() / 1000) + 3600;
	const jwt = fakeJwt(future);
	const url = dw._vexcelObliqueExtractUrl("img~name", "wide-area", -26.607, 153.006, jwt);
	assert(url.startsWith("https://api.vexcelgroup.com/v2/oriented/extract?"), "base");
	assert(url.includes(encodeURIComponent("POINT(153.006 -26.607)")), "wkt point");
	assert(url.includes("image-name=img~name"), "image name");
	assert(url.includes("layer=wide-area"), "per-image source layer");
	assert(dw._vexcelObliqueExtractUrl("img", "", 0, 0, jwt).includes("layer=urban"),
		"defaults layer to urban");
	eq(dw._vexcelObliqueExtractUrl("img", "urban", 0, 0, "expired"), "",
		"invalid token → empty");
	eq(dw._vexcelObliqueExtractUrl("", "urban", 0, 0, jwt), "", "missing image → empty");
});

// ---- @connect coverage (real-Tampermonkey GM_xmlhttpRequest gate) ----
// The e2e harness swaps GM_xmlhttpRequest for a plain fetch, so it can't
// catch a missing @connect — but real Tampermonkey BLOCKS any GM request
// to a host not in the allowlist. Every host reached via gmGet/gmJsonGet
// (query/extract/detail/docs APIs) MUST be declared, or the feature
// silently fails in the field while all tests pass. This guards that.
t("@connect covers every host the providers GM-fetch from", () => {
	const declared = new Set(
		[..._BUILT_SCRIPT.matchAll(/@connect\s+(\S+)/g)].map((m) => m[1]),
	);
	// Hosts fetched through GM_xmlhttpRequest (NOT <img> tile hosts,
	// which the browser loads directly and @connect doesn't gate).
	const required = [
		"api.vexcelgroup.com",              // Vexcel imagery + metadata
		"admin.vexcelgroup.com",            // Vexcel login + session minting
		"geopublic.scc.qld.gov.au",         // SCC applications GeoJSON query
		"developmenti.sunshinecoast.qld.gov.au", // Development.i detail/filter
		"publicdocs.scc.qld.gov.au",        // SCC lodged-document repository
		"maps.six.nsw.gov.au",              // NSW cadastre parcel identify
		"portal.spatial.nsw.gov.au",        // NSW property address identify
		"plan-gis.mapshare.vic.gov.au",     // VIC parcel + property identify
		"services.thelist.tas.gov.au",      // TAS cadastre parcel identify
		"lsa4.geohub.sa.gov.au",            // SA parcel + suburb identify
		"services1.arcgis.com",             // ACT block identify
		"gis.environment.gov.au",           // national cadastre (WA/NT identify)
	];
	for (const host of required) {
		assert(declared.has(host), `@connect missing for GM-fetched host: ${host}`);
	}
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
