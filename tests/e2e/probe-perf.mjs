#!/usr/bin/env node
// Performance measurement probe (diagnostic). Quantifies the cost the
// perf sweep is reasoning about, so fixes target real numbers.
import { chromium } from "playwright";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..", "..");
const STATE = resolve(REPO, ".auth", "storage.json");
if (!existsSync(STATE)) { console.error("auth"); process.exit(2); }

const browser = await chromium.launch({ headless: !process.env.HEADED, args: ["--disable-web-security", "--disable-features=IsolateOrigins,site-per-process"] });
const ctx = await browser.newContext({ storageState: STATE, viewport: { width: 1400, height: 900 } });
await ctx.addInitScript({ content: readFileSync(resolve(__dirname, "lib", "bootstrap.js"), "utf8") });
await ctx.addInitScript({ content: readFileSync(resolve(REPO, "dynamicwatch-custom-tiles.user.js"), "utf8") });
const page = await ctx.newPage();
let reqs = 0; page.on("request", () => reqs++);

await page.goto("https://dynamic.watch/plan", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForSelector(".leaflet-planner-controls", { timeout: 30000 });
await page.evaluate(() => { document.querySelectorAll(".modal,.modal-backdrop").forEach(e=>e.remove()); document.body.classList.remove("modal-open"); });
await page.waitForFunction(() => !!(window._dwLayerCtrl && window._dwLayerCtrl._map), { timeout: 15000 });
const setOv = (names, on) => page.evaluate(([names, on]) => {
	const ctrl = window._dwLayerCtrl, map = ctrl._map;
	for (const n of names) { const e = ctrl._layers.find((l) => l.name === n && l.overlay); if (!e) continue; if (on && !map.hasLayer(e.layer)) map.addLayer(e.layer); if (!on && map.hasLayer(e.layer)) map.removeLayer(e.layer); }
}, [names, on]);

// ---- Geocaches: per-pan rebuild cost at dense Brisbane z13 ----
console.log("=== Geocaches: tiny-pan rebuild cost (Brisbane z13) ===");
await page.evaluate(() => window._dwLayerCtrl._map.setView([-27.47, 153.03], 13));
await setOv(["Geocaches"], true);
await page.waitForTimeout(7000);
const before = await page.evaluate(() => document.querySelectorAll(".dw-geo-icon").length);
// Measure: markers destroyed/created on a small pan, and the refetch wait.
const pan = await page.evaluate(async () => {
	const map = window._dwLayerCtrl._map;
	let created = 0, removed = 0;
	const onAdd = (e) => { if (e.layer instanceof L.Marker) created++; };
	const onRem = (e) => { if (e.layer instanceof L.Marker) removed++; };
	map.on("layeradd", onAdd); map.on("layerremove", onRem);
	const t0 = performance.now();
	map.panBy([80, 60], { animate: false });
	await new Promise((r) => setTimeout(r, 1600));
	map.off("layeradd", onAdd); map.off("layerremove", onRem);
	return { created, removed, ms: Math.round(performance.now() - t0) };
});
console.log(`  markers before pan: ${before}`);
console.log(`  on a tiny 80px pan: ${pan.removed} removed + ${pan.created} created (most likely overlap → wasted)`);

// ---- zoomend handler cost (we added _normalizeBaseZoom there) ----
console.log("\n=== zoomend handler cost (10 zoom changes) ===");
const zc = await page.evaluate(async () => {
	const map = window._dwLayerCtrl._map;
	const t0 = performance.now();
	for (let i = 0; i < 10; i++) {
		map.setZoom(13 + (i % 3), { animate: false });
		await new Promise((r) => setTimeout(r, 120));
	}
	return Math.round(performance.now() - t0);
});
console.log(`  10 zoom changes wall: ${zc}ms (incl. 1.2s of waits) — handler work is the remainder`);

// ---- request volume on a multi-pan with several overlays ----
console.log("\n=== request volume: 5 pans with Geocaches+Cadastre+Strava ===");
await setOv(["QLD Cadastre", "Strava Heatmap"], true);
await page.waitForTimeout(1500);
const r0 = reqs;
await page.evaluate(async () => {
	const map = window._dwLayerCtrl._map;
	for (let i = 0; i < 5; i++) { map.panBy([120, 90], { animate: false }); await new Promise((r) => setTimeout(r, 900)); }
});
await page.waitForTimeout(1500);
console.log(`  requests over 5 pans: ${reqs - r0}`);

console.log("\n(perf probe done)");
await browser.close();
