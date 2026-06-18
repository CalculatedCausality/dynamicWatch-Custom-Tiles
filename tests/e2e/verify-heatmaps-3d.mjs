#!/usr/bin/env node
// Verify Strava + Garmin heatmaps render in 3D WHEN TOGGLED ON while
// already in 3D (the reported "doesn't show until you cycle 3D" bug).
// Both route through the GM blob bridge now, so we assert each gets a
// sentinel-backed raster source after a toggle-on in 3D, and that real
// tiles fetch (200) through the bridge.
import { chromium } from "playwright";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..", "..");
const STATE = resolve(REPO, ".auth", "storage.json");
if (!existsSync(STATE)) { console.error("run npm run e2e:auth first"); process.exit(2); }

const browser = await chromium.launch({ headless: !process.env.HEADED, args: ["--disable-web-security", "--disable-features=IsolateOrigins,site-per-process"] });
const ctx = await browser.newContext({ storageState: STATE, viewport: { width: 1400, height: 900 } });
const reqs = { strava: 0, garmin: 0 };
ctx.on("response", (r) => {
	const u = r.url();
	if (u.includes("strava.com") && r.status() === 200) reqs.strava++;
	if (u.includes("garmin.com") && r.status() === 200) reqs.garmin++;
});
// Inject the parsed @connect list so the GM shim can flag requests real
// Tampermonkey would block (the shim itself enforces nothing — that gap
// hid the missing `@connect strava.com` that broke Strava-in-3D in
// production while every harness run passed).
const userscriptSrc = readFileSync(resolve(REPO, "dynamicwatch-custom-tiles.user.js"), "utf8");
const connectList = [...userscriptSrc.matchAll(/^\/\/ @connect\s+(\S+)/gm)].map((m) => m[1]);
await ctx.addInitScript({ content: `window.__dwConnectList = ${JSON.stringify(connectList)};` });
await ctx.addInitScript({ content: readFileSync(resolve(__dirname, "lib", "bootstrap.js"), "utf8") });
await ctx.addInitScript({ content: userscriptSrc });
const page = await ctx.newPage();
const connectViolations = [];
page.on("console", (m) => {
	if (m.text().includes("@connect VIOLATION")) connectViolations.push(m.text());
});
await page.goto("https://dynamic.watch/plan/2344645", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForSelector(".leaflet-planner-controls", { timeout: 30000 });
const nuke = () => page.evaluate(() => { document.querySelectorAll(".modal,.modal-backdrop").forEach(e=>e.remove()); document.body.classList.remove("modal-open"); });
await nuke();
await page.waitForFunction(() => !!(window._dwLayerCtrl && window._dwLayerCtrl._map), { timeout: 15000 });
await page.evaluate(() => window._dwLayerCtrl._map.setView([-27.47, 153.03], 11));

// Enter 3D FIRST (no heatmaps on), then toggle them — reproduces the bug.
await page.waitForSelector(".dw-3d-btn", { timeout: 10000 });
await page.evaluate(() => document.querySelector(".dw-3d-btn").click());
try { await page.waitForFunction(() => window._dwMb?.isStyleLoaded?.(), { timeout: 30000 }); } catch {}
await page.waitForTimeout(1500);
console.log("✓ 3D enabled (heatmaps off)");

const results = {};
for (const name of ["Strava Heatmap", "Garmin Heatmap"]) {
	await page.evaluate((n) => {
		const ctrl = window._dwLayerCtrl, map = ctrl._map;
		const e = ctrl._layers.find((l) => l.name === n && l.overlay);
		if (e && !map.hasLayer(e.layer)) map.addLayer(e.layer);
	}, name);
	// Wait for the full resync (needsFullResync) + bridge warm.
	await page.waitForTimeout(7000);
	const probe = await page.evaluate((n) => {
		const mb = window._dwMb, ctrl = window._dwLayerCtrl;
		const entry = ctrl._layers.find((l) => l.name === n && l.overlay);
		const key = entry?.layer?._dwMbKey;
		const style = mb.getStyle();
		let found = null;
		for (const [id, src] of Object.entries(style.sources)) {
			const t = (src.tiles || [])[0] || "";
			if (key && t.includes("dwtile.local/" + key + "/")) { found = id; break; }
		}
		return { key, found };
	}, name);
	results[name] = probe;
	console.log(`  ${name}: bridgeKey=${probe.key} mirrored=${!!probe.found ? "YES (" + probe.found + ")" : "NO"}`);
}

console.log(`\n  Strava tiles fetched (200): ${reqs.strava}`);
console.log(`  Garmin tiles fetched (200): ${reqs.garmin}`);
if (connectViolations.length) {
	console.log(`  @connect violations (${connectViolations.length}):`);
	[...new Set(connectViolations)].slice(0, 5).forEach((v) => console.log("    " + v));
}
const ok = results["Strava Heatmap"]?.found && results["Garmin Heatmap"]?.found &&
	reqs.strava > 0 && reqs.garmin > 0 &&
	connectViolations.length === 0;
console.log(`\n${ok ? "✓ PASS" : "✗ FAIL"} — heatmaps ${ok ? "mirror + fetch when toggled on in 3D" : "did NOT render when toggled in 3D"}`);
await browser.close();
process.exit(ok ? 0 : 1);
