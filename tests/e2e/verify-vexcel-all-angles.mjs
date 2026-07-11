#!/usr/bin/env node
// Centre on the Sunshine Coast, then cycle the Vexcel compass through
// every cardinal direction (N, E, S, W), waiting for each warped oblique to
// paint on the primary map and screenshotting the map each time.
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
];

const browser = await chromium.launch({
	headless: !process.env.HEADED,
	args: ["--disable-web-security", "--disable-features=IsolateOrigins,site-per-process"],
});
const context = await browser.newContext({ storageState: STATE_PATH, viewport: { width: 1400, height: 900 } });

// Track oblique tile fetches (the chunked pyramid) with their image-name
// so we can prove each direction pulls a DIFFERENT photo.
const tileLog = [];
context.on("response", (resp) => {
	const u = resp.url();
	if (u.includes("/v2/oriented/tile")) {
		const m = u.match(/image-name=([^&]+)/);
		tileLog.push({ status: resp.status(), name: m ? decodeURIComponent(m[1]) : "" });
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
await page.waitForFunction(() => !!(window._dwLayerCtrl && window._dwLayerCtrl._map),
	undefined, { timeout: 15_000 });

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
// Wait for the capture query to resolve (history bar populates) before
// clicking directions — else ctl.model is still null and clicks report
// "No Vexcel oblique here".
await page.waitForFunction(() => {
	const s = document.querySelector(".dw-history-slider");
	return s && Number(s.max) >= 1;
}, undefined, { timeout: 20_000 }).catch(() => {});
await nukeModal();

if (!existsSync(REPORT_DIR)) mkdirSync(REPORT_DIR, { recursive: true });

const results = [];
for (const a of ANGLES) {
	await nukeModal();
	const before = tileLog.length;
	const clicked = await page.evaluate((dir) => {
		const b = document.querySelector(`.dw-vex-ctl .dw-vex-dir[data-dir="${dir}"]`);
		if (b) { b.click(); return true; }
		return false;
	}, a.dir);

	// Wait for THIS direction's warped source tiles to render.
	const painted = await page.waitForFunction((dir) => {
		const t = document.querySelectorAll(".dw-vex-warp-tile-loaded");
		const active = document.querySelector(".dw-vex-dir--on");
		return t.length >= 4 && active && active.dataset.dir === dir;
	}, a.dir, { timeout: 45_000 }).then(() => true).catch(() => false);
	await page.waitForTimeout(3500); // let the visible grid fill

	const info = await page.evaluate(() => {
		const ctl = document.querySelector(".dw-vex-ctl");
		const warp = document.querySelector(".dw-vex-warp");
		const msg = ctl.querySelector(".dw-vex-basemsg");
		const on  = ctl.querySelector(".dw-vex-dir--on");
		return {
			activeDir: on ? on.dataset.dir : null,
			year: (document.querySelector(".dw-history-bar-label") || {}).textContent,
			warpShown: !!warp,
			tiles: document.querySelectorAll(".dw-vex-warp-tile-loaded").length,
			msg: msg && msg.style.display !== "none" ? msg.textContent : "",
			imageNames: [...new Set([...document.querySelectorAll(".dw-vex-warp-tile-loaded")]
				.map((tile) => tile.dataset.imageName).filter(Boolean))],
		};
	});
	const mine = tileLog.slice(before).filter((t) => t.status === 200);
	const name = info.imageNames.length === 1 ? info.imageNames[0] :
		(mine.length ? mine[mine.length - 1].name : "");
	const shot = resolve(REPORT_DIR, `angle-${a.label}.png`);
	await page.screenshot({ path: shot });

	const ok = clicked && painted && info.warpShown && info.tiles >= 4 &&
		info.activeDir === a.dir;
	results.push({ ...a, ok, info, name, tiles: mine.length, shot });
	console.log(`  ${ok ? "✓" : "✗"} ${a.label.padEnd(3)} activeDir=${info.activeDir} ` +
		`tiles=${info.tiles} year=${info.year} img=${name.slice(-40)} ` +
		`${info.msg ? "msg=\"" + info.msg + "\"" : ""}`);

	await page.waitForTimeout(4000);
}

console.log("\n=== per-angle results ===");
for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.label}  → ${r.shot}`);
const passed = results.filter((r) => r.ok).length;

// Each direction must pull a DIFFERENT photo — the image-names must all
// differ (proves we're not showing one frame five times).
const names = new Set(results.filter((r) => r.ok && r.name).map((r) => r.name));
console.log(`\n${passed}/${results.length} angles rendered as tiles  |  distinct image-names: ${names.size}`);
const distinct = names.size >= results.filter((r) => r.ok).length && names.size >= 4;
if (!distinct) console.log("  ✗ image-names not all distinct — suspect a stuck frame");
await page.locator(".dw-vex-rose .dw-vex-flat").click();
const flatOk = await page.waitForFunction(() =>
	!document.querySelector(".dw-vex-warp") &&
	document.querySelector(".dw-vex-flat")?.classList.contains("dw-vex-dir--on"),
	undefined, { timeout: 10_000 },
).then(() => true).catch(() => false);
console.log(`  ${flatOk ? "PASS" : "FAIL"}  2D center restores the flat aerial map`);
await browser.close();
process.exit(passed === results.length && distinct && flatOk ? 0 : 1);
