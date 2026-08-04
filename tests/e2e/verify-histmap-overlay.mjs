#!/usr/bin/env node
// Verify the Historic Map Sheets layer: the footprint index renders, and
// the "Overlay ▦" action superimposes a scanned sheet on the map as a
// distortable image (4 draggable corners) that warps via CSS matrix3d and
// re-warps when a corner is dragged.
//
//   npm run e2e:histmap
import { chromium } from "playwright";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname  = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = resolve(__dirname, "..", "..");
const STATE_PATH = resolve(REPO_ROOT, ".auth", "storage.json");
const REPORT_DIR = resolve(REPO_ROOT, "test-results");
if (!existsSync(STATE_PATH)) { console.error("run npm run e2e:auth first"); process.exit(2); }

const browser = await chromium.launch({ headless: !process.env.HEADED });
const context = await browser.newContext({ storageState: STATE_PATH, viewport: { width: 1400, height: 900 } });

let indexTiles = 0;
context.on("response", (r) => {
	if (r.url().includes("HistoricalPrintedMapExtents/MapServer/export") && r.status() === 200) indexTiles++;
});

await context.addInitScript({ content: readFileSync(resolve(__dirname, "lib", "bootstrap.js"), "utf8") });
await context.addInitScript({ content: readFileSync(resolve(REPO_ROOT, "dynamicwatch-custom-tiles.user.js"), "utf8") });

const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto("https://dynamic.watch/plan", { waitUntil: "domcontentloaded", timeout: 45_000 });
await page.waitForSelector(".leaflet-planner-controls", { timeout: 30_000 });
await page.evaluate(() => {
	document.querySelectorAll(".modal, .modal-backdrop").forEach((el) => el.remove());
	document.body.classList.remove("modal-open"); document.body.style.overflow = "";
});
await page.waitForFunction(() => !!(window._dwLayerCtrl && window._dwLayerCtrl._map), undefined, { timeout: 15_000 });

// Enable Historic Map Sheets + centre on the Gympie goldfield.
const on = await page.evaluate(() => {
	const ctrl = window._dwLayerCtrl, map = ctrl._map;
	map.setView([-26.19, 152.66], 15);
	const e = ctrl._layers.find((l) => l.name === "Historic Map Sheets" && l.overlay);
	if (!e) return false;
	if (!map.hasLayer(e.layer)) map.addLayer(e.layer);
	return true;
});
if (!on) { console.error("Historic Map Sheets layer missing"); await browser.close(); process.exit(1); }
await page.waitForTimeout(3500);

// REAL discovery path: HOVER the footprints → an interactive panel lists
// the sheets there (a plain map click would just drop a waypoint). Move
// into the panel and click "Overlay ▦".
// Drive the Leaflet map 'mousemove' the hover handler listens on. (A
// synthetic OS-level mouse move doesn't reliably reach Leaflet's internal
// handler in headless; firing the map event is the faithful handler test —
// real cursor movement produces the same event.)
await page.evaluate(() => {
	const map = window._dwLayerCtrl._map;
	const ll = L.latLng(-26.19, 152.66);
	map.fire("mousemove", { latlng: ll, containerPoint: map.latLngToContainerPoint(ll), originalEvent: {} });
});
const sectionShown = await page.waitForSelector(".dw-histmap-hover .dw-histmap-overlay-link",
	{ timeout: 30_000 }).then(() => true).catch(() => false);
console.log(`  hover panel lists sheets with Overlay links: ${sectionShown}`);

if (sectionShown) {
	// A help modal can reappear and intercept pointer events — clear it.
	await page.evaluate(() => {
		document.querySelectorAll(".modal, .modal-backdrop, #help-modal").forEach((el) => el.remove());
		document.body.classList.remove("modal-open"); document.body.style.overflow = "";
	});
	await page.click(".dw-histmap-hover .dw-histmap-overlay-link", { force: true });
}

// The scan must appear as a triangle mesh (each tri gets a matrix()
// transform), with a 3×3 lattice of 9 draggable handles + the control.
const warped = await page.waitForFunction(() => {
	const tris = [...document.querySelectorAll(".dw-histmap-tri")];
	if (tris.length !== 8) return false;
	const drawn = tris.every((d) => {
		const tf = getComputedStyle(d).transform;
		return tf && tf !== "none";
	});
	return drawn && document.querySelectorAll(".dw-histmap-handle").length === 9 &&
		!!document.querySelector(".dw-histmap-ctl");
}, undefined, { timeout: 30_000 }).then(() => true).catch(() => false);

// Signature of all triangle transforms — changes when the mesh re-warps.
const meshTf = () => page.evaluate(() =>
	[...document.querySelectorAll(".dw-histmap-tri")].map((d) => d.style.transform).join("|"));

// Zoom re-warps the mesh (layer points change). Panning correctly does NOT
// (Leaflet translates the whole pane).
let zoomReWarped = false;
if (warped) {
	const before = await meshTf();
	await page.evaluate(() => window._dwLayerCtrl._map.setZoom(window._dwLayerCtrl._map.getZoom() - 1, { animate: false }));
	await page.waitForTimeout(600);
	zoomReWarped = before !== (await meshTf());
}

// Interior-point drag: move an EDGE-MIDPOINT/centre handle (not a corner)
// via the map API and confirm the mesh re-warps — proving control points
// beyond the corners bend the map.
const cornerDrag = warped ? await page.evaluate(() => {
	const map = window._dwLayerCtrl._map;
	const before = [...document.querySelectorAll(".dw-histmap-tri")].map((d) => d.style.transform).join("|");
	let mid = null;
	for (const id in map._layers) {
		const l = map._layers[id];
		const cn = l.options && l.options.icon && l.options.icon.options && l.options.icon.options.className;
		if (cn && /dw-histmap-handle--mid/.test(cn)) { mid = l; break; }
	}
	if (!mid) return { found: false, changed: false };
	const ll = mid.getLatLng();
	mid.setLatLng([ll.lat + 0.003, ll.lng - 0.003]);
	mid.fire("drag");
	const after = [...document.querySelectorAll(".dw-histmap-tri")].map((d) => d.style.transform).join("|");
	return { found: true, changed: after !== before };
}) : { found: false, changed: false };
const reWarped = zoomReWarped && cornerDrag.changed;

if (!existsSync(REPORT_DIR)) mkdirSync(REPORT_DIR, { recursive: true });
const shot = resolve(REPORT_DIR, `verify-histmap-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
await page.screenshot({ path: shot });

console.log("\n=== Historic Map Sheets verification ===");
console.log(`  index footprint tiles (export 200): ${indexTiles}`);
console.log(`  hover panel lists sheets w/ Overlay link: ${sectionShown}`);
console.log(`  scan superimposed as mesh (8 tris, 9 handles, control): ${warped}`);
console.log(`  re-warps on zoom: ${zoomReWarped}`);
console.log(`  re-warps on interior-point drag (found: ${cornerDrag.found}): ${cornerDrag.changed}`);
console.log(`  page errors: ${errors.length}${errors.length ? " -> " + errors.slice(0, 2).join(" | ") : ""}`);
console.log(`  screenshot: ${shot}`);
const ok = indexTiles > 0 && sectionShown && warped && reWarped && errors.length === 0;
console.log(`\n${ok ? "✓ PASS" : "✗ FAIL"} — historic map overlay ${ok ? "superimposes + rubber-sheets" : "did not fully verify"}`);
await browser.close();
process.exit(ok ? 0 : 1);
