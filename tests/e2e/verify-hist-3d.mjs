#!/usr/bin/env node
// Verify QLD Historical renders in 3D via its `_dwMb3DGetUrl` getter
// (direct {bbox-epsg-3857} exportImage URL — NOT the blob bridge), and
// that moving the capture scrubber while in 3D swaps the 3D source to
// the new capture's mosaicRule (lockRasterIds changes).
import { chromium } from "playwright";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..", "..");
const STATE = resolve(REPO, ".auth", "storage.json");
const REPORT_DIR = resolve(REPO, "test-results");
if (!existsSync(STATE)) { console.error("run npm run e2e:auth first"); process.exit(2); }

const browser = await chromium.launch({ headless: !process.env.HEADED, args: ["--disable-web-security", "--disable-features=IsolateOrigins,site-per-process"] });
const ctx = await browser.newContext({ storageState: STATE, viewport: { width: 1400, height: 900 } });
await ctx.addInitScript({ content: readFileSync(resolve(__dirname, "lib", "bootstrap.js"), "utf8") });
await ctx.addInitScript({ content: readFileSync(resolve(REPO, "dynamicwatch-custom-tiles.user.js"), "utf8") });
const page = await ctx.newPage();
await page.goto("https://dynamic.watch/plan", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForSelector(".leaflet-planner-controls", { timeout: 30000 });
const nuke = () => page.evaluate(() => { document.querySelectorAll(".modal,.modal-backdrop").forEach(e=>e.remove()); document.body.classList.remove("modal-open"); });
await nuke();
await page.waitForFunction(() => !!(window._dwLayerCtrl && window._dwLayerCtrl._map), { timeout: 15000 });
// Brisbane — deep QLD Historical coverage (captures back to the 1930s).
await page.evaluate(() => window._dwLayerCtrl._map.setView([-27.47, 153.03], 13));

// QLD Historical as base.
const set = await page.evaluate(() => {
	const map = window._dwLayerCtrl._map, ctrl = window._dwLayerCtrl;
	const find = (n) => ctrl._layers.find((l) => l.name === n)?.layer;
	const hist = find("QLD Historical");
	if (!hist) return { ok: false };
	ctrl._layers.filter((l) => !l.overlay).forEach((l) => {
		if (l.layer !== hist && map.hasLayer(l.layer)) map.removeLayer(l.layer);
	});
	if (!map.hasLayer(hist)) map.addLayer(hist);
	return { ok: true };
});
if (!set.ok) { console.error("QLD Historical not in registry"); await browser.close(); process.exit(1); }
console.log("✓ QLD Historical set as base (2D)");
// Let the capture catalog resolve (async query on add).
await page.waitForTimeout(5000);

await nuke();
await page.waitForSelector(".dw-3d-btn", { timeout: 10000 });
await page.evaluate(() => document.querySelector(".dw-3d-btn").click());
try { await page.waitForFunction(() => window._dwMb?.isStyleLoaded?.(), { timeout: 30000 }); } catch {}
await page.waitForTimeout(3000);

const readBase = () => page.evaluate(() => {
	const src = window._dwMb?.getStyle?.()?.sources?.["active-base"];
	const t = src?.tiles?.[0] || null;
	if (!t) return { tiles: null };
	const m = decodeURIComponent(t).match(/lockRasterIds..\[(\d+)\]/);
	return {
		isExportImage: t.includes("exportImage"),
		isSentinel: t.includes("dwtile.local"),
		oid: m ? m[1] : null,
		tiles: t.slice(0, 90),
	};
});
const before = await readBase();
console.log(`  3D base: exportImage=${before.isExportImage} sentinel=${before.isSentinel} lockRasterIds=${before.oid}`);
console.log(`    ${before.tiles}`);

// Move the scrubber back one capture while IN 3D.
const scrub = await page.evaluate(() => {
	const ctrl = window._dwLayerCtrl;
	const entry = ctrl._layers.find((l) => l.name === "QLD Historical");
	const lyr = entry?.layer;
	// The layer itself carries the capture API the history bar drives.
	if (!lyr || typeof lyr.setCapture !== "function") {
		return { ok: false, why: "layer has no setCapture" };
	}
	const count = lyr.getCaptureCount ? lyr.getCaptureCount() : -1;
	const cur = lyr.getCaptureIdx ? lyr.getCaptureIdx() : -1;
	if (count < 2) return { ok: false, why: `only ${count} captures` };
	const next = (cur + 1) % count;
	lyr.setCapture(next);
	return { ok: true, from: cur, to: next, count };
});
console.log(`  scrub: ${JSON.stringify(scrub)}`);
let after = { oid: null };
if (scrub.ok) {
	// capturechange → _wireReloadEvents → _fullResync (debounced) + new
	// catalog query for the new capture's OID. Give it time.
	await page.waitForTimeout(8000);
	after = await readBase();
	console.log(`  3D base after scrub: lockRasterIds=${after.oid}`);
}

if (!existsSync(REPORT_DIR)) mkdirSync(REPORT_DIR, { recursive: true });
const shot = resolve(REPORT_DIR, `verify-hist-3d-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
await nuke();
await page.screenshot({ path: shot });
console.log(`  screenshot: ${shot}`);

const renderOk = before.isExportImage && !before.isSentinel && before.oid;
const scrubOk = !scrub.ok || (after.oid && after.oid !== before.oid);
const ok = renderOk && scrubOk;
console.log(`\n  render via getter: ${renderOk ? "✓" : "✗"}   scrub swaps capture: ${scrub.ok ? (scrubOk ? "✓" : "✗ (OID unchanged — stale!)") : "skipped: " + scrub.why}`);
console.log(`${ok ? "✓ PASS" : "✗ FAIL"} — QLD Historical 3D`);
await browser.close();
process.exit(ok ? 0 : 1);
