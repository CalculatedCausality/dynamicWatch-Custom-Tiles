// Deep shape validation for every live endpoint the userscript consumes.
//
// Goes well beyond `smoke.sh`: each test fetches the actual response,
// then asserts that the structure matches what the userscript reads. If
// an upstream silently renames a field or changes a type, this catches
// it where the smoke probe would still pass.
//
// PBF layers (INTVL, OpenInfraMap power/telecoms/water) are decoded
// using the userscript's own `mvtDecode` (loaded via the sandbox) so
// the test exercises the same code path the script uses at runtime.
//
// Image tests sniff magic bytes — catches the case where an error page
// is served with image/png Content-Type.

import { loadHelpers } from "./_loader.mjs";

const dw = loadHelpers();

// -- Test runner -------------------------------------------------------

const C_RED = "\x1b[31m", C_GREEN = "\x1b[32m", C_DIM = "\x1b[2m", C_OFF = "\x1b[0m";
const CI = process.argv.includes("--ci") || process.argv.includes("-c");
const c = (col, s) => CI ? s : col + s + C_OFF;

let pass = 0, fail = 0, skip = 0;
const results = [];

async function test(name, fn) {
	try {
		await fn();
		pass++; results.push([true, name, null]);
	} catch (e) {
		fail++; results.push([false, name, e.message]);
	}
}

async function skipTest(name, reason) {
	skip++; results.push([null, name, reason]);
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEq(a, b, msg) {
	if (a !== b) throw new Error(`${msg || "eq"}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}
function assertType(v, type, msg) {
	const actual = Array.isArray(v) ? "array" : (v === null ? "null" : typeof v);
	if (actual !== type) throw new Error(`${msg || "type"}: expected ${type}, got ${actual}`);
}
function assertHasKeys(obj, keys, msg) {
	if (obj == null || typeof obj !== "object") {
		throw new Error(`${msg || "hasKeys"}: not an object`);
	}
	const missing = keys.filter((k) => !(k in obj));
	if (missing.length) {
		throw new Error(`${msg || "hasKeys"}: missing ${missing.join(", ")}`);
	}
}

async function fetchBuffer(url, opts = {}) {
	const r = await fetch(url, opts);
	const buf = await r.arrayBuffer();
	return { status: r.status, contentType: r.headers.get("content-type") || "", body: new Uint8Array(buf) };
}
async function fetchJson(url, opts = {}) {
	const r = await fetch(url, opts);
	const text = await r.text();
	let data = null;
	try { data = JSON.parse(text); } catch (e) {
		throw new Error(`bad JSON: ${e.message} (first 100 chars: ${text.slice(0, 100)})`);
	}
	return { status: r.status, contentType: r.headers.get("content-type") || "", data };
}

// Image magic-byte sniff.
function sniffImage(bytes) {
	if (bytes.length < 4) return "unknown";
	const [a, b, c2, d] = bytes;
	if (a === 0x89 && b === 0x50 && c2 === 0x4E && d === 0x47) return "png";
	if (a === 0xFF && b === 0xD8 && c2 === 0xFF) return "jpeg";
	if (a === 0x47 && b === 0x49 && c2 === 0x46) return "gif";
	if (a === 0x42 && b === 0x4D) return "bmp";
	// WebP starts with "RIFF...WEBP"
	if (a === 0x52 && b === 0x49 && c2 === 0x46 && d === 0x46) return "webp?";
	return "unknown";
}

// -- Common constants -------------------------------------------------

const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN || "";

// Brisbane CBD tile coords (matches smoke.sh)
const TILE = {
	z08: { x: 236,  y: 148  },
	z10: { x: 947,  y: 593  },
	z12: { x: 3789, y: 2373 },
};
const CENTER = { lon: 153.0251, lat: -27.4698 };

// -- Tests -------------------------------------------------------------

// ----- Raster basemaps -----

await test("Google Hybrid → JPEG image", async () => {
	const r = await fetchBuffer(`https://mt0.google.com/vt/lyrs=y&x=${TILE.z10.x}&y=${TILE.z10.y}&z=10`);
	assertEq(r.status, 200, "HTTP");
	const kind = sniffImage(r.body);
	assert(kind === "jpeg" || kind === "png", `magic bytes (${kind})`);
	assert(r.body.length > 1000, `size (${r.body.length}B)`);
});

await test("OpenSeaMap → PNG (transparent overlay)", async () => {
	const r = await fetchBuffer(`https://tiles.openseamap.org/seamark/10/${TILE.z10.x}/${TILE.z10.y}.png`);
	assertEq(r.status, 200);
	assertEq(sniffImage(r.body), "png");
});

await test("Strava heatmap → HiDPI PNG (@2x suffix)", async () => {
	const r = await fetchBuffer(`https://content-a.strava.com/anon/globalheat/all/blue/10/${TILE.z10.x}/${TILE.z10.y}@2x.png?v=19`);
	assertEq(r.status, 200);
	assertEq(sniffImage(r.body), "png");
	// PNG IHDR width/height are at bytes 16-23 (big-endian uint32). Strava's
	// @2x currently ships 1024×1024 (4× the logical tile size) — Leaflet
	// downscales to fit the 256px display tile. Anything wider than 256
	// confirms we got the higher-res raster, not the basic 256px tile.
	const w = (r.body[16] << 24) | (r.body[17] << 16) | (r.body[18] << 8) | r.body[19];
	const h = (r.body[20] << 24) | (r.body[21] << 16) | (r.body[22] << 8) | r.body[23];
	assert(w === h && w >= 512,
		`dimensions: ${w}×${h} (want square ≥512 for HiDPI @2x suffix)`);
});

await test("Strava heatmap → NO CORS for arbitrary origin (why we bridge it)", async () => {
	// Strava's CDN sends `Vary: Origin` and only returns
	// Access-Control-Allow-Origin for allowlisted origins — NOT
	// dynamic.watch. That's why the 2D layer uses crossOrigin:false and
	// the 3D layer routes through the GM blob bridge (GM_xmlhttpRequest is
	// CORS-exempt). If this assertion ever FAILS (ACAO present), Strava
	// re-opened CORS and we could drop the bridge + restore a plain raster.
	const r = await fetch(
		`https://content-a.strava.com/anon/globalheat/all/blue/10/${TILE.z10.x}/${TILE.z10.y}@2x.png?v=19`,
		{ headers: { Origin: "https://dynamic.watch" } });
	assertEq(r.status, 200);
	const acao = r.headers.get("access-control-allow-origin");
	assert(!acao || acao === "null",
		`expected NO Access-Control-Allow-Origin for dynamic.watch origin, got "${acao}" ` +
		`— Strava may have re-opened CORS; the GM bridge could be dropped`);
});

for (const activity of ["RUNNING", "HIKING", "TRAIL_RUNNING", "ROAD_CYCLING", "MOUNTAIN_BIKING"]) {
	await test(`Garmin ${activity} → PNG`, async () => {
		const r = await fetchBuffer(`https://connecttile.garmin.com/${activity}/10/${TILE.z10.x}/${TILE.z10.y}.png`);
		assertEq(r.status, 200);
		assertEq(sniffImage(r.body), "png");
	});
}

await test("QLD Topo → PNG basemap tile", async () => {
	const r = await fetchBuffer(`https://spatial-gis.information.qld.gov.au/arcgis/rest/services/Basemaps/QldMap_Topo/MapServer/tile/10/${TILE.z10.y}/${TILE.z10.x}`);
	assertEq(r.status, 200);
	assertEq(sniffImage(r.body), "png");
});

await test("QLD Relief → PNG overlay tile", async () => {
	const r = await fetchBuffer(`https://spatial-gis.information.qld.gov.au/arcgis/rest/services/Basemaps/QldMap_Relief/MapServer/tile/10/${TILE.z10.y}/${TILE.z10.x}`);
	assertEq(r.status, 200);
	assertEq(sniffImage(r.body), "png");
});

await test("QLD Labels → PNG (transparent labels)", async () => {
	const r = await fetchBuffer(`https://spatial-gis.information.qld.gov.au/arcgis/rest/services/Basemaps/QldImageryLabel/MapServer/tile/12/${TILE.z12.y}/${TILE.z12.x}`);
	assertEq(r.status, 200);
	assertEq(sniffImage(r.body), "png");
});

await test("Stamen Terrain (Stadia) → PNG with localhost spoof", async () => {
	const r = await fetchBuffer(
		`https://tiles.stadiamaps.com/tiles/stamen_terrain/10/${TILE.z10.x}/${TILE.z10.y}.png`,
		{ headers: { Origin: "http://localhost", Referer: "http://localhost/" } });
	assertEq(r.status, 200);
	assertEq(sniffImage(r.body), "png");
});

if (MAPBOX_TOKEN) await test("Mapbox Terrain-DEM v1 TileJSON resolves (3D Mode terrain source)", async () => {
	// Mapbox's current DEM (replaces the legacy `mapbox.terrain-rgb`).
	// Mapbox GL JS fetches the TileJSON to discover the tile URL +
	// access constraints; that's also the first network round-trip
	// when `setTerrain({source: "mapbox-dem"})` runs. Keep the token
	// out of git; run with MAPBOX_TOKEN=pk... to probe this endpoint.
	const r = await fetch(
		`https://api.mapbox.com/v4/mapbox.mapbox-terrain-dem-v1.json?access_token=${MAPBOX_TOKEN}`,
		{ headers: { Origin: "https://dynamic.watch", Referer: "https://dynamic.watch/" } });
	assertEq(r.status, 200, "TileJSON HTTP — token may lack terrain-dem-v1 scope; fall back to Terrarium");
	const tj = await r.json();
	assert(Array.isArray(tj.tiles) && tj.tiles.length > 0, "TileJSON missing `tiles`");
	assert(/terrain-dem/.test(tj.tiles[0]),
		"TileJSON `tiles[0]` doesn't reference terrain-dem (got " + tj.tiles[0] + ")");
});
else await skipTest("Mapbox Terrain-DEM v1 TileJSON resolves (3D Mode terrain source)",
	"set MAPBOX_TOKEN to probe terrain TileJSON");

if (MAPBOX_TOKEN) await test("Mapbox Terrain-DEM v1 tile → valid raster (3D Mode terrain source)", async () => {
	// Now fetch a real tile at z10 over Brisbane and confirm it's
	// either a PNG or WebP raster with a sensible body length.
	const r = await fetchBuffer(
		`https://api.mapbox.com/v4/mapbox.mapbox-terrain-dem-v1/10/${TILE.z10.x}/${TILE.z10.y}.webp?access_token=${MAPBOX_TOKEN}`,
		{ headers: { Origin: "https://dynamic.watch", Referer: "https://dynamic.watch/" } });
	assertEq(r.status, 200, "tile HTTP — token-scope or tileset issue");
	assert(r.body.length > 500, `tile body suspiciously small (${r.body.length}B)`);
	// WebP signature: bytes 0–3 = "RIFF", 8–11 = "WEBP"; PNG signature
	// = 0x89,0x50,0x4E,0x47 at the start.
	const isPng = r.body[0] === 0x89 && r.body[1] === 0x50 &&
	              r.body[2] === 0x4e && r.body[3] === 0x47;
	const isWebp = r.body[0] === 0x52 && r.body[1] === 0x49 &&
	               r.body[2] === 0x46 && r.body[3] === 0x46 &&
	               r.body[8] === 0x57 && r.body[9] === 0x45 &&
	               r.body[10] === 0x42 && r.body[11] === 0x50;
	assert(isPng || isWebp, "expected PNG or WebP raster signature");
});
else await skipTest("Mapbox Terrain-DEM v1 tile → valid raster (3D Mode terrain source)",
	"set MAPBOX_TOKEN to probe terrain tile");

await test("Mapbox GL JS CDN (v3.7.0) reachable + non-trivial", async () => {
	const r = await fetch("https://api.mapbox.com/mapbox-gl-js/v3.7.0/mapbox-gl.js");
	assertEq(r.status, 200, "CDN HTTP");
	const text = await r.text();
	// v3 ships a UMD bundle with `mapboxgl` exposed as a global. The
	// userscript depends on that global existing after script load.
	assert(text.includes("mapboxgl"), "script body missing 'mapboxgl' reference");
	assert(text.length > 100000,     `body suspiciously small (${text.length}B)`);
});

// ----- Vector tiles (PBF, decoded with userscript's own mvtDecode) -----

await test("INTVL global PBF decodes to 'territories' layer with polygon features", async () => {
	const r = await fetchBuffer(`https://d1yalngj9nsyl4.cloudfront.net/single-player/run/8/${TILE.z08.x}/${TILE.z08.y}.pbf`);
	assertEq(r.status, 200);
	const layers = dw.mvtDecode(r.body.buffer);
	const t = layers.find((l) => l.name === "territories");
	assert(t, "no 'territories' layer in PBF");
	assert(t.extent === 4096, `extent: ${t.extent} (want 4096)`);
	assert(t.features.length > 0, `no features (got ${t.features.length})`);
	// Every territory should be a POLYGON (MVT type 3).
	const poly = t.features.find((f) => f.type === 3);
	assert(poly, "no polygon features");
	// Properties the script reads: colour, currentArea, startTime, runId, activityId
	const props = {};
	for (let i = 0; i < poly.tags.length; i += 2) {
		props[t.keys[poly.tags[i]]] = t.values[poly.tags[i + 1]];
	}
	assert("colour" in props,       "feature missing `colour` prop");
	assert("currentArea" in props,  "feature missing `currentArea` prop");
	assert("startTime" in props,    "feature missing `startTime` prop");
	assert("runId" in props || "activityId" in props,
		"feature missing both `runId` and `activityId`");
});

await test("OpenInfraMap power PBF contains 'power_line' or 'power_substation'", async () => {
	const r = await fetchBuffer(`https://openinframap.org/map/power/10/${TILE.z10.x}/${TILE.z10.y}.pbf`);
	assertEq(r.status, 200);
	const layers = dw.mvtDecode(r.body.buffer);
	const names = layers.map((l) => l.name);
	const expected = ["power_line", "power_substation", "power_substation_point",
		"power_plant", "power_plant_point", "power_generator_area",
		"power_generator", "power_tower"];
	const present = expected.filter((n) => names.includes(n));
	assert(present.length > 0, `no expected power layers found; saw [${names.join(", ")}]`);
});

await test("OpenInfraMap telecoms PBF contains telecom layers", async () => {
	const r = await fetchBuffer(`https://openinframap.org/map/telecoms/10/${TILE.z10.x}/${TILE.z10.y}.pbf`);
	assertEq(r.status, 200);
	const layers = dw.mvtDecode(r.body.buffer);
	const names = layers.map((l) => l.name);
	const expected = ["telecoms_data_center", "telecoms_data_center_point",
		"telecoms_mast", "telecoms_antenna"];
	const present = expected.filter((n) => names.includes(n));
	assert(present.length > 0, `no expected telecom layers found; saw [${names.join(", ")}]`);
});

await test("OpenInfraMap water PBF contains water_pipeline + facility layers", async () => {
	const r = await fetchBuffer(`https://openinframap.org/map/water/10/${TILE.z10.x}/${TILE.z10.y}.pbf`);
	assertEq(r.status, 200);
	const layers = dw.mvtDecode(r.body.buffer);
	const names = layers.map((l) => l.name);
	const expected = [
		"water_pipeline", "water_treatment_plant_polygon", "water_treatment_plant_point",
		"wastewater_plant_polygon", "wastewater_plant_point",
		"water_reservoir", "water_reservoir_point",
		"pumping_station_polygon", "pumping_station_point",
		"water_tower", "water_well",
	];
	const present = expected.filter((n) => names.includes(n));
	assert(present.length > 0, `no expected water layers found; saw [${names.join(", ")}]`);
});

// ----- ArcGIS exports (image, sniff magic bytes) -----

await test("ACCC Mobile Coverage → PNG (Sublayer 2 = 4G outdoor)", async () => {
	const r = await fetchBuffer("https://spatial.infrastructure.gov.au/server/rest/services/ACCC_Mobile_Sites_and_Coverages/MapServer/export?bbox=153.00,-27.50,153.05,-27.45&bboxSR=4326&imageSR=4326&layers=show:2&size=256,256&format=png32&transparent=true&f=image");
	assertEq(r.status, 200);
	assertEq(sniffImage(r.body), "png");
});

await test("QLD QPWS Estate → PNG (estate + trail sublayers)", async () => {
	const r = await fetchBuffer("https://spatial-gis.information.qld.gov.au/arcgis/rest/services/Environment/ParksTerrestrialProtectedAreas/MapServer/export?bbox=153.00,-27.50,153.05,-27.45&bboxSR=4326&imageSR=4326&layers=show:10,5,6,7,8,9&size=256,256&format=png32&transparent=true&f=image");
	assertEq(r.status, 200);
	assertEq(sniffImage(r.body), "png");
});

await test("QLD Cadastre → PNG", async () => {
	const r = await fetchBuffer("https://spatial-gis.information.qld.gov.au/arcgis/rest/services/PlanningCadastre/LandParcelPropertyFramework/MapServer/export?bbox=153.00,-27.50,153.05,-27.45&bboxSR=4326&imageSR=4326&layers=show:1&size=256,256&format=png32&transparent=true&f=image");
	assertEq(r.status, 200);
	assertEq(sniffImage(r.body), "png");
});

await test("Light Pollution WMS → PNG (grid-aligned bbox)", async () => {
	const r = await fetchBuffer("https://www2.lightpollutionmap.info/geoserver/gwc/service/wms?REQUEST=GetMap&SERVICE=WMS&VERSION=1.3.0&FORMAT=image%2Fpng&STYLES=WA&TRANSPARENT=TRUE&LAYERS=PostGIS%3ASB_2025&TILED=true&SRS=EPSG%3A3857&CRS=EPSG%3A3857&WIDTH=256&HEIGHT=256&BBOX=17024054.939683594,-3209132.195526562,17063190.698165625,-3169996.437044531");
	assertEq(r.status, 200);
	assertEq(sniffImage(r.body), "png");
});

// ----- JSON APIs (structural validation) -----

await test("OpenSky flights → {states} array-or-null, each state len≥17", async () => {
	// Query a continent-sized bbox so we reliably get non-empty results.
	// (Brisbane-only bboxes return states: null at quiet moments — script
	// handles that via `data.states || []`.)
	const r = await fetchJson("https://opensky-network.org/api/states/all?lamin=-40&lomin=110&lamax=-10&lomax=160");
	assertEq(r.status, 200);
	assertHasKeys(r.data, ["time", "states"]);
	// `states` is array OR null (null = no aircraft in bbox).
	if (r.data.states !== null) {
		assertType(r.data.states, "array", "states");
	}
	if (r.data.states && r.data.states.length) {
		const s = r.data.states[0];
		assertType(s, "array", "state[0]");
		assert(s.length >= 17,
			`state[0] only has ${s.length} fields; script reads up to index 10`);
		// Script reads s[1] callsign, s[2] origin_country, s[5] longitude, s[6] latitude
		assertType(s[5], "number", "longitude");
		assertType(s[6], "number", "latitude");
	}
});

await test("QPWS national-park query → GeoJSON FC, features have estatename + esttype", async () => {
	const r = await fetchJson("https://spatial-gis.information.qld.gov.au/arcgis/rest/services/Environment/ParksTerrestrialProtectedAreas/MapServer/10/query?f=geojson&where=esttype+IN+(%27NP%27%2C%27NS%27%2C%27NY%27%2C%27NA%27)&outFields=estatename%2Cesttype&geometry=152.9%2C-27.6%2C153.1%2C-27.4&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326&resultRecordCount=5");
	assertEq(r.status, 200);
	assertEq(r.data.type, "FeatureCollection", "type");
	assertType(r.data.features, "array", "features");
	assert(r.data.features.length > 0, "no parks returned");
	for (const f of r.data.features) {
		assertEq(f.type, "Feature");
		assertHasKeys(f.properties, ["estatename", "esttype"]);
		assert(["NP", "NS", "NY", "NA"].includes(f.properties.esttype),
			`unknown esttype: ${f.properties.esttype}`);
	}
});

await test("Esri Wayback catalog → object of releases each with itemTitle", async () => {
	const r = await fetchJson("https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json");
	assertEq(r.status, 200);
	assertType(r.data, "object", "top-level");
	const keys = Object.keys(r.data);
	assert(keys.length > 100, `only ${keys.length} releases — expected hundreds`);
	const entry = r.data[keys[0]];
	assertHasKeys(entry, ["itemTitle"]);
	assert(/Wayback /.test(entry.itemTitle),
		`unexpected itemTitle format: ${entry.itemTitle}`);
});

await test("QLD Cadastre /identify → results[].attributes object", async () => {
	const url = "https://spatial-gis.information.qld.gov.au/arcgis/rest/services/PlanningCadastre/LandParcelPropertyFramework/MapServer/identify"
		+ "?geometry=" + encodeURIComponent('{"x":153.025,"y":-27.47,"spatialReference":{"wkid":4326}}')
		+ "&geometryType=esriGeometryPoint&sr=4326&layers=all:8&tolerance=3"
		+ "&mapExtent=152.99,-27.5,153.05,-27.45&imageDisplay=512,512,96"
		+ "&returnGeometry=false&f=json";
	const r = await fetchJson(url);
	assertEq(r.status, 200);
	assertHasKeys(r.data, ["results"]);
	assertType(r.data.results, "array");
	if (r.data.results.length > 0) {
		assertHasKeys(r.data.results[0], ["attributes"]);
		assertType(r.data.results[0].attributes, "object");
	}
});

await test("QLD Cadastre attr query → features[].attributes.lotplan", async () => {
	const r = await fetchJson("https://spatial-gis.information.qld.gov.au/arcgis/rest/services/PlanningCadastre/LandParcelPropertyFramework/MapServer/0/query?where=1%3D1&outFields=lotplan&returnGeometry=false&resultRecordCount=1&f=json");
	assertEq(r.status, 200);
	assertHasKeys(r.data, ["features", "fields"]);
	assert(r.data.features.length > 0, "no features");
	assertHasKeys(r.data.features[0], ["attributes"]);
	assert(typeof r.data.features[0].attributes.lotplan === "string",
		"lotplan not a string");
});

await test("QLD AerialOrtho query → features[].attributes capture metadata", async () => {
	const url = "https://spatial-img.information.qld.gov.au/arcgis/rest/services/TimeSeries/AerialOrtho_AllUsers/ImageServer/query"
		+ "?geometry=" + encodeURIComponent('{"x":153.0251,"y":-27.4698,"spatialReference":{"wkid":4326}}')
		+ "&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects"
		+ "&outFields=objectid%2Cname%2Cyear%2Ctitle%2Ccapturestart"
		+ "&returnGeometry=false&orderByFields=capturestart+DESC&f=json"
		+ "&where=category%3D1&resultRecordCount=5";
	const r = await fetchJson(url);
	assertEq(r.status, 200);
	assertHasKeys(r.data, ["features", "fields"]);
	assert(r.data.features.length > 0, "no captures");
	const a = r.data.features[0].attributes;
	assertHasKeys(a, ["objectid", "capturestart"]);
	assertType(a.objectid, "number");
});

await test("OnTheHouse /odin/api/locations → content[].propertyId + address parts", async () => {
	const r = await fetchJson("https://www.onthehouse.com.au/odin/api/locations?query=161+Queen+St+Brisbane+QLD");
	assertEq(r.status, 200);
	assertHasKeys(r.data, ["content"]);
	assertType(r.data.content, "array");
	assert(r.data.content.length > 0, "no locations");
	const loc = r.data.content[0];
	assertHasKeys(loc, ["propertyId", "streetNumber", "streetName", "streetType",
		"suburb", "postCode"]);
});

await test("OnTheHouse /odin/api/properties/{id} → core attrs", async () => {
	const r = await fetchJson("https://www.onthehouse.com.au/odin/api/properties/4071799");
	assertEq(r.status, 200);
	assertHasKeys(r.data, ["address", "type"]);
	assertHasKeys(r.data.address, ["formattedAddress", "streetNumber", "streetName",
		"suburb", "postCode"]);
});

await test("OnTheHouse /odin/api/properties/{id}/events → content[].type", async () => {
	const r = await fetchJson("https://www.onthehouse.com.au/odin/api/properties/4071799/events");
	assertEq(r.status, 200);
	assertHasKeys(r.data, ["content"]);
	assertType(r.data.content, "array");
	// Script filters for type === "SoldEvent". Verify at least one event has a known type.
	const knownTypes = new Set(["SoldEvent", "ForRentEvent", "ListedEvent", "WithdrawnEvent"]);
	const recognised = r.data.content.filter((e) => knownTypes.has(e.type));
	assert(recognised.length > 0,
		`no recognised event types; saw [${r.data.content.map((e) => e.type).join(", ")}]`);
});

// ----- Endpoint liveness (auth-gated, sanity-only) -----

await test("Apple DDG JWT → 3-segment JWT shape", async () => {
	const r = await fetch("https://duckduckgo.com/local.js?get_mk_token=1",
		{ headers: { Referer: "https://duckduckgo.com/" } });
	assertEq(r.status, 200);
	const body = (await r.text()).trim();
	assert(/^[\w-]+\.[\w-]+\.[\w-]+$/.test(body),
		`not a JWT shape: ${body.slice(0, 80)}…`);
});

await test("QLD token endpoint → HTTP 500 + {error} on bare POST", async () => {
	const r = await fetch("https://qldglobe.information.qld.gov.au/api/qldglobe/public/token", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: "{}",
	});
	assertEq(r.status, 500);
	const data = await r.json();
	assertHasKeys(data, ["error"]);
});

await test("Geocaching.com UTFGrid → encodes cache code + name per cell", async () => {
	// Probes the public tile-info endpoint at a cache-dense Brisbane
	// tile and verifies the response is the same UTFGrid shape the
	// userscript depends on: `keys[]` of "(cx, cy)" strings + `data{}`
	// mapping each key to `{i: GC<code>, n: <name>}`. If Groundspeak
	// ever changes the encoding or starts auth-gating this endpoint,
	// the layer breaks silently — this test catches it.
	//
	// WARM FIRST: map.info returns HTTP 204 for "cold" tiles (not
	// recently rendered server-side). A map.png GET triggers generation,
	// after which map.info returns the grid. The userscript does exactly
	// this (warm-on-204); we replicate it here so the test is
	// deterministic regardless of whether the tile happens to be warm.
	await fetch("https://tiles01.geocaching.com/map.png?x=3789&y=2373&z=12", {
		headers: { Referer: "https://www.geocaching.com/play/map" },
	});
	const r = await fetch("https://tiles01.geocaching.com/map.info?x=3789&y=2373&z=12", {
		headers: { Referer: "https://www.geocaching.com/play/map" },
	});
	assertEq(r.status, 200);
	const j = await r.json();
	if (!Array.isArray(j.keys) || j.keys.length < 50) {
		throw new Error(`expected >=50 keys, got ${j.keys && j.keys.length}`);
	}
	if (!Array.isArray(j.grid) || j.grid.length !== 64) {
		throw new Error(`expected grid[64], got ${j.grid && j.grid.length}`);
	}
	const firstNonEmptyKey = j.keys.find((k) => k);
	if (!/^\(\d+,\s*\d+\)$/.test(firstNonEmptyKey)) {
		throw new Error(`key not in (cx, cy) form: ${firstNonEmptyKey}`);
	}
	const raw = j.data[firstNonEmptyKey];
	const entry = Array.isArray(raw) ? raw[0] : raw;
	if (!entry || !entry.i || !entry.n) {
		throw new Error(`data entry missing i/n: ${JSON.stringify(raw)}`);
	}
	if (!/^GC[0-9A-Z]+$/.test(entry.i)) {
		throw new Error(`cache code not GC… form: ${entry.i}`);
	}
});

await test("Geocaching.com map.details → success JSON with D/T/owner/type", async () => {
	// Per-cache enrichment endpoint. The userscript calls this on
	// marker click; if the schema changes (`difficulty`, `terrain`,
	// `owner`, `type`, `available`, `fp`), our enriched tooltip
	// degrades silently — pin the shape here.
	const r = await fetch("https://tiles01.geocaching.com/map.details?i=GC60ZN7", {
		headers: { Referer: "https://www.geocaching.com/play/map" },
	});
	assertEq(r.status, 200);
	const j = await r.json();
	assertEq(j.status, "success");
	const row = j.data && j.data[0];
	if (!row) throw new Error("no data[0] row");
	for (const f of ["gc", "name", "difficulty", "terrain", "container", "type", "owner", "available"]) {
		if (!(f in row)) throw new Error(`missing field: ${f}`);
	}
	if (typeof row.available !== "boolean") {
		throw new Error(`available not bool: ${typeof row.available}`);
	}
});

await test("Geocaching map.png → NO CORS for arbitrary origin (why crossOrigin:false)", async () => {
	// map.png sends no Access-Control-Allow-Origin, so the icon tile
	// layer MUST be a plain <img> (crossOrigin:false) — a CORS-enabled
	// image fails its check and renders nothing in a real browser (the
	// e2e harness masks this with --disable-web-security). If this
	// assertion ever FAILS (ACAO appears), Groundspeak opened CORS and
	// crossOrigin could be re-enabled if pixel reads are ever needed.
	const r = await fetch("https://tiles01.geocaching.com/map.png?x=3789&y=2373&z=12", {
		headers: { Origin: "https://dynamic.watch", Referer: "https://www.geocaching.com/play/map" },
	});
	assertEq(r.status, 200);
	const acao = r.headers.get("access-control-allow-origin");
	assert(!acao || acao === "null",
		`expected NO ACAO on map.png, got "${acao}" — Groundspeak may have opened CORS`);
});

await test("Geocaching.com cold-tile warming → png GET unlocks map.info", async () => {
	// Pins the load-bearing warm-on-204 contract: map.info 204s for a
	// cold tile; a map.png GET warms it; map.info then returns the grid.
	// If Groundspeak ever changes this (e.g. serves map.info directly, or
	// stops honouring the png-warm), the userscript's 3-round-trip cold
	// path becomes wrong and this test tells us to simplify it.
	//
	// We can't guarantee a given tile is COLD (another client may have
	// warmed it), so we only assert the POSITIVE direction: after a png
	// GET, map.info returns 200 with a grid. That holds whether the tile
	// was warm already or we just warmed it — which is exactly the
	// invariant the layer relies on. Use a quiet rural tile to maximise
	// the chance we're actually exercising the warm path.
	const tile = "x=3787&y=2364&z=12"; // Maleny hinterland, QLD
	await fetch(`https://tiles01.geocaching.com/map.png?${tile}`, {
		headers: { Referer: "https://www.geocaching.com/play/map" },
	});
	const r = await fetch(`https://tiles01.geocaching.com/map.info?${tile}`, {
		headers: { Referer: "https://www.geocaching.com/play/map" },
	});
	// 200 (warmed, has caches) is the success case. 204 is acceptable
	// ONLY if the tile genuinely has no caches — but Maleny does, so a
	// 204 here means the png-warm contract broke.
	assertEq(r.status, 200);
	const j = await r.json();
	if (!Array.isArray(j.keys)) {
		throw new Error("warmed tile did not return a UTFGrid");
	}
});

// ----- Auth-gated end-to-end (bootstrap + use the credential) -----
//
// These exercise the same bootstrap flows the userscript runs in the
// browser. They're the most valuable regression catch — if QLD ever
// changes their CSRF handling or Apple rotates the DDG endpoint, this
// is where it'll surface.

// Cookie jar helper: Node 19+ `getSetCookie()` returns an array.
function extractCookies(resp) {
	const cookies = resp.headers.getSetCookie?.() ||
		(resp.headers.get("set-cookie") || "").split(/,(?=\s*[A-Za-z0-9_-]+=)/);
	const jar = {};
	for (const c of cookies) {
		const eq = c.indexOf("=");
		const semi = c.indexOf(";");
		if (eq > -1) {
			const name = c.slice(0, eq).trim();
			const value = c.slice(eq + 1, semi > -1 ? semi : c.length);
			jar[name] = value;
		}
	}
	return jar;
}
function cookieHeader(jar) {
	return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
}

// Shared QLD token bootstrap. Mirrors QldTokenManager._fetch + _doPost.
// Returns { token, jar } so subsequent tile requests can include cookies.
async function bootstrapQldToken(serviceUrl) {
	const ORIGIN = "https://qldglobe.information.qld.gov.au";
	// 1. GET the QLD Globe homepage to seed the XSRF-TOKEN cookie.
	const homeResp = await fetch(ORIGIN + "/", {
		headers: { Accept: "text/html,*/*;q=0.8", Origin: ORIGIN, Referer: ORIGIN + "/" },
	});
	if (homeResp.status >= 400) {
		throw new Error(`QLD home GET HTTP ${homeResp.status}`);
	}
	const jar = extractCookies(homeResp);
	const csrf = jar["XSRF-TOKEN"]
		? decodeURIComponent(jar["XSRF-TOKEN"])
		: null;
	if (!csrf) {
		throw new Error("XSRF-TOKEN not in Set-Cookie (auth flow may have changed)");
	}
	// 2. POST the token endpoint with the CSRF in the body + cookie jar.
	const tokResp = await fetch(ORIGIN + "/api/qldglobe/public/token", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Requested-With": "XMLHttpRequest",
			Origin: ORIGIN, Referer: ORIGIN + "/",
			Cookie: cookieHeader(jar),
		},
		body: JSON.stringify({
			url: serviceUrl,
			location: {
				href: ORIGIN + "/", origin: ORIGIN, protocol: "https:",
				host: "qldglobe.information.qld.gov.au",
				hostname: "qldglobe.information.qld.gov.au",
				port: "", pathname: "/", search: "", hash: "",
				ancestorOrigins: {},
			},
			_csrf: csrf,
		}),
	});
	if (tokResp.status !== 200) {
		const body = await tokResp.text();
		throw new Error(`token POST HTTP ${tokResp.status}: ${body.slice(0, 160)}`);
	}
	const tokData = await tokResp.json();
	if (!tokData.token) {
		throw new Error("token response missing `token` field: " + JSON.stringify(tokData).slice(0, 160));
	}
	return { token: tokData.token, jar };
}

await test("QLD Globe — full bootstrap + real tile", async () => {
	const { token } = await bootstrapQldToken(
		"https://spatial-img.information.qld.gov.au/arcgis/rest/services/" +
		"Basemaps/LatestStateProgram_QGovSISPUsers/ImageServer");
	// Tile (z=12, y=2373, x=3789) covers Brisbane CBD. ArcGIS ImageServer
	// /tile/ endpoint serves cached imagery — needs the token.
	const r = await fetchBuffer(
		"https://spatial-img.information.qld.gov.au/arcgis/rest/services/" +
		"Basemaps/LatestStateProgram_QGovSISPUsers/ImageServer/tile/" +
		"12/2373/3789?token=" + encodeURIComponent(token));
	assertEq(r.status, 200, "tile HTTP");
	const kind = sniffImage(r.body);
	assert(kind === "jpeg" || kind === "png",
		`tile not image (sniff=${kind}, first bytes=${[...r.body.slice(0,8)].map((b) => b.toString(16)).join(" ")})`);
});

await test("QLD Historical photos token — bootstrap + structured response", async () => {
	// QImagery uses a different scoped token. The bootstrap is identical
	// (CSRF + service URL POST); whether the resulting token actually
	// grants tile access depends on the requester's federation context.
	// Many anon callers see HTTP 200 + {error: {code:403, message:...}}
	// — the userscript already handles this gracefully via the
	// `if (data.error)` branch in doPhotosQuery, falling back to
	// ortho-only. So this test treats `{error}` as a valid shape.
	const { token } = await bootstrapQldToken(
		"https://spatial-img.information.qld.gov.au/arcgis/rest/services/" +
		"QImagery/HistoricalAerialPhoto_AllUsers/ImageServer");
	assert(typeof token === "string" && token.length > 0,
		"token bootstrap should yield a non-empty string");
	const url =
		"https://spatial-img.information.qld.gov.au/arcgis/rest/services/" +
		"QImagery/HistoricalAerialPhoto_AllUsers/ImageServer/query"
		+ "?geometry=" + encodeURIComponent('{"x":153.0251,"y":-27.4698,"spatialReference":{"wkid":4326}}')
		+ "&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects"
		+ "&outFields=objectid%2Ccapturestart&returnGeometry=false&f=json"
		+ "&where=1%3D1&resultRecordCount=3"
		+ "&token=" + encodeURIComponent(token);
	const r = await fetchJson(url);
	assertEq(r.status, 200);
	// Acceptable: either features (full access) or a structured error
	// (no access, script's documented fallback path).
	if (r.data.error) {
		assertHasKeys(r.data.error, ["code", "message"]);
	} else {
		assertHasKeys(r.data, ["features"]);
	}
});

await test("QLD Roads exportImage — bootstrap + real tile", async () => {
	const { token } = await bootstrapQldToken(
		"https://spatial-img.information.qld.gov.au/arcgis/rest/services/" +
		"Basemaps/LatestStateProgram_QGovSISPUsers/ImageServer");
	// Brisbane tile bbox in EPSG:3857. Same shape the userscript builds.
	const dw3857 = dw.tileToBBox3857(12, 3789, 2373);
	const bbox = `${dw3857.west},${dw3857.south},${dw3857.east},${dw3857.north}`;
	const dynamicLayers = encodeURIComponent(JSON.stringify(
		[21, 22, 23, 10].map((id) => ({
			id, source: { type: "mapLayer", mapLayerId: id },
			drawingInfo: { showLabels: true },
		})),
	));
	const url =
		"https://spatial-gis.information.qld.gov.au/arcgis/rest/services/" +
		"Transportation/RoadsAndTracks/MapServer/export"
		+ "?bbox=" + encodeURIComponent(bbox)
		+ "&bboxSR=102100&imageSR=102100"
		+ "&size=256%2C256&dpi=192&format=png32&transparent=true"
		+ "&dynamicLayers=" + dynamicLayers
		+ "&f=image&token=" + encodeURIComponent(token);
	const r = await fetchBuffer(url);
	assertEq(r.status, 200);
	const kind = sniffImage(r.body);
	assert(kind === "png" || kind === "jpeg",
		`Roads tile not image (sniff=${kind})`);
});

// Apple Maps end-to-end: DDG JWT → Apple bootstrap → real tile.
await test("Apple Maps — DDG JWT → bootstrap accessKey → real tile", async () => {
	// 1. DDG JWT
	const jwtResp = await fetch("https://duckduckgo.com/local.js?get_mk_token=1", {
		headers: { Referer: "https://duckduckgo.com/" },
	});
	assertEq(jwtResp.status, 200);
	const jwt = (await jwtResp.text()).trim();
	assert(/^[\w-]+\.[\w-]+\.[\w-]+$/.test(jwt), "DDG returned non-JWT");

	// 2. Apple bootstrap with Bearer JWT + Origin spoofed to DDG.
	const bootResp = await fetch(
		"https://cdn.apple-mapkit.com/ma/bootstrap?apiVersion=2&mkjsVersion=5.79.95&poi=1",
		{ headers: {
			Accept: "*/*", Authorization: "Bearer " + jwt,
			Origin: "https://duckduckgo.com", Referer: "https://duckduckgo.com/",
		}});
	assertEq(bootResp.status, 200, "Apple bootstrap HTTP");
	const bootBody = await bootResp.text();
	const bootData = JSON.parse(bootBody);
	assertHasKeys(bootData, ["accessKey"]);
	// Build template's `v=` build number — the script harvests this on
	// every refresh so it doesn't drift onto a stale build.
	const vMatch = bootBody.match(/[?&]v=(\d+)/);
	const version = vMatch ? vMatch[1] : "2605231";

	// 3. Real tile request. Apple's tile URL embeds accessKey + v.
	const tileUrl =
		"https://cdn.apple-mapkit.com/ti/tile?x=947&y=593&z=10" +
		"&style=0&size=1&scale=2&lang=en&poi=1&labels=1&tint=dark" +
		"&emphasis=standard&v=" + version +
		"&accessKey=" + encodeURIComponent(bootData.accessKey);
	const tileResp = await fetchBuffer(tileUrl);
	assertEq(tileResp.status, 200, "Apple tile HTTP");
	const kind = sniffImage(tileResp.body);
	assert(kind === "jpeg" || kind === "png",
		`Apple tile not image (sniff=${kind})`);
});

// Wayback tile end-to-end: catalog → first release → real tile.
await test("Esri Wayback — catalog → first release → real tile", async () => {
	const catResp = await fetch(
		"https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json");
	assertEq(catResp.status, 200);
	const catalog = await catResp.json();
	const keys = Object.keys(catalog).filter((k) => catalog[k].itemTitle);
	assert(keys.length > 0, "no usable catalog entries");
	// The script sorts by itemTitle (date desc) — emulate so the test
	// hits a recent release with known coverage.
	keys.sort((a, b) => catalog[a].itemTitle < catalog[b].itemTitle ? 1 : -1);
	const releaseNum = keys[0];

	const tileUrl =
		"https://wayback.maptiles.arcgis.com/arcgis/rest/services/" +
		`World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/${releaseNum}/10/593/947`;
	const r = await fetchBuffer(tileUrl);
	assertEq(r.status, 200, `release ${releaseNum} tile HTTP`);
	const kind = sniffImage(r.body);
	assert(kind === "jpeg" || kind === "png",
		`Wayback tile not image (sniff=${kind})`);
});

// -- Summary -----------------------------------------------------------

console.log("");
console.log("shape tests");
console.log("===========");
for (const [ok, name, err] of results) {
	if (ok) console.log(`  ${c(C_GREEN, "PASS")}  ${name}`);
	else if (ok === null) console.log(`  SKIP  ${name}\n        ${c(C_DIM, err)}`);
	else    console.log(`  ${c(C_RED, "FAIL")}  ${name}\n        ${c(C_DIM, err)}`);
}
console.log("");
console.log(`${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail ? 1 : 0);
