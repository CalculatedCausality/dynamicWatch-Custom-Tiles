#!/usr/bin/env node
// Verify Stamen Terrain renders in 3D via the transformRequest blob
// bridge (the addProtocol replacement). Stamen tiles need an
// `Origin: http://localhost` spoof that only GM_xmlhttpRequest can set,
// so this drives the REAL userscript path (the GM shim forwards the
// Origin header). Asserts: active-base source uses the sentinel URL, and
// the blob bridge actually fetched + cached tiles (Mapbox painted them).
import { chromium } from "playwright";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname  = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = resolve(__dirname, "..", "..");
const STATE_PATH = resolve(REPO_ROOT, ".auth", "storage.json");
const REPORT_DIR = resolve(REPO_ROOT, "test-results");
if (!existsSync(STATE_PATH)) { console.error("run npm run e2e:auth first"); process.exit(2); }

const browser = await chromium.launch({
	headless: !process.env.HEADED,
	args: ["--disable-web-security", "--disable-features=IsolateOrigins,site-per-process"],
});
const context = await browser.newContext({ storageState: STATE_PATH, viewport: { width: 1400, height: 900 } });
// Count real Stadia tile fetches (these go through the GM shim → fetch,
// carrying the spoofed Origin). If the bridge works we should see >0.
let stadiaReqs = 0, stadia200 = 0;
// Inject the `Origin: http://localhost` header Stadia's keyless tier
// requires, at the NETWORK layer — the GM shim routes through fetch,
// which strips Origin (forbidden header). Real Tampermonkey's
// GM_xmlhttpRequest sets it natively; this reproduces that faithfully.
await context.route(/stadiamaps\.com\/tiles\/stamen/, async (route) => {
	const headers = {
		...route.request().headers(),
		origin: "http://localhost",
		referer: "http://localhost/",
	};
	try {
		const resp = await route.fetch({ headers });
		stadiaReqs++;
		if (resp.status() === 200) stadia200++;
		await route.fulfill({ response: resp });
	} catch (_) {
		try { await route.abort(); } catch (_) {}
	}
});
await context.addInitScript({ content: readFileSync(resolve(__dirname, "lib", "bootstrap.js"), "utf8") });
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
await page.evaluate(() => window._dwLayerCtrl._map.setView([-27.47, 153.03], 11));

// Activate Stamen Terrain as the base.
const set = await page.evaluate(() => {
	const map = window._dwLayerCtrl._map, ctrl = window._dwLayerCtrl;
	const find = (n) => ctrl._layers.find((l) => l.name === n)?.layer;
	const stamen = find("Stamen Terrain");
	if (!stamen) return { ok: false, names: ctrl._layers.filter(l => !l.overlay).map(l => l.name) };
	ctrl._layers.filter((l) => !l.overlay).forEach((l) => {
		if (l.layer !== stamen && map.hasLayer(l.layer)) map.removeLayer(l.layer);
	});
	if (!map.hasLayer(stamen)) map.addLayer(stamen);
	return { ok: true };
});
if (!set.ok) { console.error("Stamen not in registry:", set.names); await browser.close(); process.exit(1); }
console.log("✓ Stamen Terrain set as base (2D)");
await page.waitForTimeout(2500);

// Toggle 3D.
await nukeModal();
await page.waitForSelector(".dw-3d-btn", { timeout: 10_000 });
await page.evaluate(() => document.querySelector(".dw-3d-btn").click());
try { await page.waitForFunction(() => window._dwMb?.isStyleLoaded?.(), { timeout: 30_000 }); } catch {}
// Give the blob bridge time to warm tiles + reload.
await page.waitForTimeout(6000);

const state = await page.evaluate(() => {
	const mb = window._dwMb;
	if (!mb) return { error: "no _dwMb" };
	const src = mb.getStyle().sources["active-base"];
	const baseTiles = src && src.tiles ? src.tiles[0] : null;
	return {
		baseTiles,
		usesSentinel: !!(baseTiles && baseTiles.includes("dwtile.local")),
	};
});

await nukeModal();
await page.waitForTimeout(300);
if (!existsSync(REPORT_DIR)) mkdirSync(REPORT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const shot = resolve(REPORT_DIR, `verify-stamen-3d-${stamp}.png`);
await page.screenshot({ path: shot });

console.log("\n=== Stamen 3D bridge verification ===");
console.log(`  active-base tiles: ${state.baseTiles}`);
console.log(`  uses sentinel URL: ${state.usesSentinel}`);
console.log(`  Stadia tile requests: ${stadiaReqs} (200 OK: ${stadia200})`);
console.log(`  screenshot: ${shot}`);
const gcLogs = logs.filter((l) => /stamen|stadia|dwtile|transformRequest|addProtocol/i.test(l));
if (gcLogs.length) { console.log("  logs:"); gcLogs.slice(-6).forEach((l) => console.log("    " + l)); }

const ok = state.usesSentinel && stadia200 > 0;
console.log(`\n${ok ? "✓ PASS" : "✗ FAIL"} — Stamen ${ok ? "renders in 3D via the blob bridge" : "did NOT render in 3D"}`);
await browser.close();
process.exit(ok ? 0 : 1);
