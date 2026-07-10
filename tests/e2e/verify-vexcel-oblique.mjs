#!/usr/bin/env node
// Verify Vexcel obliques on the primary Leaflet map: oriented tiles are
// warped into a pane below the native route, map interaction stays active,
// and direction/date/band changes replace the selected frame.
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

let queryOk = false, transform200 = 0, tile200 = 0, tileOther = 0;
const tileCoords = [];
const tileImages = []; // image-name per tile request (for frame-switch check)
context.on("response", (resp) => {
	const u = resp.url();
	if (u.includes("/v2/oriented/query")) queryOk = queryOk || resp.status() === 200;
	if (u.includes("/v2/oriented/transform-points") && resp.status() === 200) transform200++;
	if (u.includes("/v2/oriented/tile")) {
		if (resp.status() === 200) tile200++; else tileOther++;
		const dm = u.match(/downsample=(\d+)/), xm = u.match(/tile-x=(\d+)/), ym = u.match(/tile-y=(\d+)/);
		if (resp.status() === 200 && dm && xm && ym) tileCoords.push(`${dm[1]}/${xm[1]}/${ym[1]}`);
		const im = u.match(/image-name=([^&]+)/);
		if (resp.status() === 200 && im) tileImages.push(decodeURIComponent(im[1]));
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
await page.waitForFunction(() => !!(window._dwLayerCtrl && window._dwLayerCtrl._map),
	undefined, { timeout: 15_000 });
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

// The blank planner has no saved route. Add a normal Leaflet route-shaped
// polyline so the test can assert that native overlayPane content remains
// connected and stacked above the Vexcel warp.
await page.evaluate(() => {
	const map = window._dwLayerCtrl._map;
	window._dwVexcelTestRoute = L.polyline([
		[-26.610, 153.002], [-26.607, 153.006], [-26.604, 153.010],
	], { color: "#ef2929", weight: 5, className: "route-polyline" }).addTo(map);
});

// The compass docks on its own; dates ride the shared history bar and update
// both the flat mosaic and whichever oblique direction is active.
const hasCtl = await page.waitForSelector(".dw-vex-ctl", { timeout: 10_000 }).then(() => true).catch(() => false);
console.log(`docked compass present: ${hasCtl}`);
// The date bar should populate at the map centre without opening an
// oblique first.
const barOnBasemap = await page.waitForFunction(() => {
	const s = document.querySelector(".dw-history-slider");
	return s && Number(s.max) >= 1;
}, undefined, { timeout: 15_000 }).then(() => true).catch(() => false);
console.log(`date bar shown on basemap (should be true): ${barOnBasemap}`);

// Click a direction to add the warped oblique to the primary map.
await page.evaluate(() => {
	const east = document.querySelector('.dw-vex-ctl .dw-vex-dir[data-dir="oblique-east"]');
	if (east) east.click();
});

// Wait for warped source tiles to paint progressively.
await page.waitForFunction(() => {
	const t = document.querySelectorAll(".dw-vex-warp-tile-loaded");
	return t.length >= 2;
}, undefined, { timeout: 30_000 }).catch(() => {});
await page.waitForTimeout(5000);
await page.waitForSelector(".dw-vex-warp--exact", { timeout: 30_000 }).catch(() => {});

const routeSurface = await page.evaluate(() => {
	const map = window._dwLayerCtrl._map;
	const pane = map.getPane("dwVexcelObliquePane");
	const route = window._dwVexcelTestRoute;
	const routeRect = route && route._path ? route._path.getBoundingClientRect() : null;
	const cellRects = [...document.querySelectorAll(".dw-vex-warp-tile-loaded .dw-vex-warp-cell")]
		.map((cell) => cell.getBoundingClientRect());
	return {
		warpOnMainMap: !!document.querySelector(".dw-vex-warp") && !!pane,
		exactWarp: !!document.querySelector(".dw-vex-warp--exact"),
		warpPointerEvents: pane ? getComputedStyle(pane).pointerEvents : "",
		routeConnected: !!(route && route._path && route._path.isConnected),
		routeAboveWarp: pane && Number(getComputedStyle(map.getPane("overlayPane")).zIndex) >
			Number(getComputedStyle(pane).zIndex),
		routeOverImagery: !!routeRect && cellRects.some((rect) =>
			rect.right >= routeRect.left && rect.left <= routeRect.right &&
			rect.bottom >= routeRect.top && rect.top <= routeRect.bottom),
	};
});

// Pan the PRIMARY map and confirm new warped source tiles stream in.
const dragLeft = async (dist) => {
	const cx = 700, cy = 500;
	await page.mouse.move(cx, cy);
	await page.mouse.down();
	const steps = 12;
	for (let i = 1; i <= steps; i++) await page.mouse.move(cx - (dist * i) / steps, cy, { steps: 1 });
	await page.mouse.up();
};
const coordsBefore = new Set(tileCoords);
const centerBefore = await page.evaluate(() => window._dwLayerCtrl._map.getCenter());
await dragLeft(300);
await page.waitForTimeout(4000);
const centerAfter = await page.evaluate(() => window._dwLayerCtrl._map.getCenter());
const mapMoved = Math.abs(centerAfter.lng - centerBefore.lng) > 1e-5 ||
	Math.abs(centerAfter.lat - centerBefore.lat) > 1e-5;
const newCoords = new Set(tileCoords.filter((c) => !coordsBefore.has(c))).size;
console.log(`  new tile coords loaded after pan: ${newCoords}`);

// CONTINUOUS PANNING: pan far (several drags) toward the frame edge and
// confirm a DIFFERENT frame (new image-name) streams in — proving the
// view crosses into the adjacent oblique instead of getting stuck.
const framesBefore = new Set(tileImages);
for (let d = 0; d < 6; d++) {
	await dragLeft(500);
	await page.waitForTimeout(2500);
}
await page.waitForTimeout(3000);
const newFrames = [...new Set(tileImages)].filter((n) => !framesBefore.has(n));
console.log(`  frame(s) switched-to while panning: ${newFrames.length} (${newFrames.map((n) => n.slice(-22)).join(", ")})`);

// ⊙ nadir behaviour: it exists only on the newest capture (SCC: 2025).
// Select it (should work + highlight on the newest date), then scrub to
// the OLDEST date — ⊙ must grey out and the view fall back to an angle
// with tiles, never a dead "no photo".
await page.evaluate(() => {
	const s = document.querySelector(".dw-history-slider");
	if (s) { s.value = String(s.max); s.dispatchEvent(new Event("input", { bubbles: true })); s.dispatchEvent(new Event("change", { bubbles: true })); }
	const top = document.querySelector('.dw-vex-ctl .dw-vex-dir[data-dir="nadir"]');
	if (top && !top.disabled) top.click();
});
await page.waitForTimeout(3500);
const nadirNewest = await page.evaluate(() => {
	const top = document.querySelector('.dw-vex-ctl .dw-vex-dir[data-dir="nadir"]');
	const ir = document.querySelector(".dw-vex-ir");
	return { enabled: top && !top.disabled, on: top && top.classList.contains("dw-vex-dir--on"), irEnabled: ir && !ir.disabled };
});

// IR toggle: on nadir 2025 (which has infrared), the IR button is
// enabled; clicking it must stream an _irg (infrared) frame.
const irBefore = tileImages.filter((n) => /_irg$/.test(n)).length;
await page.evaluate(() => {
	const ir = document.querySelector(".dw-vex-ir");
	if (ir && !ir.disabled) ir.click();
});
await page.waitForTimeout(4500);
const irLoaded = tileImages.filter((n) => /_irg$/.test(n)).length > irBefore;
const irOn = await page.evaluate(() => {
	const ir = document.querySelector(".dw-vex-ir");
	return ir && ir.classList.contains("dw-vex-ir--on");
});
console.log(`  IR toggle: enabled-on-nadir=${nadirNewest.irEnabled} loaded-infrared=${irLoaded} highlighted=${irOn}`);
// Toggle back to rgb before scrubbing away.
await page.evaluate(() => { const ir = document.querySelector(".dw-vex-ir"); if (ir && !ir.disabled) ir.click(); });
await page.waitForTimeout(1500);

await page.evaluate(() => {
	const s = document.querySelector(".dw-history-slider");
	if (s) { s.value = "0"; s.dispatchEvent(new Event("input", { bubbles: true })); s.dispatchEvent(new Event("change", { bubbles: true })); } // oldest
});
await page.waitForTimeout(4000);
const nadirOld = await page.evaluate(() => {
	const top = document.querySelector('.dw-vex-ctl .dw-vex-dir[data-dir="nadir"]');
	const on = document.querySelector('.dw-vex-ctl .dw-vex-dir--on');
	return {
		nadirGreyed: top && top.disabled && top.classList.contains("dw-vex-dir--off"),
		fellBackTo: on ? on.dataset.dir : null,
		tiles: document.querySelectorAll(".dw-vex-warp-tile-loaded").length,
	};
});
console.log(`  ⊙ on newest: enabled=${nadirNewest.enabled} highlighted=${nadirNewest.on}`);
console.log(`  ⊙ on oldest: greyed=${nadirOld.nadirGreyed} fell-back-to=${nadirOld.fellBackTo} tiles=${nadirOld.tiles}`);
const nadirOk = nadirNewest.enabled && nadirOld.nadirGreyed &&
	/oblique/.test(nadirOld.fellBackTo || "") && nadirOld.tiles >= 2;
const irOk = nadirNewest.irEnabled && irLoaded && irOn;

const viewer = await page.evaluate(() => {
	const el = document.querySelector(".dw-vex-ctl");
	if (!el) return { present: false };
	const dirs = [...el.querySelectorAll(".dw-vex-dir")].map((b) => b.dataset.dir);
	const slider = document.querySelector(".dw-history-slider");
	const captureCount = slider ? Number(slider.max) + 1 : 0;
	const map = window._dwLayerCtrl._map;
	const warp = document.querySelector(".dw-vex-warp");
	const pane = map.getPane("dwVexcelObliquePane");
	const route = window._dwVexcelTestRoute;
	const tiles = document.querySelectorAll(".dw-vex-warp-tile-loaded").length;
	const msg = el.querySelector(".dw-vex-basemsg");
	const warpZ = pane ? Number(getComputedStyle(pane).zIndex) : 0;
	const routeZ = Number(getComputedStyle(map.getPane("overlayPane")).zIndex);
	return {
		present: !!el,
		dirs,
		dates: Array.from({ length: captureCount }, (_, i) => String(i)),
		sliderEnabled: slider && !slider.disabled,
		year: (document.querySelector(".dw-history-bar-label") || {}).textContent,
		tilesLoaded: tiles,
		imgShown: tiles > 0,
		msg: msg && msg.style.display !== "none" ? msg.textContent : "",
		warpOnMainMap: !!warp && !!pane,
		warpPointerEvents: pane ? getComputedStyle(pane).pointerEvents : "",
		routeConnected: !!(route && route._path && route._path.isConnected),
		routeAboveWarp: routeZ > warpZ,
	};
});

if (!existsSync(REPORT_DIR)) mkdirSync(REPORT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const shot = resolve(REPORT_DIR, `verify-vexcel-oblique-${stamp}.png`);
await page.screenshot({ path: shot });

console.log("\n=== Vexcel imagery control verification ===");
console.log(`  oriented/query 200:  ${queryOk}`);
console.log(`  transform-points 200: ${transform200}`);
console.log(`  oriented/tile 200: ${tile200}  (other: ${tileOther})`);
console.log(`  control directions: ${JSON.stringify(viewer.dirs)}`);
console.log(`  capture slider steps: ${viewer.dates.length} (enabled: ${viewer.sliderEnabled}, year: ${viewer.year})`);
console.log(`  tiles rendered: ${viewer.tilesLoaded}  msg: "${viewer.msg}"`);
console.log(`  screenshot: ${shot}`);

// PASS if the warp painted on the primary map, panning streamed new source
// tiles, and the native route stayed connected above a non-interactive pane.
const modelOk = viewer.present && viewer.dirs.filter((d) => /oblique|nadir/.test(d)).length >= 4 && viewer.dates.length >= 2;
const tilesOk = tile200 >= 2 && viewer.tilesLoaded >= 2;
const panLoadsTiles = newCoords >= 2;
const barGating = barOnBasemap === true; // bar shown + populated on basemap
const continuousPan = newFrames.length >= 1; // crossed into an adjacent frame
const routeOk = routeSurface.warpOnMainMap && routeSurface.warpPointerEvents === "none" &&
	routeSurface.routeConnected && routeSurface.routeAboveWarp && routeSurface.routeOverImagery &&
	routeSurface.exactWarp && transform200 > 0;
const ok = queryOk && modelOk && tilesOk && panLoadsTiles && barGating &&
	nadirOk && continuousPan && irOk && routeOk && mapMoved;
console.log(`  date bar on basemap: ${barGating}  |  nadir grey+fallback: ${nadirOk}  |  continuous pan (frame switch): ${continuousPan}`);
console.log(`  primary-map warp + native route stacking: ${routeOk}`);
console.log(`  primary map moved under drag: ${mapMoved}`);
console.log(`\n${ok ? "✓ PASS" : "✗ FAIL"} — Vexcel oblique ${ok ? "warps onto the route map" : "did not fully verify"}`);
await browser.close();
process.exit(ok ? 0 : 1);
