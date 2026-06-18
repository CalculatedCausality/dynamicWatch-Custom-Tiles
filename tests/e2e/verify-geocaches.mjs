#!/usr/bin/env node
// Geocaches layer verification — proves the public-tile rewrite (v7.9.85)
// actually paints markers on screen.
//
// WHY THIS EXISTS SEPARATELY from run-3d-asserts.mjs: Groundspeak's
// UTFGrid endpoint only returns data when the request carries
// `Referer: https://www.geocaching.com/play/map`. The Tampermonkey shim
// in lib/bootstrap.js routes GM_xmlhttpRequest through `fetch`, which
// silently drops Referer (it's a forbidden header for fetch). So the
// layer renders BLANK in the normal harness even though it works fine in
// real Tampermonkey.
//
// The fix: `context.route` intercepts at the NETWORK layer, below fetch's
// forbidden-header policy, so we can inject Referer on geocaching.com
// requests. That faithfully reproduces what real Tampermonkey does.
//
// Run:
//     node tests/e2e/verify-geocaches.mjs
//     HEADED=1 node tests/e2e/verify-geocaches.mjs   # watch it
//
// Opens a Brisbane-CBD plan (cache-dense at z=12), enables Geocaches,
// waits for tiles, then asserts: (a) markers landed in dwGeocachingPane,
// (b) a sample marker's tooltip carries a GC code, (c) screenshot saved.
import { chromium } from "playwright";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname  = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = resolve(__dirname, "..", "..");
const SCRIPT_SRC = resolve(REPO_ROOT, "dynamicwatch-custom-tiles.user.js");
const BOOTSTRAP  = resolve(__dirname, "lib", "bootstrap.js");
const STATE_PATH = resolve(REPO_ROOT, ".auth", "storage.json");
const REPORT_DIR = resolve(REPO_ROOT, "test-results");

const HEADED = !!process.env.HEADED;
const PLAN   = process.env.PLAN || "/plan";
const URL    = "https://dynamic.watch" + PLAN;
// Centre + zoom we force the Leaflet map to before enabling the layer.
// Default is a region the dev probes have NOT warmed (Gold Coast), so
// the run exercises the real cold-tile warm-on-204 path, not a tile that
// happens to be warm. Override with GC_LAT/GC_LNG/GC_ZOOM.
const TARGET = {
	lat:  parseFloat(process.env.GC_LAT  || "-28.00"),
	lng:  parseFloat(process.env.GC_LNG  || "153.40"),
	zoom: parseInt(process.env.GC_ZOOM   || "12", 10),
};

if (!existsSync(STATE_PATH)) {
	console.error(`No auth state at ${STATE_PATH} — run \`npm run e2e:auth\` first.`);
	process.exit(2);
}

const bootstrap  = readFileSync(BOOTSTRAP, "utf8");
const userscript = readFileSync(SCRIPT_SRC, "utf8");

const browser = await chromium.launch({
	headless: !HEADED,
	args: [
		"--disable-web-security",
		"--disable-features=IsolateOrigins,site-per-process",
	],
});
const context = await browser.newContext({
	storageState: STATE_PATH,
	viewport: { width: 1600, height: 1000 },
});

// THE KEY DIFFERENCE vs run-3d-check.mjs: inject Referer on every
// geocaching.com tile request at the network layer. This is exactly the
// header real Tampermonkey GM_xmlhttpRequest sends; the fetch-based shim
// can't set it, so without this the UTFGrid comes back empty.
let geocacheRequests = 0;
let geocacheNonEmpty = 0;
await context.route(/tiles\d+\.geocaching\.com\//, async (route) => {
	const req = route.request();
	const headers = { ...req.headers(), referer: "https://www.geocaching.com/play/map" };
	const isInfo = req.url().includes("map.info");
	try {
		const resp = await route.fetch({ headers });
		geocacheRequests++;
		if (isInfo) {
			// Only map.info is text — inspect it. NEVER read map.png as
			// text: that mangles the binary and fulfilling with the
			// mangled string serves a corrupt image. Pass PNGs through
			// untouched by fulfilling straight from the response.
			const body = await resp.text();
			if (body.length > 100 && body.includes('"i"')) geocacheNonEmpty++;
			await route.fulfill({ response: resp, body });
		} else {
			await route.fulfill({ response: resp });
		}
	} catch (_) {
		// Late request arriving during browser teardown — the context is
		// already closing. Swallow so it doesn't surface as uncaught.
		try { await route.abort(); } catch (_) {}
	}
});

await context.addInitScript({ content: bootstrap });
await context.addInitScript({ content: userscript });

const page = await context.newPage();
const logs = [], errors = [];
page.on("console", (m) => logs.push({ type: m.type(), text: m.text() }));
page.on("pageerror", (e) => errors.push(e.message));
// Catch ALL requests touching geocaching.com regardless of route match,
// so we can tell "fetch never fired" from "route regex didn't match".
const allGcReqs = [];
page.on("request", (r) => {
	if (r.url().includes("geocaching.com")) allGcReqs.push(r.url());
});

console.log(`→ ${URL}`);
const response = await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
if (page.url().includes("/users/sign_in")) {
	console.error("Redirected to sign_in — auth expired. Run `npm run e2e:auth`.");
	await browser.close();
	process.exit(1);
}

await page.waitForSelector(".leaflet-planner-controls", { timeout: 30_000 });

// Dismiss the first-visit "Planner help" modal — it covers the map and
// would hide the markers in the screenshot. Nuke everything modal-shaped
// (same approach as run-3d-asserts.mjs).
try { await page.keyboard.press("Escape"); } catch (_) {}
await page.evaluate(() => {
	document.querySelectorAll(".modal, .modal-backdrop").forEach(el => el.remove());
	document.body.classList.remove("modal-open");
	document.body.style.overflow = "";
	document.body.style.paddingRight = "";
});

// The Leaflet map is reachable via the layer control's `_map` before 3D
// is ever toggled (`window._dwMap` is only exposed once 3D activates).
await page.waitForFunction(
	() => !!(window._dwLayerCtrl && window._dwLayerCtrl._map),
	{ timeout: 15_000 },
);

// Force the map to the cache-dense target BEFORE enabling the layer, so
// the very first UTFGrid fetch lands on a populated tile.
const viewInfo = await page.evaluate((t) => {
	const map = window._dwLayerCtrl._map;
	map.setView([t.lat, t.lng], t.zoom);
	const c = map.getCenter();
	return { lat: c.lat, lng: c.lng, zoom: map.getZoom(),
		hasGetBounds: typeof map.getBounds === "function" };
}, TARGET);
console.log(`  map view: ${JSON.stringify(viewInfo)}`);
await page.waitForTimeout(500);

// Enable the Geocaches overlay via the layer-control registry.
const enabled = await page.evaluate(() => {
	const ctrl = window._dwLayerCtrl;
	if (!ctrl || !ctrl._map) return { ok: false, reason: "no layer ctrl" };
	const entry = ctrl._layers.find((l) => l.name === "Geocaches" && l.overlay);
	if (!entry) {
		const all = ctrl._layers.filter(l => l.overlay).map(l => l.name);
		return { ok: false, reason: `Geocaches not in registry; have: ${all.join(", ")}` };
	}
	if (!ctrl._map.hasLayer(entry.layer)) ctrl._map.addLayer(entry.layer);
	// Report whether the layer is now on the map and what its internal
	// state is, to diagnose a no-request failure.
	const lyr = entry.layer;
	return {
		ok: true,
		hasLayer: ctrl._map.hasLayer(lyr),
		layerHasMap: !!lyr._map,
		layerHasGroup: !!lyr._group,
		mapZoom: ctrl._map.getZoom(),
	};
});
if (!enabled.ok) {
	console.error(`✗ Could not enable Geocaches: ${enabled.reason}`);
	await browser.close();
	process.exit(1);
}
console.log(`✓ Geocaches overlay enabled: ${JSON.stringify(enabled)}`);

// Give the debounced fetch (500 ms) + cold-tile warm cycle time to land.
// A cold tile is 3 sequential round-trips: info(204) → png(warm) →
// info(data). With ~35 tiles across 4 subdomains, allow a generous window.
await page.waitForTimeout(8000);

// Count markers actually attached to the geocaching pane.
const result = await page.evaluate(() => {
	const map = window._dwLayerCtrl._map;
	let count = 0;
	let sampleTooltip = null;
	let sampleLatLng = null;
	map.eachLayer(function visit(lyr) {
		if (lyr.eachLayer && !(lyr instanceof L.Marker)) { lyr.eachLayer(visit); return; }
		if (lyr instanceof L.Marker && (lyr.options?.pane === "dwGeocachingPane")) {
			count++;
			if (!sampleTooltip) {
				const tt = lyr.getTooltip?.();
				sampleTooltip = tt ? tt.getContent() : null;
				const ll = lyr.getLatLng?.();
				sampleLatLng = ll ? { lat: ll.lat, lng: ll.lng } : null;
			}
		}
	});
	// Also read the pane's DOM child count as a cross-check.
	const pane = map.getPane?.("dwGeocachingPane");
	const domCount = pane ? pane.querySelectorAll(".dw-geo-icon").length : -1;
	return { count, domCount, sampleTooltip, sampleLatLng };
});

// Dismiss the modal AGAIN right before the screenshot — dynamic.watch
// re-pops "Planner help" after map init, so the earlier removal doesn't
// stick.
await page.evaluate(() => {
	document.querySelectorAll(".modal, .modal-backdrop").forEach(el => el.remove());
	document.body.classList.remove("modal-open");
	document.body.style.overflow = "";
});
await page.waitForTimeout(300);

if (!existsSync(REPORT_DIR)) mkdirSync(REPORT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const shotPath = resolve(REPORT_DIR, `verify-geocaches-${stamp}.png`);
await page.screenshot({ path: shotPath, fullPage: false });

// --- 3D mirror check ---------------------------------------------------
// With caches rendered in 2D, toggle 3D and confirm the Mode3DController
// mirrors them into the Mapbox `dw-shapes-point-dwGeocachingPane` source
// with kind="geocache" + a GC code (the _dwData bridge). This is the
// only harness that can exercise 3D-with-geocaches, since geocaches need
// the Referer the route handler injects.
let mirror = { skipped: true };
try {
	await page.waitForSelector(".dw-3d-btn", { timeout: 5_000 });
	await page.evaluate(() => document.querySelector(".dw-3d-btn")?.click());
	await page.waitForFunction(
		() => window._dwMb && window._dwMb.isStyleLoaded?.(),
		{ timeout: 30_000 },
	);
	// Allow the 3D init shapes-sync (which retries once the style idles,
	// since _syncOverlays flips isStyleLoaded false) to settle.
	await page.waitForTimeout(3_000);
	mirror = await page.evaluate(() => {
		const mb = window._dwMb;
		const src = mb.getSource?.("dw-shapes-point-dwGeocachingPane");
		const data = src && (src._data || src.serialize?.().data);
		const feats = (data && data.features) || [];
		const geocacheFeats = feats.filter(
			(f) => f.properties && f.properties.kind === "geocache",
		);
		const sample = geocacheFeats[0]?.properties || null;
		return {
			skipped: false,
			sourceExists: !!src,
			featureCount: feats.length,
			geocacheCount: geocacheFeats.length,
			sampleHasCode: !!(sample && /^GC[0-9A-Z]+$/.test(sample.code || "")),
			sampleColor: sample?.color || null,
		};
	});
} catch (e) {
	mirror = { skipped: false, error: e.message };
}

console.log("\n=== Geocaches verification ===");
console.log(`  ALL geocaching.com requests:   ${allGcReqs.length}`);
if (allGcReqs.length) console.log(`    e.g. ${allGcReqs.slice(0, 3).join("\n         ")}`);
console.log(`  geocaching.com tile requests:  ${geocacheRequests}`);
console.log(`  …with non-empty UTFGrid body:  ${geocacheNonEmpty}`);
console.log(`  markers in dwGeocachingPane:   ${result.count}`);
console.log(`  .dw-geo-icon DOM nodes:        ${result.domCount}`);
console.log(`  sample marker latLng:          ${JSON.stringify(result.sampleLatLng)}`);
console.log(`  sample tooltip HTML:           ${result.sampleTooltip}`);
console.log(`  screenshot:                    ${shotPath}`);
console.log(`  3D mirror:                     ${JSON.stringify(mirror)}`);

const gcLogs = logs.filter(l => l.text.includes("Geocach") || l.text.includes("geocach"));
if (gcLogs.length) {
	console.log("\n=== Geocaches console logs ===");
	for (const l of gcLogs.slice(-10)) console.log(`  ${l.type}: ${l.text}`);
}
if (errors.length) {
	console.log("\n=== PAGE ERRORS ===");
	for (const e of errors.slice(-10)) console.log(`  ${e}`);
}

// Pass criteria: requests fired, at least one returned data, markers
// landed, and a sample marker carries a GC code in its tooltip.
const tooltipHasCode = /GC[0-9A-Z]+/.test(result.sampleTooltip || "");
const render2dOk =
	geocacheRequests > 0 &&
	geocacheNonEmpty > 0 &&
	result.count > 0 &&
	tooltipHasCode;
// 3D mirror is a softer gate — if 3D failed to enable (e.g. WebGL
// unavailable in the CI box) we don't want to red the whole run, but if
// it DID enable, the geocache source must carry coded features.
const mirror3dOk =
	mirror.skipped || mirror.error
		? true
		: mirror.sourceExists && mirror.geocacheCount > 0 && mirror.sampleHasCode;

await browser.close();

// --- CORS-ENFORCED phase --------------------------------------------------
// The main run launches Chromium with --disable-web-security, which masks
// CORS failures — that blind spot hid both the Strava crossOrigin breakage
// AND the geocache icon-tile breakage (map.png serves no ACAO, so a
// crossOrigin:true <img> renders nothing in a real browser). This phase
// re-launches WITHOUT the flag and asserts the PNG icon tiles actually
// decode. (GM-backed fetches die under real CORS, so only the <img> tile
// pipeline is testable here — which is exactly the pipeline at risk.)
console.log("\n=== CORS-enforced phase (real browser security) ===");
let corsOk = false;
{
	const b2 = await chromium.launch({ headless: !process.env.HEADED });
	const c2 = await b2.newContext({ storageState: STATE_PATH, viewport: { width: 1280, height: 800 } });
	await c2.addInitScript({ content: readFileSync(BOOTSTRAP, "utf8") });
	await c2.addInitScript({ content: readFileSync(SCRIPT_SRC, "utf8") });
	const p2 = await c2.newPage();
	try {
		await p2.goto(URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
		await p2.waitForSelector(".leaflet-planner-controls", { timeout: 30_000 });
		await p2.evaluate(() => {
			document.querySelectorAll(".modal,.modal-backdrop").forEach((el) => el.remove());
			document.body.classList.remove("modal-open");
		});
		await p2.waitForFunction(() => !!(window._dwLayerCtrl && window._dwLayerCtrl._map), { timeout: 15_000 });
		await p2.evaluate((t) => {
			const map = window._dwLayerCtrl._map, ctrl = window._dwLayerCtrl;
			map.setView([t.lat, t.lng], t.zoom);
			const e = ctrl._layers.find((l) => l.name === "Geocaches" && l.overlay);
			if (e && !map.hasLayer(e.layer)) map.addLayer(e.layer);
		}, TARGET);
		await p2.waitForTimeout(6000);
		const png = await p2.evaluate(() => {
			const pane = window._dwLayerCtrl._map.getPane("dwGeocachingTilePane");
			const imgs = pane ? [...pane.querySelectorAll("img.leaflet-tile")] : [];
			const decoded = imgs.filter((i) => i.complete && i.naturalWidth > 0).length;
			return { total: imgs.length, decoded };
		});
		console.log(`  icon tiles under real CORS: ${png.decoded}/${png.total} decoded`);
		corsOk = png.decoded > 0;
	} catch (e) {
		console.log(`  CORS phase error: ${e.message.slice(0, 120)}`);
	}
	await b2.close();
}

const ok = render2dOk && mirror3dOk && corsOk;

console.log(`\n  2D render: ${render2dOk ? "✓" : "✗"}   3D mirror: ${
	mirror.skipped || mirror.error ? "skipped/error" : (mirror3dOk ? "✓" : "✗")
}   icons under real CORS: ${corsOk ? "✓" : "✗"}`);
console.log(`${ok ? "✓ PASS" : "✗ FAIL"} — Geocaches public-tile layer ${ok ? "renders in 2D + mirrors into 3D + icons survive real CORS" : "FAILED"}`);
process.exit(ok ? 0 : 1);
