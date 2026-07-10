#!/usr/bin/env node
// Diagnostic: drive the Vexcel compass at several populated Sunshine
// Coast locations that DEFINITELY have oblique coverage, and report for
// each whether the primary-map warp painted tiles or showed a message —
// reproducing the user's "no imagery where there should be" report.
import { chromium } from "playwright";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname  = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = resolve(__dirname, "..", "..");
const STATE_PATH = resolve(REPO_ROOT, ".auth", "storage.json");
if (!existsSync(STATE_PATH)) { console.error("run npm run e2e:auth first"); process.exit(2); }

const rawTok = process.env.VEXCEL_TOKEN || "";
const m = rawTok.match(/token=([\w-]+\.[\w-]+\.[\w-]+)/) || rawTok.match(/^([\w-]+\.[\w-]+\.[\w-]+)$/);
const TOKEN = m ? m[1] : "";
if (!TOKEN) { console.error("set VEXCEL_TOKEN"); process.exit(2); }

const PLACES = [
	{ name: "Maroochydore", lat: -26.658, lng: 153.100 },
	{ name: "Caloundra",    lat: -26.803, lng: 153.132 },
	{ name: "Nambour town", lat: -26.626, lng: 152.958 },
	{ name: "Buderim",      lat: -26.685, lng: 153.055 },
];

const browser = await chromium.launch({
	headless: !process.env.HEADED,
	args: ["--disable-web-security", "--disable-features=IsolateOrigins,site-per-process"],
});
const context = await browser.newContext({ storageState: STATE_PATH, viewport: { width: 1400, height: 900 } });

const net = [];
context.on("response", (r) => {
	const u = r.url();
	if (u.includes("/v2/oriented/query")) net.push({ kind: "query", status: r.status() });
	if (u.includes("/v2/oriented/tile")) net.push({ kind: "tile", status: r.status() });
	if (u.includes("/v2/oriented/transform-points")) net.push({ kind: "transform", status: r.status() });
});

// Enforce Tampermonkey's @connect allowlist so this diagnostic catches
// a missing directive (the real cause of "no imagery"): parse @connect
// hosts from the built script and block GM-shim fetches to others.
const builtScript = readFileSync(resolve(REPO_ROOT, "dynamicwatch-custom-tiles.user.js"), "utf8");
let allowHosts = [...builtScript.matchAll(/@connect\s+(\S+)/g)].map((m) => m[1]);
// DROP_CONNECT=api.vexcelgroup.com simulates the pre-fix bug (host not
// allowlisted) to prove this diagnostic reproduces "no imagery".
if (process.env.DROP_CONNECT) {
	allowHosts = allowHosts.filter((h) => h !== process.env.DROP_CONNECT);
	console.log(`[diag] simulating missing @connect for ${process.env.DROP_CONNECT}`);
}
await context.addInitScript({ content:
	`window.__dwConnectList = ${JSON.stringify(allowHosts)}; window.__dwConnectEnforce = true;` });
await context.addInitScript({ content: readFileSync(resolve(__dirname, "lib", "bootstrap.js"), "utf8") });
await context.addInitScript({ content: `try { localStorage.setItem("GM:dw_vexcel_token", ${JSON.stringify(JSON.stringify(TOKEN))}); } catch (_) {}` });
await context.addInitScript({ content: readFileSync(resolve(REPO_ROOT, "dynamicwatch-custom-tiles.user.js"), "utf8") });

const page = await context.newPage();
page.on("console", (msg) => { if (/vexcel|Vexcel|CustomTiles/.test(msg.text())) console.log("  [page]", msg.text()); });
await page.goto("https://dynamic.watch/plan", { waitUntil: "domcontentloaded", timeout: 45_000 });
await page.waitForSelector(".leaflet-planner-controls", { timeout: 30_000 });
const nuke = () => page.evaluate(() => { document.querySelectorAll(".modal,.modal-backdrop").forEach(e => e.remove()); document.body.classList.remove("modal-open"); document.body.style.overflow = ""; });
await nuke();
await page.waitForFunction(() => !!(window._dwLayerCtrl && window._dwLayerCtrl._map),
	undefined, { timeout: 15_000 });
await page.evaluate(() => {
	const map = window._dwLayerCtrl._map, ctrl = window._dwLayerCtrl;
	const vex = ctrl._layers.find((l) => l.name === "Vexcel Aerial")?.layer;
	ctrl._layers.filter((l) => !l.overlay).forEach((l) => { if (l.layer !== vex && map.hasLayer(l.layer)) map.removeLayer(l.layer); });
	if (!map.hasLayer(vex)) map.addLayer(vex);
});
await page.waitForSelector(".dw-vex-ctl", { timeout: 10_000 });
await nuke();

for (const p of PLACES) {
	await page.evaluate(({ lat, lng }) => window._dwLayerCtrl._map.setView([lat, lng], 17), p);
	await page.waitForTimeout(600);
	// Report what the map centre actually is (what the compass queries).
	const centre = await page.evaluate(() => {
		const c = window._dwLayerCtrl._map.getCenter();
		return { lat: c.lat, lng: c.lng };
	});
	const before = net.length;
	await nuke();
	await page.evaluate(() => {
		const b = document.querySelector('.dw-vex-ctl .dw-vex-dir[data-dir="oblique-north"]');
		if (b) b.click();
	});
	const painted = await page.waitForFunction(() => {
		return document.querySelectorAll(".dw-vex-warp-tile-loaded").length > 0;
	}, undefined, { timeout: 50_000 }).then(() => true).catch(() => false);
	const state = await page.evaluate(() => {
		const ctl = document.querySelector(".dw-vex-ctl");
		const msg = ctl.querySelector(".dw-vex-basemsg");
		return {
			warpShown: !!document.querySelector(".dw-vex-warp"),
			tiles: document.querySelectorAll(".dw-vex-warp-tile-loaded").length,
			msg: msg && msg.style.display !== "none" ? msg.textContent : "",
		};
	});
	const calls = net.slice(before);
	console.log(`\n${p.name}  (asked ${p.lat},${p.lng} → centre ${centre.lat.toFixed(5)},${centre.lng.toFixed(5)})`);
	console.log(`  painted=${painted} tiles=${state.tiles} msg="${state.msg}"`);
	console.log(`  net: ${calls.map((c) => c.kind + ":" + c.status).join(", ") || "(none)"}`);
	// Clicking the active direction toggles the warp off before the next place.
	await page.evaluate(() => { const b = document.querySelector(".dw-vex-dir--on"); if (b) b.click(); });
	await page.waitForTimeout(2000);
}

await browser.close();
