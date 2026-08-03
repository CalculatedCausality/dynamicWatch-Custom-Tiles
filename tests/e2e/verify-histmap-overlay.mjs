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

// Trigger the overlay action the way the popup does: an .dw-histmap-overlay-link.
await page.evaluate(() => {
	const a = document.createElement("a");
	a.className = "dw-histmap-overlay-link";
	a.href = "#";
	a.dataset.url = "https://apps.information.qld.gov.au/data/v2/HistoricalMaps/StaticMap/topographic/topo-map-6chain-line-colour-gympie-sh8-1909/original";
	a.dataset.title = "Gympie and Environs sheet 8 (1909)";
	// Small box centred in-view so all four corner handles are on-screen.
	a.dataset.n = "-26.183"; a.dataset.s = "-26.197"; a.dataset.w = "152.652"; a.dataset.e = "152.668";
	document.body.appendChild(a);
	a.click();
});

// The scan img must appear, load, and receive a matrix3d transform; 4 corner
// handles + the control must exist.
const warped = await page.waitForFunction(() => {
	const img = document.querySelector(".dw-histmap-img");
	if (!img || !img.complete || !img.naturalWidth) return false;
	const tf = getComputedStyle(img).transform;
	return tf && tf !== "none" && document.querySelectorAll(".dw-histmap-handle").length === 4 &&
		!!document.querySelector(".dw-histmap-ctl");
}, undefined, { timeout: 30_000 }).then(() => true).catch(() => false);

const tf = () => page.evaluate(() => document.querySelector(".dw-histmap-img").style.transform);

// Zoom re-warps the overlay (layer points change → new matrix3d). Panning
// correctly does NOT (Leaflet translates the whole pane), so zoom is the
// right map-driven re-warp signal.
let zoomReWarped = false;
if (warped) {
	const before = await tf();
	await page.evaluate(() => window._dwLayerCtrl._map.setZoom(window._dwLayerCtrl._map.getZoom() - 1, { animate: false }));
	await page.waitForTimeout(600);
	zoomReWarped = before !== (await tf());
}

// Corner-drag re-warp: drive a corner handle through the map API (a
// synthetic Leaflet marker mouse-drag is unreliable in automation) and
// confirm the image re-warps — proving the handle → update → matrix3d wiring.
const cornerDrag = warped ? await page.evaluate(() => {
	const map = window._dwLayerCtrl._map;
	const img = document.querySelector(".dw-histmap-img");
	let marker = null;
	for (const id in map._layers) {
		const l = map._layers[id];
		if (l.options && l.options.icon && l.options.icon.options &&
			l.options.icon.options.className === "dw-histmap-handle") { marker = l; break; }
	}
	if (!marker) return { found: false, changed: false };
	const before = img.style.transform;
	const ll = marker.getLatLng();
	marker.setLatLng([ll.lat + 0.004, ll.lng + 0.004]);
	marker.fire("drag");
	return { found: true, changed: img.style.transform !== before };
}) : { found: false, changed: false };
const reWarped = zoomReWarped && cornerDrag.changed;

if (!existsSync(REPORT_DIR)) mkdirSync(REPORT_DIR, { recursive: true });
const shot = resolve(REPORT_DIR, `verify-histmap-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
await page.screenshot({ path: shot });

console.log("\n=== Historic Map Sheets verification ===");
console.log(`  index footprint tiles (export 200): ${indexTiles}`);
console.log(`  scan superimposed + warped (matrix3d, 4 handles, control): ${warped}`);
console.log(`  re-warps on zoom: ${zoomReWarped}`);
console.log(`  re-warps on corner drag (handle found: ${cornerDrag.found}): ${cornerDrag.changed}`);
console.log(`  page errors: ${errors.length}${errors.length ? " -> " + errors.slice(0, 2).join(" | ") : ""}`);
console.log(`  screenshot: ${shot}`);
const ok = indexTiles > 0 && warped && reWarped && errors.length === 0;
console.log(`\n${ok ? "✓ PASS" : "✗ FAIL"} — historic map overlay ${ok ? "superimposes + rubber-sheets" : "did not fully verify"}`);
await browser.close();
process.exit(ok ? 0 : 1);
