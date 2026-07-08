#!/usr/bin/env node
// Verify credential-based auto-login: seed ONLY a username+password (no
// token), activate the Vexcel base, and assert the script silently mints
// a fresh JWT via admin.vexcelgroup.com/api/auth/authenticate and paints
// tiles — the "QLD-Globe experience" (paste creds once, refresh daily).
//
//   VEXCEL_USER=<email> VEXCEL_PASS=<password> npm run e2e:vexcel-autologin
import { chromium } from "playwright";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const STATE_PATH = resolve(REPO_ROOT, ".auth", "storage.json");
if (!existsSync(STATE_PATH)) { console.error("run npm run e2e:auth first"); process.exit(2); }
const USER = process.env.VEXCEL_USER || "";
const PASS = process.env.VEXCEL_PASS || "";
if (!USER || !PASS) { console.error("set VEXCEL_USER and VEXCEL_PASS"); process.exit(2); }

const browser = await chromium.launch({ headless: !process.env.HEADED,
	args: ["--disable-web-security", "--disable-features=IsolateOrigins,site-per-process"] });
const context = await browser.newContext({ storageState: STATE_PATH, viewport: { width: 1200, height: 800 } });

let authPost = null, tileOk = 0, tile403 = 0, authPosts = 0;
const t0 = Date.now();
const tileTimes = []; // ms-from-start of every WMTS tile request
context.on("response", (r) => {
	const u = r.url();
	if (/admin\.vexcelgroup\.com\/api\/auth\/authenticate/.test(u)) { authPost = r.status(); authPosts++; }
	if (/api\.vexcelgroup\.com\/v2\/ortho\/wmts/.test(u)) {
		tileTimes.push(Date.now() - t0);
		r.status() === 403 ? tile403++ : (r.status() < 300 && tileOk++);
	}
});

await context.addInitScript({ content: readFileSync(resolve(__dirname, "lib", "bootstrap.js"), "utf8") });
// Seed CREDENTIALS only — deliberately NO token, so a paint proves login worked.
await context.addInitScript({ content:
	`try {
		localStorage.setItem("GM:dw_vexcel_user", ${JSON.stringify(JSON.stringify(USER))});
		localStorage.setItem("GM:dw_vexcel_pass", ${JSON.stringify(JSON.stringify(PASS))});
		localStorage.removeItem("GM:dw_vexcel_token");
	} catch (_) {}` });
await context.addInitScript({ content: readFileSync(resolve(REPO_ROOT, "dynamicwatch-custom-tiles.user.js"), "utf8") });

const page = await context.newPage();
// Auto-login must NOT prompt — fail loud if a dialog appears.
let prompted = false;
page.on("dialog", async (d) => { prompted = true; await d.dismiss(); });

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
// Wait for the login round-trip + first tiles.
await page.waitForFunction(() => {
	try { const t = localStorage.getItem("GM:dw_vexcel_token") || ""; return t.replace(/^"|"$/g, "").split(".").length === 3; }
	catch (_) { return false; }
}, { timeout: 20_000 }).catch(() => {});
// Watch for CONVERGENCE: when the account is quota-capped the storm used
// to loop forever (643+ requests). The give-up logic must stop it. Sit
// idle 12 s and confirm no new tile requests fire in the final window.
await page.waitForTimeout(12000);
const settleWindow = 5000;
const now = Date.now() - t0;
const recentTiles = tileTimes.filter((t) => t > now - settleWindow).length;
const converged = recentTiles === 0;

// Now stress it like a real user: after give-up, PAN and ZOOM around and
// confirm the storm does NOT resume (give-up must survive map interaction,
// not just an idle map). This is the real-world "10,532 requests" case.
const beforeInteract = tileTimes.length;
for (let i = 0; i < 4; i++) {
	await page.mouse.move(400, 400);
	await page.mouse.down();
	await page.mouse.move(400 + (i % 2 ? -220 : 220), 400 + (i < 2 ? 180 : -180), { steps: 8 });
	await page.mouse.up();
	await page.waitForTimeout(700);
}
await page.evaluate(() => window._dwLayerCtrl._map.setZoom(18));
await page.waitForTimeout(1500);
await page.evaluate(() => window._dwLayerCtrl._map.setZoom(16));
await page.waitForTimeout(3000);
const tilesDuringInteract = tileTimes.length - beforeInteract;
// A handful of tiles may fire as new areas scroll in before give-up
// re-triggers, but it must NOT be a storm.
const heldUnderInteraction = tilesDuringInteract < 30;

// The date bar must resolve to a definite state, not spin "Loading…"
// forever when the point has no imagery / the account is quota-capped.
const barLabel = await page.evaluate(() => {
	const n = document.querySelector(".dw-history-bar-label");
	return n ? (n.textContent || "").trim() : "(no bar)";
});
const barResolved = barLabel !== "" && !/^Loading/i.test(barLabel);

const tokenStored = await page.evaluate(() => {
	try { return (localStorage.getItem("GM:dw_vexcel_token") || "").replace(/^"|"$/g, "").split(".").length === 3; }
	catch (_) { return false; }
});

console.log(`\n=== Vexcel credential auto-login ===`);
console.log(`  authenticate POST status: ${authPost}  (${authPosts} login call(s))`);
console.log(`  token minted & stored:    ${tokenStored}`);
console.log(`  basemap tiles OK / 403:   ${tileOk} / ${tile403}  (${tileTimes.length} total)`);
console.log(`  converged (0 tile reqs in last ${settleWindow / 1000}s): ${converged}  [${recentTiles} recent]`);
console.log(`  tiles during pan+zoom stress: ${tilesDuringInteract}  (held: ${heldUnderInteraction})`);
console.log(`  date-bar label: "${barLabel}"  (resolved, not stuck loading: ${barResolved})`);
console.log(`  prompted user (should be false): ${prompted}`);
// The part THIS code owns: creds silently mint & store a valid JWT with
// no prompt. Whether Vexcel then serves imagery is gated by the account's
// usage quota (server-side) — when it's capped even a fresh token 403s on
// the tiles, which is external to the login flow, so we report it but
// don't fail the mechanism on it.
const loginOk = authPost === 200 && tokenStored && !prompted;
const imageryOk = tileOk > 0;
// When quota-capped, the storm MUST converge (give-up logic) and MUST NOT
// re-login endlessly (lockout risk). A couple of login calls is expected.
const boundedLogins = authPosts <= 3;
if (loginOk && !imageryOk) {
	console.log(`\n⚠ login OK but imagery 403 — the Vexcel ACCOUNT is quota-capped ` +
		`server-side right now (a fresh token can't fix that; it lifts over time).`);
}
const ok = loginOk && barResolved && (imageryOk || (converged && boundedLogins && heldUnderInteraction));
if (loginOk && !imageryOk && !converged) {
	console.log(`\n✗ storm did NOT converge — still requesting tiles (would loop). ` +
		`Give-up logic failed.`);
}
console.log(`\n${ok
	? "✓ PASS — creds auto-minted a token, no prompt" +
		(imageryOk ? " and painted tiles" : " (imagery quota-capped; storm converged, no loop)")
	: "✗ FAIL"}`);
await browser.close();
process.exit(ok ? 0 : 1);
