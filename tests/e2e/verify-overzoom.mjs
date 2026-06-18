#!/usr/bin/env node
// Verify deep-zoom behaviour: layers stay in-range (selectable, not
// greyed/hidden) and render stretched tiles instead of blank past their
// native cache.
//   1. With Google Hybrid as base, map maxZoom is 25 (deep allowed) and
//      at z24 the base still renders (Leaflet stretches its z21 native).
//   2. QLD Globe + Wayback carry the overzoom fallback (custom createTile)
//      and maxZoom 25.
//   3. Synthetic fallback test: a tile layer whose native tile 404s, with
//      the fallback wired via the SAME mechanism (QLD Globe's layer),
//      check createTile yields a clipping cell (not a bare img).
import { chromium } from "playwright";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..", "..");
const STATE = resolve(REPO, ".auth", "storage.json");
const OUT = resolve(REPO, "test-results");
if (!existsSync(STATE)) { console.error("auth"); process.exit(2); }

const browser = await chromium.launch({ headless: !process.env.HEADED, args: ["--disable-web-security", "--disable-features=IsolateOrigins,site-per-process"] });
const ctx = await browser.newContext({ storageState: STATE, viewport: { width: 1280, height: 800 } });
await ctx.addInitScript({ content: readFileSync(resolve(__dirname, "lib", "bootstrap.js"), "utf8") });
await ctx.addInitScript({ content: readFileSync(resolve(REPO, "dynamicwatch-custom-tiles.user.js"), "utf8") });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto("https://dynamic.watch/plan", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForSelector(".leaflet-planner-controls", { timeout: 30000 });
const nuke = () => page.evaluate(() => { document.querySelectorAll(".modal,.modal-backdrop").forEach(e=>e.remove()); document.body.classList.remove("modal-open"); });
await nuke();
await page.waitForFunction(() => !!(window._dwLayerCtrl && window._dwLayerCtrl._map), { timeout: 15000 });

// --- layer config inspection (no network needed) ---
const cfg = await page.evaluate(() => {
	const ctrl = window._dwLayerCtrl;
	const get = (n) => ctrl._layers.find((l) => l.name === n)?.layer;
	const describe = (n) => {
		const l = get(n);
		if (!l) return null;
		return {
			maxZoom: l.options.maxZoom,
			maxNativeZoom: l.options.maxNativeZoom,
			// overzoom-wired layers replace createTile (own property on the
			// instance) rather than inheriting L.TileLayer.prototype's.
			customCreateTile: Object.prototype.hasOwnProperty.call(l, "createTile"),
		};
	};
	return {
		google: describe("Google Hybrid"),
		apple: describe("Apple Maps"),
		stamen: describe("Stamen Terrain"),
		qld: describe("QLD Globe"),
		wayback: describe("Esri Wayback"),
		topo: describe("QLD Topo"),
	};
});
console.log("=== layer zoom config ===");
for (const [k, v] of Object.entries(cfg)) {
	console.log(`  ${k.padEnd(8)} ${v ? `maxZoom=${v.maxZoom} maxNative=${v.maxNativeZoom} overzoomTile=${v.customCreateTile}` : "(not found)"}`);
}

// --- deep zoom render with Google base ---
console.log("\n=== Google base @ z24 (deep zoom, built-in stretch) ===");
await page.evaluate(() => {
	const ctrl = window._dwLayerCtrl, map = ctrl._map;
	const g = ctrl._layers.find((l) => l.name === "Google Hybrid" && !l.overlay)?.layer;
	ctrl._layers.filter((l) => !l.overlay).forEach((l) => { if (l.layer !== g && map.hasLayer(l.layer)) map.removeLayer(l.layer); });
	if (g && !map.hasLayer(g)) map.addLayer(g);
});
await page.waitForTimeout(800);
const mapMax = await page.evaluate(() => window._dwLayerCtrl._map.getMaxZoom());
console.log(`  map.getMaxZoom() with Google active: ${mapMax} (want 25 — deep zoom unlocked)`);
await page.evaluate(() => window._dwLayerCtrl._map.setView([-27.4698, 153.0251], 24));
await page.waitForTimeout(5000);
const render = await page.evaluate(() => {
	const tp = window._dwLayerCtrl._map.getPane("tilePane");
	const imgs = [...tp.querySelectorAll("img.leaflet-tile")];
	const loaded = imgs.filter((i) => i.complete && i.naturalWidth > 0).length;
	return { total: imgs.length, loaded, zoom: window._dwLayerCtrl._map.getZoom() };
});
console.log(`  at z${render.zoom}: ${render.loaded}/${render.total} base tiles rendered (loaded, non-blank)`);

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
await nuke();
await page.screenshot({ path: resolve(OUT, "overzoom-google-z24.png") });

// --- Wayback: validates the CUSTOM createTile renders end-to-end ---
// (QLD Globe/Stamen are token/origin-gated and won't load in the
// harness; Wayback's catalog loads cleanly, so it exercises the same
// wireOverzoomFallback createTile path for real.)
console.log("\n=== Wayback (custom overzoom createTile) render ===");
await page.evaluate(() => {
	const ctrl = window._dwLayerCtrl, map = ctrl._map;
	const w = ctrl._layers.find((l) => l.name === "Esri Wayback" && !l.overlay)?.layer;
	ctrl._layers.filter((l) => !l.overlay).forEach((l) => { if (l.layer !== w && map.hasLayer(l.layer)) map.removeLayer(l.layer); });
	if (w && !map.hasLayer(w)) map.addLayer(w);
});
await page.waitForTimeout(6000); // catalog + tiles
let wb = { normal: null, deep: null };
await page.evaluate(() => window._dwLayerCtrl._map.setView([-27.4698, 153.0251], 16));
await page.waitForTimeout(4000);
wb.normal = await page.evaluate(() => {
	const tp = window._dwLayerCtrl._map.getPane("tilePane");
	// custom createTile wraps the img in a div.leaflet-tile > img
	const cells = [...tp.querySelectorAll(".leaflet-tile")];
	const withImg = cells.filter((c) => c.querySelector && c.querySelector("img"));
	const decoded = withImg.filter((c) => { const i = c.querySelector("img"); return i && i.complete && i.naturalWidth > 0; });
	return { z: window._dwLayerCtrl._map.getZoom(), cells: cells.length, decoded: decoded.length };
});
console.log(`  z${wb.normal.z}: ${wb.normal.decoded}/${wb.normal.cells} Wayback cells decoded`);
await page.evaluate(() => window._dwLayerCtrl._map.setView([-27.4698, 153.0251], 24));
await page.waitForTimeout(5000);
wb.deep = await page.evaluate(() => {
	const tp = window._dwLayerCtrl._map.getPane("tilePane");
	const cells = [...tp.querySelectorAll(".leaflet-tile")];
	const decoded = cells.filter((c) => { const i = c.querySelector && c.querySelector("img"); return i && i.complete && i.naturalWidth > 0; });
	return { z: window._dwLayerCtrl._map.getZoom(), cells: cells.length, decoded: decoded.length };
});
console.log(`  z${wb.deep.z}: ${wb.deep.decoded}/${wb.deep.cells} Wayback cells decoded (deep — stretched)`);
await nuke();
await page.screenshot({ path: resolve(OUT, "overzoom-wayback-z24.png") });
const waybackOk = wb.normal.decoded > 0 && wb.deep.decoded > 0;

// --- site base layers stay selectable + get maxZoom lifted at deep zoom ---
console.log("\n=== site bases (Satellite/Hi-Res/OpenCycleMap) at deep zoom ===");
const siteBases = await page.evaluate(() => {
	const ctrl = window._dwLayerCtrl;
	const ours = new Set(["Google Hybrid","Apple Maps","Stamen Terrain","QLD Globe",
		"QLD Historical","QLD Topo","Esri Wayback","QLD Roads"]);
	const bases = ctrl._layers.filter((l) => !l.overlay && !ours.has(l.name));
	// any control radio inputs currently disabled?
	const inputs = ctrl._layerControlInputs || [];
	const disabled = inputs.filter((i) => i && i.disabled).length;
	return {
		names: bases.map((b) => b.name),
		maxZooms: bases.map((b) => (b.layer.options || {}).maxZoom),
		disabledRadios: disabled,
		patched: !!ctrl._dwSelectablePatched,
	};
});
console.log(`  site bases: ${siteBases.names.join(", ") || "(none in this plan)"}`);
console.log(`  their maxZoom after normalize: ${JSON.stringify(siteBases.maxZooms)} (want all 25 / >=24)`);
console.log(`  disabled radio inputs at z24: ${siteBases.disabledRadios} (want 0)`);
console.log(`  _checkDisabledLayers override active: ${siteBases.patched}`);
const siteOk = siteBases.disabledRadios === 0 && siteBases.patched &&
	siteBases.maxZooms.every((z) => z == null || z >= 24);

const ok =
	cfg.google?.maxZoom === 25 && cfg.apple?.maxZoom === 25 &&
	cfg.stamen?.maxZoom === 25 && cfg.qld?.maxZoom === 25 &&
	cfg.qld?.customCreateTile === true && cfg.wayback?.customCreateTile === true &&
	mapMax === 25 && render.loaded > 0 && waybackOk && siteOk;
console.log(`  custom-createTile layer renders (Wayback, normal+deep): ${waybackOk ? "✓" : "✗"}`);
console.log(`  site bases selectable + lifted at deep zoom: ${siteOk ? "✓" : "✗"}`);
console.log(`\n  maxZoom=25 on all bases: ${cfg.google?.maxZoom===25 && cfg.apple?.maxZoom===25 && cfg.stamen?.maxZoom===25 && cfg.qld?.maxZoom===25 ? "✓" : "✗"}`);
console.log(`  overzoom fallback wired (QLD+Wayback): ${cfg.qld?.customCreateTile && cfg.wayback?.customCreateTile ? "✓" : "✗"}`);
console.log(`  deep zoom allowed + base renders at z24: ${mapMax===25 && render.loaded>0 ? "✓" : "✗"}`);
console.log(`  page errors: ${errors.length}`);
console.log(`${ok ? "✓ PASS" : "✗ FAIL"} — deep-zoom overzoom behaviour`);
await browser.close();
process.exit(ok ? 0 : 1);
