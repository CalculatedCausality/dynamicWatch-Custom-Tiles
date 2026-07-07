#!/usr/bin/env node
// Verify the Vexcel Aerial base renders in 2D (WMTS getTile 200s) and
// in 3D (direct CORS raster source — no blob bridge needed since
// api.vexcelgroup.com sends Access-Control-Allow-Origin: *).
//
// Needs a fresh Vexcel JWT (they expire ~daily):
//   VEXCEL_TOKEN=<jwt-or-any-url-containing-token=> npm run e2e:vexcel
// The token is seeded into the GM store so the layer's paste-prompt
// never fires during the run.
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
if (!TOKEN) { console.error("set VEXCEL_TOKEN (jwt or URL containing token=)"); process.exit(2); }
try {
	const exp = JSON.parse(Buffer.from(TOKEN.split(".")[1], "base64url").toString()).exp * 1000;
	if (exp < Date.now()) { console.error(`VEXCEL_TOKEN expired ${new Date(exp).toISOString()}`); process.exit(2); }
	console.log(`token ok, expires ${new Date(exp).toISOString()}`);
} catch { console.error("VEXCEL_TOKEN does not decode as a JWT"); process.exit(2); }

const browser = await chromium.launch({
	headless: !process.env.HEADED,
	args: ["--disable-web-security", "--disable-features=IsolateOrigins,site-per-process"],
});
const context = await browser.newContext({ storageState: STATE_PATH, viewport: { width: 1400, height: 900 } });

let tileReqs = 0, tile200 = 0, tileOther = 0;
context.on("response", (resp) => {
	const u = resp.url();
	if (u.includes("api.vexcelgroup.com") && u.includes("request=getTile")) {
		tileReqs++;
		if (resp.status() === 200) tile200++;
		else tileOther++;
	}
});

await context.addInitScript({ content: readFileSync(resolve(__dirname, "lib", "bootstrap.js"), "utf8") });
// Seed the token into the GM store (localStorage-backed shim) so the
// layer builds its WMTS URL immediately instead of prompting.
await context.addInitScript({ content:
	`try { localStorage.setItem("GM:dw_vexcel_token", ${JSON.stringify(JSON.stringify(TOKEN))}); } catch (_) {}` });
await context.addInitScript({ content: readFileSync(resolve(REPO_ROOT, "dynamicwatch-custom-tiles.user.js"), "utf8") });

const page = await context.newPage();
const logs = [];
page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`));
page.on("dialog", async (d) => {
	logs.push(`DIALOG (unexpected): ${d.message().slice(0, 80)}`);
	await d.dismiss();
});

await page.goto("https://dynamic.watch/plan", { waitUntil: "domcontentloaded", timeout: 45_000 });
await page.waitForSelector(".leaflet-planner-controls", { timeout: 30_000 });
const nukeModal = () => page.evaluate(() => {
	document.querySelectorAll(".modal, .modal-backdrop").forEach(el => el.remove());
	document.body.classList.remove("modal-open"); document.body.style.overflow = "";
});
await nukeModal();
await page.waitForFunction(() => !!(window._dwLayerCtrl && window._dwLayerCtrl._map), { timeout: 15_000 });
// Urban-program coverage (Sunshine Coast, flown 2019-2025).
await page.evaluate(() => window._dwLayerCtrl._map.setView([-26.607, 153.006], 17));

const set = await page.evaluate(() => {
	const map = window._dwLayerCtrl._map, ctrl = window._dwLayerCtrl;
	const find = (n) => ctrl._layers.find((l) => l.name === n)?.layer;
	const vex = find("Vexcel Aerial");
	if (!vex) return { ok: false, names: ctrl._layers.filter(l => !l.overlay).map(l => l.name) };
	ctrl._layers.filter((l) => !l.overlay).forEach((l) => {
		if (l.layer !== vex && map.hasLayer(l.layer)) map.removeLayer(l.layer);
	});
	if (!map.hasLayer(vex)) map.addLayer(vex);
	return { ok: true, url: vex._url };
});
if (!set.ok) { console.error("Vexcel Aerial not in registry:", set.names); await browser.close(); process.exit(1); }
if (!/api\.vexcelgroup\.com/.test(set.url)) {
	console.error("layer URL is not the WMTS template (token seeding failed?):", set.url);
	await browser.close(); process.exit(1);
}
console.log("✓ Vexcel Aerial set as base (2D), WMTS template active");
await page.waitForTimeout(4000);
const reqs2d = tile200;

// Toggle 3D.
await nukeModal();
await page.waitForSelector(".dw-3d-btn", { timeout: 10_000 });
await page.evaluate(() => document.querySelector(".dw-3d-btn").click());
try { await page.waitForFunction(() => window._dwMb?.isStyleLoaded?.(), { timeout: 30_000 }); } catch {}
await page.waitForTimeout(5000);

const state = await page.evaluate(() => {
	const mb = window._dwMb;
	if (!mb) return { error: "no _dwMb" };
	const src = mb.getStyle().sources["active-base"];
	const baseTiles = src && src.tiles ? src.tiles[0] : null;
	return {
		baseTiles: baseTiles && baseTiles.replace(/token=[^&]+/, "token=…"),
		directVexcel: !!(baseTiles && baseTiles.includes("api.vexcelgroup.com") &&
			baseTiles.includes("request=getTile")),
	};
});

await nukeModal();
await page.waitForTimeout(300);
if (!existsSync(REPORT_DIR)) mkdirSync(REPORT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const shot = resolve(REPORT_DIR, `verify-vexcel-${stamp}.png`);
await page.screenshot({ path: shot });

console.log("\n=== Vexcel Aerial verification ===");
console.log(`  2D getTile 200s: ${reqs2d}`);
console.log(`  total getTile: ${tileReqs} (200: ${tile200}, other: ${tileOther})`);
console.log(`  3D active-base: ${state.baseTiles}`);
console.log(`  3D uses direct Vexcel WMTS: ${state.directVexcel}`);
console.log(`  screenshot: ${shot}`);
const vLogs = logs.filter((l) => /vexcel|DIALOG/i.test(l));
if (vLogs.length) { console.log("  logs:"); vLogs.slice(-6).forEach((l) => console.log("    " + l)); }

const ok = reqs2d > 0 && state.directVexcel && tile200 > reqs2d;
console.log(`\n${ok ? "✓ PASS" : "✗ FAIL"} — Vexcel Aerial ${ok ? "renders in 2D and 3D" : "did NOT fully render"}`);
await browser.close();
process.exit(ok ? 0 : 1);
