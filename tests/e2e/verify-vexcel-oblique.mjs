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

// The blank planner has no saved route. Add one using the same leafletPlan
// shape the provider reads, so it can be projected into Vexcel image pixels.
await page.evaluate(() => {
	const map = window._dwLayerCtrl._map;
	window._dwVexcelTestRoute = L.polyline([
		[-26.610, 153.002], [-26.607, 153.006], [-26.604, 153.010],
	], { color: "#ef2929", weight: 5, className: "route-polyline" }).addTo(map);
	window.leafletPlan = window.leafletPlan || {};
	window.leafletPlan.lines = [[{ polyline: window._dwVexcelTestRoute }]];
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
await page.waitForSelector(".dw-vex-route--exact", { timeout: 30_000 }).catch(() => {});

const routeSurface = await page.evaluate(() => {
	const map = window._dwLayerCtrl._map;
	const pane = map.getPane("dwVexcelObliquePane");
	const routePane = map.getPane("dwVexcelRoutePane");
	const route = document.querySelector(".dw-vex-route-visual");
	const routeRect = route ? route.getBoundingClientRect() : null;
	const tiles = [...document.querySelectorAll(".dw-vex-warp-tile-loaded")];
	const tileRects = tiles
		.map((tile) => tile.getBoundingClientRect());
	const routeStyle = route ? getComputedStyle(route) : null;
	const mapRect = map.getContainer().getBoundingClientRect();
	return {
		warpOnMainMap: !!document.querySelector(".dw-vex-warp") && !!pane,
		exactRoute: !!document.querySelector(".dw-vex-route--exact"),
		warpPointerEvents: pane ? getComputedStyle(pane).pointerEvents : "",
		routeConnected: !!(route && route.isConnected),
		routeAboveWarp: pane && routePane && Number(getComputedStyle(routePane).zIndex) >
			Number(getComputedStyle(pane).zIndex),
		routeOverImagery: !!routeRect && tileRects.some((rect) =>
			rect.right >= routeRect.left && rect.left <= routeRect.right &&
			rect.bottom >= routeRect.top && rect.top <= routeRect.bottom),
		nativeRouteHidden: getComputedStyle(window._dwVexcelTestRoute._path).opacity === "0",
		projectedRouteVisible: !!routeRect && routeRect.width > 1 && routeRect.height > 1 &&
			routeRect.right >= mapRect.left && routeRect.left <= mapRect.right &&
			routeRect.bottom >= mapRect.top && routeRect.top <= mapRect.bottom &&
			routeStyle.display !== "none" && routeStyle.visibility !== "hidden" &&
			Number(routeStyle.opacity) > 0 && Number(routeStyle.strokeOpacity || 1) > 0,
		perspectivePreserved: !!document.querySelector(".dw-vex-warp") &&
			getComputedStyle(document.querySelector(".dw-vex-warp")).transform !== "none" &&
			!document.querySelector(".dw-vex-warp-cell") &&
			tiles.every((tile) => getComputedStyle(tile).transform === "none"),
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

// The compass has one vertical-map action in its centre. It must remove the
// perspective layer and restore the native route, then a cardinal must reopen
// the oblique normally.
await page.locator(".dw-vex-rose .dw-vex-flat").click();
const flatOk = await page.waitForFunction(() =>
	!document.querySelector(".dw-vex-warp") &&
	!document.querySelector("#leaflet.dw-vex-perspective-active") &&
	document.querySelector(".dw-vex-flat")?.classList.contains("dw-vex-dir--on"),
	undefined, { timeout: 10_000 },
).then(() => true).catch(() => false);
await page.locator('.dw-vex-dir[data-dir="oblique-east"]').click();
const reopenOk = await page.waitForFunction(() =>
	document.querySelector('.dw-vex-dir--on[data-dir="oblique-east"]') &&
	document.querySelectorAll(".dw-vex-warp-tile-loaded").length >= 2 &&
	document.querySelector(".dw-vex-route--exact"),
	undefined, { timeout: 30_000 },
).then(() => true).catch(() => false);

const viewer = await page.evaluate(() => {
	const el = document.querySelector(".dw-vex-ctl");
	if (!el) return { present: false };
	const dirs = [...el.querySelectorAll(".dw-vex-dir[data-dir]")].map((b) => b.dataset.dir);
	const slider = document.querySelector(".dw-history-slider");
	const captureCount = slider ? Number(slider.max) + 1 : 0;
	const map = window._dwLayerCtrl._map;
	const warp = document.querySelector(".dw-vex-warp");
	const pane = map.getPane("dwVexcelObliquePane");
	const tiles = document.querySelectorAll(".dw-vex-warp-tile-loaded").length;
	const msg = el.querySelector(".dw-vex-basemsg");
	const warpZ = pane ? Number(getComputedStyle(pane).zIndex) : 0;
	const routeZ = Number(getComputedStyle(map.getPane("dwVexcelRoutePane")).zIndex);
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
		routeConnected: !!document.querySelector(".dw-vex-route path"),
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
const modelOk = viewer.present && viewer.dirs.length === 4 && viewer.dirs.every((d) => /oblique/.test(d)) && viewer.dates.length >= 2;
const tilesOk = tile200 >= 2 && viewer.tilesLoaded >= 2;
const panLoadsTiles = newCoords >= 2;
const barGating = barOnBasemap === true; // bar shown + populated on basemap
const continuousPan = newFrames.length >= 1; // crossed into an adjacent frame
const routeOk = routeSurface.warpOnMainMap && routeSurface.warpPointerEvents === "none" &&
	routeSurface.routeConnected && routeSurface.routeAboveWarp && routeSurface.routeOverImagery &&
	routeSurface.nativeRouteHidden && routeSurface.projectedRouteVisible &&
	routeSurface.perspectivePreserved && routeSurface.exactRoute && transform200 > 0;
const ok = queryOk && modelOk && tilesOk && panLoadsTiles && barGating &&
	flatOk && reopenOk && continuousPan && routeOk && mapMoved;
console.log(`  date bar on basemap: ${barGating}  |  center 2D: ${flatOk}  |  reopen oblique: ${reopenOk}  |  continuous pan (frame switch): ${continuousPan}`);
console.log(`  primary-map warp + native route stacking: ${routeOk}`);
console.log(`  primary map moved under drag: ${mapMoved}`);
console.log(`\n${ok ? "✓ PASS" : "✗ FAIL"} — Vexcel oblique ${ok ? "keeps perspective with a projected route" : "did not fully verify"}`);
await browser.close();
process.exit(ok ? 0 : 1);
