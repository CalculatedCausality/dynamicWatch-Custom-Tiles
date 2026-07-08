#!/usr/bin/env node
// Verify that a REJECTED Vexcel token (403 server-side despite a valid
// JWT expiry — quota/revoked) triggers a fresh-token prompt instead of
// silently blanking. Seeds the (now-403'd) token, activates the base,
// and asserts a prompt dialog appears once the basemap tiles fail.
//
//   VEXCEL_TOKEN=<jwt-or-url> npm run e2e:vexcel-reprompt
import { chromium } from "playwright";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const STATE_PATH = resolve(REPO_ROOT, ".auth", "storage.json");
if (!existsSync(STATE_PATH)) { console.error("run npm run e2e:auth first"); process.exit(2); }
const m = (process.env.VEXCEL_TOKEN || "").match(/([\w-]+\.[\w-]+\.[\w-]+)/);
const TOKEN = m ? m[1] : "";
if (!TOKEN) { console.error("set VEXCEL_TOKEN (the rejected/403 token is fine here)"); process.exit(2); }

const browser = await chromium.launch({ headless: !process.env.HEADED,
	args: ["--disable-web-security", "--disable-features=IsolateOrigins,site-per-process"] });
const context = await browser.newContext({ storageState: STATE_PATH, viewport: { width: 1200, height: 800 } });

let tile403 = 0;
context.on("response", (r) => {
	if (/api\.vexcelgroup\.com\/v2\/ortho\/wmts/.test(r.url()) && r.status() === 403) tile403++;
});

await context.addInitScript({ content: readFileSync(resolve(__dirname, "lib", "bootstrap.js"), "utf8") });
await context.addInitScript({ content: `try { localStorage.setItem("GM:dw_vexcel_token", ${JSON.stringify(JSON.stringify(TOKEN))}); } catch (_) {}` });
await context.addInitScript({ content: readFileSync(resolve(REPO_ROOT, "dynamicwatch-custom-tiles.user.js"), "utf8") });

const page = await context.newPage();
let promptFired = false, promptMsg = "";
page.on("dialog", async (d) => {
	if (d.type() === "prompt") { promptFired = true; promptMsg = d.message().slice(0, 80); }
	await d.dismiss(); // cancel — we only assert the prompt appeared
});

await page.goto("https://dynamic.watch/plan", { waitUntil: "domcontentloaded", timeout: 45_000 });
await page.waitForSelector(".leaflet-planner-controls", { timeout: 30_000 });
await page.evaluate(() => { document.querySelectorAll(".modal,.modal-backdrop").forEach(e => e.remove()); document.body.classList.remove("modal-open"); });
await page.waitForFunction(() => !!(window._dwLayerCtrl && window._dwLayerCtrl._map), { timeout: 15_000 });
await page.evaluate(() => window._dwLayerCtrl._map.setView([-26.658, 153.100], 16));
await page.evaluate(() => {
	const map = window._dwLayerCtrl._map, ctrl = window._dwLayerCtrl;
	const vex = ctrl._layers.find((l) => l.name === "Vexcel Aerial")?.layer;
	ctrl._layers.filter((l) => !l.overlay).forEach((l) => { if (l.layer !== vex && map.hasLayer(l.layer)) map.removeLayer(l.layer); });
	if (!map.hasLayer(vex)) map.addLayer(vex);
});
// Give the basemap tiles time to fail (403) and the burst detector to fire.
await page.waitForTimeout(9000);

console.log(`\n=== Vexcel token-rejection re-prompt ===`);
console.log(`  basemap tile 403s: ${tile403}`);
console.log(`  fresh-token prompt fired: ${promptFired}  ${promptMsg ? `("${promptMsg}…")` : ""}`);
// If the token is genuinely rejected (403s observed), the prompt MUST
// fire. If the token happens to be valid (no 403s), this check is N/A.
const ok = tile403 === 0 || promptFired;
console.log(`\n${ok ? "✓ PASS" : "✗ FAIL"} — ${tile403 ? (promptFired ? "rejected token re-prompts" : "rejected token did NOT re-prompt") : "token accepted (no 403 to test)"}`);
await browser.close();
process.exit(ok ? 0 : 1);
