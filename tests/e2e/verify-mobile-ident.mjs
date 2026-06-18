#!/usr/bin/env node
// Mobile interaction verification (touch-emulated):
//   1. With Cadastre active, the site's add-point popup gets enriched
//      with the parcel identify (lot/plan + Sales link) — mobile's
//      replacement for the desktop hover tooltip.
//   2. Geocache hit-area taps do NOT propagate to the map container
//      (the site would interpret them as add-a-waypoint), and DO fire
//      the cache click handler.
import { chromium, devices } from "playwright";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..", "..");
const STATE = resolve(REPO, ".auth", "storage.json");
if (!existsSync(STATE)) { console.error("run npm run e2e:auth first"); process.exit(2); }

const browser = await chromium.launch({ headless: !process.env.HEADED, args: ["--disable-web-security", "--disable-features=IsolateOrigins,site-per-process"] });
// Touch-primary emulation: gives `matchMedia('(hover: none)')` = true,
// which is the gate `_injectIdentifyIntoPopup` checks.
const ctx = await browser.newContext({
	...devices["Pixel 7"],
	storageState: STATE,
});
const userscriptSrc = readFileSync(resolve(REPO, "dynamicwatch-custom-tiles.user.js"), "utf8");
const connectList = [...userscriptSrc.matchAll(/^\/\/ @connect\s+(\S+)/gm)].map((m) => m[1]);
await ctx.addInitScript({ content: `window.__dwConnectList = ${JSON.stringify(connectList)};` });
await ctx.addInitScript({ content: readFileSync(resolve(__dirname, "lib", "bootstrap.js"), "utf8") });
await ctx.addInitScript({ content: userscriptSrc });
const page = await ctx.newPage();
const logs = [];
page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`));

await page.goto("https://dynamic.watch/plan", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForSelector(".leaflet-planner-controls", { timeout: 30000 });
await page.evaluate(() => { document.querySelectorAll(".modal,.modal-backdrop").forEach(e=>e.remove()); document.body.classList.remove("modal-open"); });
await page.waitForFunction(() => !!(window._dwLayerCtrl && window._dwLayerCtrl._map), { timeout: 15000 });

const hoverNone = await page.evaluate(() => window.matchMedia("(hover: none)").matches);
console.log(`  touch emulation active (hover:none): ${hoverNone}`);

// --- Test 1: cadastre identify injected into the site-shaped popup ----
await page.evaluate(() => {
	const map = window._dwLayerCtrl._map, ctrl = window._dwLayerCtrl;
	// Brisbane CBD parcel, zoom above the cadastre identify floor (14).
	map.setView([-27.4679, 153.0281], 16);
	const cad = ctrl._layers.find((l) => l.name === "QLD Cadastre" && l.overlay);
	if (cad && !map.hasLayer(cad.layer)) map.addLayer(cad.layer);
});
await page.waitForTimeout(1200);

// Open a popup shaped exactly like dynamic.watch's add-point popup —
// same DOM the popupopen hook keys on. (Driving the site's own tap flow
// is modal-flaky in emulation; the hook only sees the popup DOM, so this
// exercises the identical code path.)
await page.evaluate(() => {
	const map = window._dwLayerCtrl._map;
	const lat = -27.4679, lng = 153.0281;
	L.popup({ minWidth: 220 })
		.setLatLng([lat, lng])
		.setContent(
			`<div class="popup-on-location">` +
			`<div id="waypoint-popup-title">${lat.toFixed(6)},${lng.toFixed(6)}</div>` +
			`<button type="button">Add point</button>` +
			`</div>`)
		.openOn(map);
});
// identify + address + auto-loaded sales are several round-trips.
await page.waitForTimeout(8000);
const ident = await page.evaluate(() => {
	const sec = document.querySelector(".dw-popup-ident-cad");
	// Sales now auto-load + embed (no separate "Sales ↗" link).
	const salesSec = document.querySelector(".dw-popup-ident-sales");
	return {
		present: !!sec,
		text: sec ? sec.textContent.slice(0, 120) : null,
		salesEmbedded: !!salesSec,
		noSalesLink: !document.querySelector(".dw-cad-sales-link"),
	};
});
console.log(`  popup cadastre section: present=${ident.present}  sales auto-embedded=${ident.salesEmbedded}  (link suppressed=${ident.noSalesLink})`);
console.log(`    text: ${ident.text}`);

// --- Test 2: geocache tap containment ---------------------------------
await page.evaluate(() => {
	const map = window._dwLayerCtrl._map, ctrl = window._dwLayerCtrl;
	map.closePopup();
	map.setView([-27.4504, 153.0238], 12); // UQ-Herston cache cell
	const geo = ctrl._layers.find((l) => l.name === "Geocaches" && l.overlay);
	if (geo && !map.hasLayer(geo.layer)) map.addLayer(geo.layer);
});
// Geocache markers need the UTFGrid fetch (+ Referer; warm tiles assumed
// from prior runs — if cold this still warms via the GM shim).
await page.waitForTimeout(8000);

// Phase 1: install probes (persisted on window) and tap the icon.
// On touch, the FIRST tap must NOT open the listing directly — it opens an
// anchored stats popup (.dw-geo-pop). The listing opens only from the popup's
// "View full listing" button. The tap must still not leak to the map container.
const tapStart = await page.evaluate(() => {
	const map = window._dwLayerCtrl._map;
	window.__dwTap = { containerClicks: 0, opened: null };
	map.getContainer().addEventListener("click", () => window.__dwTap.containerClicks++);
	window.open = (url) => { window.__dwTap.opened = url; return null; };

	const icon = document.querySelector(".dw-geo-icon");
	if (!icon) return { error: "no geocache icon on screen" };
	icon.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
	return { clicksAfterIconTap: window.__dwTap.containerClicks };
});
// The popup appears AFTER the async map.details fetch — poll for it.
let popupSeen = false, openedDuringTap = null;
if (!tapStart.error) {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline && !popupSeen) {
		const st = await page.evaluate(() => ({
			pop: !!document.querySelector(".dw-geo-pop"),
			opened: window.__dwTap.opened,
		}));
		popupSeen = st.pop;
		openedDuringTap = st.opened;
		if (!popupSeen) await page.waitForTimeout(400);
	}
}
// Tapping the popup's button SHOULD open the listing.
let openedFromButton = null;
if (popupSeen) {
	await page.evaluate(() => { const b = document.querySelector(".dw-geo-pop-open"); if (b) b.click(); });
	await page.waitForTimeout(400);
	openedFromButton = await page.evaluate(() => window.__dwTap.opened);
}
// Phase 2: control — a click on the map itself SHOULD reach the container.
const tapEnd = await page.evaluate(() => {
	const map = window._dwLayerCtrl._map;
	const before = window.__dwTap.containerClicks;
	map.getContainer().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
	return { iconTapLeaks: before, controlReached: window.__dwTap.containerClicks > before };
});
const tap = {
	...tapStart, ...tapEnd,
	popupSeen,
	openedDuringTap,                                  // want: null (no direct open)
	openedFromButton: openedFromButton && openedFromButton.slice(0, 60),
};
console.log(`  geocache tap: ${JSON.stringify(tap)}`);

const t1 = ident.present && ident.salesEmbedded && ident.noSalesLink;
const t2 = !tap.error && tap.iconTapLeaks === 0 && tap.controlReached &&
	tap.popupSeen && !tap.openedDuringTap &&
	(tap.openedFromButton || "").includes("geocaching.com");
const ok = t1 && t2;
console.log(`\n  popup enrichment (cadastre + auto-sales, no link): ${t1 ? "✓" : "✗"}   geocache tap→popup→listing: ${t2 ? "✓" : "✗"}`);
console.log(`${ok ? "✓ PASS" : "✗ FAIL"} — mobile layer interactions`);
await browser.close();
process.exit(ok ? 0 : 1);
