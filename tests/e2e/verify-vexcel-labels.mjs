#!/usr/bin/env node
// Confirm the Vexcel basemap gets Esri reference street/suburb labels
// (the raster roads+labels pair), the same way Wayback does.
import { chromium } from "playwright";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const STATE_PATH = resolve(REPO_ROOT, ".auth", "storage.json");
const REPORT_DIR = resolve(REPO_ROOT, "test-results");
if (!existsSync(STATE_PATH)) { console.error("run npm run e2e:auth first"); process.exit(2); }
const m = (process.env.VEXCEL_TOKEN || "").match(/([\w-]+\.[\w-]+\.[\w-]+)/);
const TOKEN = m ? m[1] : "";
if (!TOKEN) { console.error("set VEXCEL_TOKEN"); process.exit(2); }

const browser = await chromium.launch({ headless: !process.env.HEADED,
	args: ["--disable-web-security", "--disable-features=IsolateOrigins,site-per-process"] });
const context = await browser.newContext({ storageState: STATE_PATH, viewport: { width: 1200, height: 800 } });
let esriTiles = 0;
context.on("response", (r) => { if (/server\.arcgisonline\.com\/.*\/(World_Transportation|World_Boundaries_and_Places)/.test(r.url()) && r.status() === 200) esriTiles++; });
await context.addInitScript({ content: readFileSync(resolve(__dirname, "lib", "bootstrap.js"), "utf8") });
await context.addInitScript({ content: `try { localStorage.setItem("GM:dw_vexcel_token", ${JSON.stringify(JSON.stringify(TOKEN))}); } catch (_) {}` });
await context.addInitScript({ content: readFileSync(resolve(REPO_ROOT, "dynamicwatch-custom-tiles.user.js"), "utf8") });
const page = await context.newPage();
await page.goto("https://dynamic.watch/plan", { waitUntil: "domcontentloaded", timeout: 45_000 });
await page.waitForSelector(".leaflet-planner-controls", { timeout: 30_000 });
const nuke = () => page.evaluate(() => { document.querySelectorAll(".modal,.modal-backdrop").forEach(e => e.remove()); document.body.classList.remove("modal-open"); document.body.style.overflow = ""; });
await nuke();
await page.waitForFunction(() => !!(window._dwLayerCtrl && window._dwLayerCtrl._map), { timeout: 15_000 });
await page.evaluate(() => window._dwLayerCtrl._map.setView([-26.658, 153.100], 15));
const on = await page.evaluate(() => {
	const map = window._dwLayerCtrl._map, ctrl = window._dwLayerCtrl;
	const vex = ctrl._layers.find((l) => l.name === "Vexcel Aerial")?.layer;
	ctrl._layers.filter((l) => !l.overlay).forEach((l) => { if (l.layer !== vex && map.hasLayer(l.layer)) map.removeLayer(l.layer); });
	if (!map.hasLayer(vex)) map.addLayer(vex);
	return {};
});
await page.waitForTimeout(3500);
await nuke();
if (!existsSync(REPORT_DIR)) mkdirSync(REPORT_DIR, { recursive: true });
const shot = resolve(REPORT_DIR, "verify-vexcel-labels.png");
await page.screenshot({ path: shot });
// The Esri reference layer is app-managed (not in the control registry),
// so its loaded tiles ARE the evidence it paired with the Vexcel base.
console.log(`Esri label/road tiles fetched (200): ${esriTiles}`);
console.log(`screenshot: ${shot}`);
const ok = esriTiles > 0;
console.log(`\n${ok ? "✓ PASS" : "✗ FAIL"} — Vexcel basemap ${ok ? "has Esri street labels" : "missing labels"}`);
await browser.close();
process.exit(ok ? 0 : 1);
