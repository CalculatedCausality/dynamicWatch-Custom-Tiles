#!/usr/bin/env node
// Verify the Vexcel oblique viewer end-to-end: with the Vexcel base
// active, the location popup exposes the "Oblique views" button; the
// oriented/query returns captures; and an extract pull paints a real
// image into the viewer. Exercises the token-only oblique path (no
// session), including the direction + date model.
//
//   VEXCEL_TOKEN=<jwt-or-url> npm run e2e:vexcel-oblique
import { chromium } from "playwright";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname  = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = resolve(__dirname, "..", "..");
const STATE_PATH = resolve(REPO_ROOT, ".auth", "storage.json");
const REPORT_DIR = resolve(REPO_ROOT, "test-results");
if (!existsSync(STATE_PATH)) { console.error("run npm run e2e:auth first"); process.exit(2); }

const rawTok = process.env.VEXCEL_TOKEN || "";
const tokMatch =
	rawTok.match(/token=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/) ||
	rawTok.match(/^([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/);
const TOKEN = tokMatch ? tokMatch[1] : "";
if (!TOKEN) { console.error("set VEXCEL_TOKEN"); process.exit(2); }
try {
	const exp = JSON.parse(Buffer.from(TOKEN.split(".")[1], "base64url").toString()).exp * 1000;
	if (exp < Date.now()) { console.error(`token expired ${new Date(exp).toISOString()}`); process.exit(2); }
} catch { console.error("VEXCEL_TOKEN not a JWT"); process.exit(2); }

const browser = await chromium.launch({
	headless: !process.env.HEADED,
	args: ["--disable-web-security", "--disable-features=IsolateOrigins,site-per-process"],
});
const context = await browser.newContext({ storageState: STATE_PATH, viewport: { width: 1400, height: 900 } });

let queryOk = false, tile200 = 0, tileOther = 0;
context.on("response", (resp) => {
	const u = resp.url();
	if (u.includes("/v2/oriented/query")) queryOk = queryOk || resp.status() === 200;
	if (u.includes("/v2/oriented/tile")) {
		if (resp.status() === 200) tile200++; else tileOther++;
	}
});

await context.addInitScript({ content: readFileSync(resolve(__dirname, "lib", "bootstrap.js"), "utf8") });
await context.addInitScript({ content:
	`try { localStorage.setItem("GM:dw_vexcel_token", ${JSON.stringify(JSON.stringify(TOKEN))}); } catch (_) {}` });
await context.addInitScript({ content: readFileSync(resolve(REPO_ROOT, "dynamicwatch-custom-tiles.user.js"), "utf8") });

const page = await context.newPage();
const logs = [];
page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`));

await page.goto("https://dynamic.watch/plan", { waitUntil: "domcontentloaded", timeout: 45_000 });
await page.waitForSelector(".leaflet-planner-controls", { timeout: 30_000 });
const nukeModal = () => page.evaluate(() => {
	document.querySelectorAll(".modal, .modal-backdrop").forEach(el => el.remove());
	document.body.classList.remove("modal-open"); document.body.style.overflow = "";
});
await nukeModal();
await page.waitForFunction(() => !!(window._dwLayerCtrl && window._dwLayerCtrl._map), { timeout: 15_000 });
await page.evaluate(() => window._dwLayerCtrl._map.setView([-26.607, 153.006], 17));

// Activate the Vexcel base — the docked imagery control appears
// automatically (the counterpart to the QLD Historical compass), no
// popup click needed.
const set = await page.evaluate(() => {
	const map = window._dwLayerCtrl._map, ctrl = window._dwLayerCtrl;
	const vex = ctrl._layers.find((l) => l.name === "Vexcel Aerial")?.layer;
	if (!vex) return { ok: false };
	ctrl._layers.filter((l) => !l.overlay).forEach((l) => {
		if (l.layer !== vex && map.hasLayer(l.layer)) map.removeLayer(l.layer);
	});
	if (!map.hasLayer(vex)) map.addLayer(vex);
	return { ok: true };
});
if (!set.ok) { console.error("Vexcel base missing"); await browser.close(); process.exit(1); }

// The compass docks on its own; dates ride the SHARED history bar.
const hasCtl = await page.waitForSelector(".dw-vex-ctl", { timeout: 10_000 }).then(() => true).catch(() => false);
console.log(`docked compass present: ${hasCtl}`);
// Wait for the history bar to populate with captures (query on add).
await page.waitForFunction(() => {
	const s = document.querySelector(".dw-history-slider");
	return s && Number(s.max) >= 1;
}, { timeout: 15_000 }).catch(() => {});

// Click a direction — that's what triggers the on-demand image pull.
await page.evaluate(() => {
	const east = document.querySelector('.dw-vex-ctl .dw-vex-dir[data-dir="oblique-east"]');
	if (east) east.click();
});

// Wait for the tile pyramid to render chunks (progressive load), then
// give it a moment to fill the visible grid.
await page.waitForFunction(() => {
	const t = document.querySelectorAll(".dw-vex-tilemap .leaflet-tile-loaded");
	return t.length >= 2;
}, { timeout: 30_000 }).catch(() => {});
await page.waitForTimeout(6000);

const viewer = await page.evaluate(() => {
	const el = document.querySelector(".dw-vex-ctl");
	if (!el) return { present: false };
	const dirs = [...el.querySelectorAll(".dw-vex-dir")].map((b) => b.dataset.dir);
	const slider = document.querySelector(".dw-history-slider");
	const captureCount = slider ? Number(slider.max) + 1 : 0;
	const ov = document.querySelector(".dw-vex-overlay");
	const tiles = document.querySelectorAll(".dw-vex-tilemap .leaflet-tile-loaded").length;
	const msg = ov && ov.querySelector(".dw-vex-msg");
	return {
		present: !!el,
		dirs,
		dates: Array.from({ length: captureCount }, (_, i) => String(i)),
		sliderEnabled: slider && !slider.disabled,
		year: (document.querySelector(".dw-history-bar-label") || {}).textContent,
		tilesLoaded: tiles,
		imgShown: tiles > 0,
		msg: msg && msg.style.display !== "none" ? msg.textContent : "",
	};
});

if (!existsSync(REPORT_DIR)) mkdirSync(REPORT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const shot = resolve(REPORT_DIR, `verify-vexcel-oblique-${stamp}.png`);
await page.screenshot({ path: shot });

console.log("\n=== Vexcel imagery control verification ===");
console.log(`  oriented/query 200:  ${queryOk}`);
console.log(`  oriented/tile 200: ${tile200}  (other: ${tileOther})`);
console.log(`  control directions: ${JSON.stringify(viewer.dirs)}`);
console.log(`  capture slider steps: ${viewer.dates.length} (enabled: ${viewer.sliderEnabled}, year: ${viewer.year})`);
console.log(`  tiles rendered: ${viewer.tilesLoaded}  msg: "${viewer.msg}"`);
console.log(`  screenshot: ${shot}`);

// PASS if the compass + shared history bar populated and the oblique
// rendered as a CHUNKED tile pyramid (multiple /v2/oriented/tile 200s).
const modelOk = viewer.present && viewer.dirs.filter((d) => /oblique|nadir/.test(d)).length >= 4 && viewer.dates.length >= 2;
const tilesOk = tile200 >= 2 && viewer.tilesLoaded >= 2;
const ok = queryOk && modelOk && tilesOk;
console.log(`\n${ok ? "✓ PASS" : "✗ FAIL"} — Vexcel oblique ${ok ? "renders as chunked tiles (pan/zoom)" : "did not fully verify"}`);
await browser.close();
process.exit(ok ? 0 : 1);
