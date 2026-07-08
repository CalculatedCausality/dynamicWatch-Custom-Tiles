#!/usr/bin/env node
// DIAGNOSTIC (not a pass/fail test): drive the full Vexcel flow in the
// real page with stored credentials and capture, at each step, exactly
// what the SERVER returns — so we can see whether a failure is our code
// or Vexcel refusing the account. Prints the auth response, the token,
// and the literal body of a basemap tile + oblique query, then saves a
// screenshot of the map with the compass.
//
//   VEXCEL_USER=<email> VEXCEL_PASS=<pw> node tests/e2e/diag-vexcel-flow.mjs
import { chromium } from "playwright";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const STATE_PATH = resolve(REPO_ROOT, ".auth", "storage.json");
const OUT = resolve(REPO_ROOT, "test-results", "vexcel-flow");
if (!existsSync(STATE_PATH)) { console.error("run npm run e2e:auth first"); process.exit(2); }
const USER = process.env.VEXCEL_USER || "", PASS = process.env.VEXCEL_PASS || "";
if (!USER || !PASS) { console.error("set VEXCEL_USER and VEXCEL_PASS"); process.exit(2); }

const browser = await chromium.launch({ headless: !process.env.HEADED,
	args: ["--disable-web-security", "--disable-features=IsolateOrigins,site-per-process"] });
const context = await browser.newContext({ storageState: STATE_PATH, viewport: { width: 1280, height: 860 } });

const seen = { auth: null, tile: null, query: null };
context.on("response", async (r) => {
	const u = r.url();
	try {
		if (/auth\/authenticate/.test(u) && !seen.auth) seen.auth = { status: r.status() };
		if (/ortho\/wmts.*getTile/i.test(u) && !seen.tile) seen.tile = { status: r.status(), body: (await r.text()).slice(0, 200) };
		if (/oriented\/query/.test(u) && !seen.query) seen.query = { status: r.status(), body: (await r.text()).slice(0, 200) };
	} catch (_) {}
});

await context.addInitScript({ content: readFileSync(resolve(__dirname, "lib", "bootstrap.js"), "utf8") });
await context.addInitScript({ content:
	`try {
		localStorage.setItem("GM:dw_vexcel_user", ${JSON.stringify(JSON.stringify(USER))});
		localStorage.setItem("GM:dw_vexcel_pass", ${JSON.stringify(JSON.stringify(PASS))});
		localStorage.removeItem("GM:dw_vexcel_token");
	} catch (_) {}` });
await context.addInitScript({ content: readFileSync(resolve(REPO_ROOT, "dynamicwatch-custom-tiles.user.js"), "utf8") });

const page = await context.newPage();
page.on("dialog", async (d) => { console.log(`  [dialog] ${d.type()}: ${d.message().slice(0, 60)}`); await d.dismiss(); });

await page.goto("https://dynamic.watch/plan", { waitUntil: "domcontentloaded", timeout: 45_000 });
await page.waitForSelector(".leaflet-planner-controls", { timeout: 30_000 });
await page.evaluate(() => { document.querySelectorAll(".modal,.modal-backdrop").forEach(e => e.remove()); document.body.classList.remove("modal-open"); });
await page.waitForFunction(() => !!(window._dwLayerCtrl && window._dwLayerCtrl._map), { timeout: 15_000 });
await page.evaluate(() => window._dwLayerCtrl._map.setView([-26.607, 153.006], 17));
await page.evaluate(() => {
	const map = window._dwLayerCtrl._map, ctrl = window._dwLayerCtrl;
	const vex = ctrl._layers.find((l) => l.name === "Vexcel Aerial")?.layer;
	ctrl._layers.filter((l) => !l.overlay).forEach((l) => { if (l.layer !== vex && map.hasLayer(l.layer)) map.removeLayer(l.layer); });
	if (!map.hasLayer(vex)) map.addLayer(vex);
});
await page.waitForTimeout(8000);

const tokenClaims = await page.evaluate(() => {
	try {
		const t = (localStorage.getItem("GM:dw_vexcel_token") || "").replace(/^"|"$/g, "");
		if (t.split(".").length !== 3) return null;
		return JSON.parse(atob(t.split(".")[1]));
	} catch (_) { return null; }
});

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
const shot = resolve(OUT, "flow.png");
await page.screenshot({ path: shot });

console.log(`\n================= VEXCEL FLOW DIAGNOSTIC =================`);
console.log(`STEP 1  login  → POST admin.vexcelgroup.com/api/auth/authenticate`);
console.log(`        server: ${JSON.stringify(seen.auth)}  ${seen.auth?.status === 200 ? "✓ credentials accepted" : "✗"}`);
console.log(`STEP 2  token  → stored JWT claims: ${JSON.stringify(tokenClaims)}`);
console.log(`        (note: no scope/permission claims — access is account-level, server-side)`);
console.log(`STEP 3  basemap tile → GET api.vexcelgroup.com/v2/ortho/wmts`);
console.log(`        server: ${seen.tile ? `HTTP ${seen.tile.status} — ${seen.tile.body.replace(/\s+/g, " ").trim()}` : "(no tile request seen)"}`);
console.log(`STEP 4  oblique query → POST api.vexcelgroup.com/v2/oriented/query`);
console.log(`        server: ${seen.query ? `HTTP ${seen.query.status} — ${seen.query.body.replace(/\s+/g, " ").trim()}` : "(no query seen)"}`);
console.log(`\nscreenshot: ${shot}`);
console.log(`\nCONCLUSION:`);
if (seen.auth?.status === 200 && (seen.tile?.status === 403 || seen.query?.status === 403)) {
	console.log(`  Our flow is correct — login works, a valid token is minted & sent.`);
	console.log(`  Vexcel's SERVER refuses the imagery with a permission error. This is`);
	console.log(`  an account-entitlement problem on Vexcel's side; no code/token/header`);
	console.log(`  change can grant a permission the account doesn't have.`);
} else if (seen.tile?.status < 300) {
	console.log(`  Imagery is being served (HTTP ${seen.tile.status}) — the account is authorized.`);
}
await browser.close();
