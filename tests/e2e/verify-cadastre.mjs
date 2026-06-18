#!/usr/bin/env node
// Desktop (hover-capable) cadastre interaction:
//   1. NO hover-identify tooltip when hovering a parcel (hover removed).
//   2. Parcel info appears in the location popup (the right-click/click
//      menu) on desktop.
//   3. Sales data auto-loads + embeds in that popup (no "Sales ↗" click).
//   4. The location-popup map button opens a Google Maps PIN (maps?q=),
//      not the glitchy Street View panorama deep-link.
import { chromium } from "playwright";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..", "..");
const STATE = resolve(REPO, ".auth", "storage.json");
if (!existsSync(STATE)) { console.error("auth"); process.exit(2); }

const browser = await chromium.launch({ headless: !process.env.HEADED, args: ["--disable-web-security", "--disable-features=IsolateOrigins,site-per-process"] });
// NO touch emulation → hover-capable desktop (matchMedia hover:hover).
const ctx = await browser.newContext({ storageState: STATE, viewport: { width: 1400, height: 900 } });
await ctx.addInitScript({ content: readFileSync(resolve(__dirname, "lib", "bootstrap.js"), "utf8") });
await ctx.addInitScript({ content: readFileSync(resolve(REPO, "dynamicwatch-custom-tiles.user.js"), "utf8") });
await ctx.addInitScript(() => { window.__opens = []; window.open = (url) => { window.__opens.push(url); return null; }; });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto("https://dynamic.watch/plan", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForSelector(".leaflet-planner-controls", { timeout: 30000 });
const nuke = () => page.evaluate(() => { document.querySelectorAll(".modal,.modal-backdrop").forEach(e=>e.remove()); document.body.classList.remove("modal-open"); });
await nuke();
await page.waitForFunction(() => !!(window._dwLayerCtrl && window._dwLayerCtrl._map), { timeout: 15000 });
const hoverCapable = await page.evaluate(() => window.matchMedia("(hover: hover)").matches);
console.log(`  desktop hover-capable: ${hoverCapable}`);

// Enable Cadastre at a Brisbane CBD parcel (Queen St) above identify floor.
await page.evaluate(() => {
	const ctrl = window._dwLayerCtrl, map = ctrl._map;
	map.setView([-27.4679, 153.0281], 17);
	const cad = ctrl._layers.find((l) => l.name === "QLD Cadastre" && l.overlay);
	if (cad && !map.hasLayer(cad.layer)) map.addLayer(cad.layer);
});
await page.waitForTimeout(1500);

// 1. Hover over the map centre repeatedly — assert NO cadastre tooltip.
console.log("\n=== 1. hover produces NO cadastre tooltip ===");
const box = await page.evaluate(() => {
	const r = window._dwLayerCtrl._map.getContainer().getBoundingClientRect();
	return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
for (let i = 0; i < 6; i++) {
	await page.mouse.move(box.x + i * 4, box.y + i * 3);
	await page.waitForTimeout(120);
}
await page.waitForTimeout(1200);
const tip = await page.evaluate(() =>
	document.querySelectorAll(".leaflet-tooltip.dw-cad-tip, .dw-cad-tip").length);
console.log(`  .dw-cad-tip tooltips after hover: ${tip} (want 0)`);

// 2+3. Open a site-shaped location popup; assert cadastre section + sales auto-embed.
console.log("\n=== 2+3. location popup: cadastre info + auto-loaded sales ===");
await page.evaluate(() => {
	const map = window._dwLayerCtrl._map;
	const lat = -27.4679, lng = 153.0281;
	L.popup({ minWidth: 240 })
		.setLatLng([lat, lng])
		.setContent(
			`<div class="popup-on-location">` +
			`<div id="waypoint-popup-title">${lat.toFixed(6)},${lng.toFixed(6)}</div>` +
			`<button type="button">Add point</button></div>`)
		.openOn(map);
});
await page.waitForTimeout(9000); // identify + address + sales
const popup = await page.evaluate(() => {
	const cad = document.querySelector(".dw-popup-ident-cad");
	const sales = document.querySelector(".dw-popup-ident-sales");
	const svBtn = document.querySelector(".dw-sv-btn");
	return {
		cadPresent: !!cad,
		cadText: cad ? cad.textContent.slice(0, 100) : null,
		salesPresent: !!sales,
		salesText: sales ? sales.textContent.slice(0, 120) : null,
		noSalesLink: !document.querySelector(".dw-cad-sales-link"),
		mapBtnLabel: svBtn ? svBtn.textContent.trim() : null,
	};
});
console.log(`  cadastre section: ${popup.cadPresent} — ${popup.cadText}`);
console.log(`  sales section auto-embedded: ${popup.salesPresent} — ${popup.salesText}`);
console.log(`  separate Sales link suppressed: ${popup.noSalesLink}`);

// 4. Map button opens a Google Maps PIN, not a Street View deep-link.
console.log("\n=== 4. map button → Google Maps pin (not SV panorama) ===");
await page.evaluate(() => { const b = document.querySelector(".dw-sv-btn"); if (b) b.click(); });
await page.waitForTimeout(400);
const opened = await page.evaluate(() => window.__opens[window.__opens.length - 1] || null);
console.log(`  button label: "${popup.mapBtnLabel}"`);
console.log(`  opened URL: ${opened}`);
const pinOk = !!opened && /google\.com\/maps\?q=/.test(opened) && !/3a,|!1e1/.test(opened);

const ok =
	tip === 0 &&
	popup.cadPresent && popup.salesPresent && popup.noSalesLink &&
	pinOk && errors.length === 0;
console.log(`\n  no hover tooltip: ${tip===0?"✓":"✗"}   popup cadastre+sales: ${popup.cadPresent&&popup.salesPresent&&popup.noSalesLink?"✓":"✗"}   maps-pin button: ${pinOk?"✓":"✗"}`);
console.log(`  page errors: ${errors.length}`);
console.log(`${ok ? "✓ PASS" : "✗ FAIL"} — cadastre right-click-only + auto-sales + maps pin`);
await browser.close();
process.exit(ok ? 0 : 1);
