#!/usr/bin/env node
// Centre on the Sunshine Coast, then cycle the Vexcel compass through
// EVERY direction (N, E, S, W, ⊙ nadir), waiting for each stitched
// oblique to actually paint and screenshotting the panel each time.
// Emits one PNG per angle (cropped to the control) plus a per-angle
// verdict, so the result can be eyeballed.
//
//   VEXCEL_TOKEN=<jwt-or-url> npm run e2e:vexcel-angles
import { chromium } from "playwright";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname  = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = resolve(__dirname, "..", "..");
const STATE_PATH = resolve(REPO_ROOT, ".auth", "storage.json");
const REPORT_DIR = resolve(REPO_ROOT, "test-results", "vexcel-angles");
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

const ANGLES = [
	{ dir: "oblique-north", label: "N" },
	{ dir: "oblique-east",  label: "E" },
	{ dir: "oblique-south", label: "S" },
	{ dir: "oblique-west",  label: "W" },
	{ dir: "nadir",         label: "Top" },
];

const browser = await chromium.launch({
	headless: !process.env.HEADED,
	args: ["--disable-web-security", "--disable-features=IsolateOrigins,site-per-process"],
});
const context = await browser.newContext({ storageState: STATE_PATH, viewport: { width: 1400, height: 900 } });

// Track per-angle extract outcomes by the image-name direction token.
const extractLog = [];
context.on("response", (resp) => {
	const u = resp.url();
	if (u.includes("/v2/oriented/extract")) {
		extractLog.push({ status: resp.status(), url: u });
	}
});

await context.addInitScript({ content: readFileSync(resolve(__dirname, "lib", "bootstrap.js"), "utf8") });
await context.addInitScript({ content:
	`try { localStorage.setItem("GM:dw_vexcel_token", ${JSON.stringify(JSON.stringify(TOKEN))}); } catch (_) {}` });
await context.addInitScript({ content: readFileSync(resolve(REPO_ROOT, "dynamicwatch-custom-tiles.user.js"), "utf8") });

const page = await context.newPage();
await page.goto("https://dynamic.watch/plan", { waitUntil: "domcontentloaded", timeout: 45_000 });
await page.waitForSelector(".leaflet-planner-controls", { timeout: 30_000 });
const nukeModal = () => page.evaluate(() => {
	document.querySelectorAll(".modal, .modal-backdrop").forEach(el => el.remove());
	document.body.classList.remove("modal-open"); document.body.style.overflow = "";
});
await nukeModal();
await page.waitForFunction(() => !!(window._dwLayerCtrl && window._dwLayerCtrl._map), { timeout: 15_000 });

// Centre on the Sunshine Coast (Nambour / Buderim hinterland — dense
// Vexcel urban coverage, 2019–2025 captures).
await page.evaluate(() => window._dwLayerCtrl._map.setView([-26.607, 153.006], 17));

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
await page.waitForSelector(".dw-vex-ctl", { timeout: 10_000 });
await nukeModal();

if (!existsSync(REPORT_DIR)) mkdirSync(REPORT_DIR, { recursive: true });

const results = [];
for (const a of ANGLES) {
	await nukeModal();
	// Record the current blob src so we can detect the NEW paint — each
	// load mints a fresh object URL, so src always changes on success.
	const prevSrc = await page.evaluate(() => {
		const img = document.querySelector(".dw-vex-overlay .dw-vex-img");
		return img ? img.src : "";
	});
	const beforeExtracts = extractLog.length;
	const clicked = await page.evaluate((dir) => {
		const b = document.querySelector(`.dw-vex-ctl .dw-vex-dir[data-dir="${dir}"]`);
		if (b) { b.click(); return true; }
		return false;
	}, a.dir);

	// Wait for a FRESH image (different src) to finish decoding.
	const painted = await page.waitForFunction((prev) => {
		const img = document.querySelector(".dw-vex-overlay .dw-vex-img");
		return img && img.style.display !== "none" && img.complete &&
			img.naturalWidth > 0 && img.src && img.src !== prev;
	}, prevSrc, { timeout: 60_000 }).then(() => true).catch(() => false);

	const info = await page.evaluate(() => {
		const ctl = document.querySelector(".dw-vex-ctl");
		const ov  = document.querySelector(".dw-vex-overlay");
		const img = ov.querySelector(".dw-vex-img");
		const msg = ov.querySelector(".dw-vex-msg");
		const on  = ctl.querySelector(".dw-vex-dir--on");
		return {
			activeDir: on ? on.dataset.dir : null,
			year: (document.querySelector(".dw-history-bar-label") || {}).textContent,
			overlayShown: ov.style.display !== "none",
			natW: img ? img.naturalWidth : 0,
			natH: img ? img.naturalHeight : 0,
			imgShown: img && img.style.display !== "none",
			msg: msg && msg.style.display !== "none" ? msg.textContent : "",
		};
	});
	const newExtracts = extractLog.slice(beforeExtracts);
	// Full-page shot: the oblique fills the whole map, compass on top.
	const shot = resolve(REPORT_DIR, `angle-${a.label}.png`);
	await page.screenshot({ path: shot });

	const ok = clicked && painted && info.imgShown && info.overlayShown &&
		info.natW > 0 && info.activeDir === a.dir;
	results.push({ ...a, ok, info, extracts: newExtracts.map((e) => e.status), shot });
	console.log(`  ${ok ? "✓" : "✗"} ${a.label.padEnd(3)} activeDir=${info.activeDir} ` +
		`natWxH=${info.natW}x${info.natH} year=${info.year} ` +
		`extract=${newExtracts.map((e) => e.status).join(",") || "-"} ` +
		`${info.msg ? "msg=\"" + info.msg + "\"" : ""}`);

	// Space the pulls — extract is a heavy, rate-limited stitch.
	await page.waitForTimeout(20_000);
}

console.log("\n=== per-angle results ===");
for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.label}  → ${r.shot}`);
const passed = results.filter((r) => r.ok).length;

// Sanity that we're not showing the same frame five times: obliques
// come as portrait (N/S: 10560x14144) vs landscape (E/W: 14144x10560),
// and nadir is its own size — so the set of WxH signatures must span
// more than one value.
const sigs = new Set(results.filter((r) => r.ok).map((r) => `${r.info.natW}x${r.info.natH}`));
console.log(`\n${passed}/${results.length} angles rendered  |  distinct image sizes: ${[...sigs].join(", ")}`);
const distinct = sigs.size >= 2;
if (!distinct) console.log("  ✗ all angles shared one image size — suspect a stuck frame");
await browser.close();
process.exit(passed === results.length && distinct ? 0 : 1);
