#!/usr/bin/env node
// Verify "POIs along route" on a saved plan: the planner-toolbar button finds
// POIs from OpenFreeMap vector tiles, pins them in route order, filters by
// category, adds a POI as a planner waypoint, and never leaks clicks to the
// planner (which would add route points). Nothing is saved.
//
//   npm run e2e:route-pois            PLAN=/plan/<id> to use another route
import { chromium } from "playwright";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const auth = resolve(root, ".auth", "storage.json");
const reportDir = resolve(root, "test-results");
const url = "https://dynamic.watch" + (process.env.PLAN || "/plan/2344645");
if (!existsSync(auth)) {
	console.error(`No auth state at ${auth} — run \`npm run e2e:auth\` first.`);
	process.exit(2);
}

const results = [];
const check = (ok, label, detail = "") => {
	results.push(ok);
	console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch({ headless: !process.env.HEADED });
try {
	const context = await browser.newContext({ storageState: auth, viewport: { width: 1400, height: 900 } });
	await context.addInitScript({ content: readFileSync(resolve(root, "tests/e2e/lib/bootstrap.js"), "utf8") });
	await context.addInitScript({ content: readFileSync(resolve(root, "dynamicwatch-custom-tiles.user.js"), "utf8") });
	const page = await context.newPage();
	const pageErrors = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	console.log(`→ ${url}`);
	await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
	if (page.url().includes("/users/sign_in")) throw new Error("Redirected to sign_in — run `npm run e2e:auth`.");
	await page.waitForSelector("#dw-poi-btn", { timeout: 30_000 });
	await page.waitForFunction(() => (window.leafletPlan?.lines || []).flat().some((s) => s?.polyline), undefined, { timeout: 30_000 });
	// The site opens its help modal on load; it would intercept real clicks.
	await page.waitForTimeout(1500);
	await page.evaluate(() => {
		document.querySelectorAll(".modal, .modal-backdrop").forEach((el) => el.remove());
		document.body.classList.remove("modal-open");
	});
	const routeMarkers = () => page.evaluate(() =>
		window.leafletPlan.lines.flat().filter((s) => s && s.marker_end).length);
	const startMarkers = await routeMarkers();
	await page.evaluate(() => {
		const bounds = L.latLngBounds(window.leafletPlan.lines.flat()
			.flatMap((s) => (s.polyline ? s.polyline.getLatLngs().flat(3) : [])));
		window.leafletPlan.map.fitBounds(bounds, { padding: [40, 40] });
	});

	const started = Date.now();
	await page.click("#dw-poi-btn");
	await page.waitForFunction(() => /within .* route/.test(document.querySelector(".dw-poi-status")?.textContent || "") ||
		document.querySelector(".dw-poi-status--error"), undefined, { timeout: 90_000 });
	const found = await page.evaluate(() => {
		const rows = [...document.querySelectorAll(".dw-poi-row")];
		return {
			status: document.querySelector(".dw-poi-status").textContent,
			error: !!document.querySelector(".dw-poi-status--error"),
			rows: rows.length,
			km: rows.map((r) => parseFloat(r.querySelector(".dw-poi-km").textContent)),
			markers: document.querySelectorAll(".leaflet-marker-pane .dw-poi-icon").length,
			chips: [...document.querySelectorAll(".dw-poi-chip")].map((c) => ({
				id: c.dataset.poiCat, count: Number(c.querySelector(".dw-poi-count").textContent) })),
			active: document.getElementById("dw-poi-btn").classList.contains("active"),
		};
	});
	console.log(`  ${found.status} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
	check(!found.error && found.rows > 0, "button finds POIs along the saved route", `${found.rows} listed`);
	check(found.markers === found.rows, "every listed POI is pinned on the map", `${found.markers} markers`);
	check(found.km.every((km, i) => i === 0 || km >= found.km[i - 1]), "list is ordered by distance along the route");
	check(found.active, "toolbar button shows the active state");
	mkdirSync(reportDir, { recursive: true });
	const shot = resolve(reportDir, `route-pois-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
	await page.screenshot({ path: shot });

	const chip = found.chips[0];
	await page.click(`.dw-poi-chip[data-poi-cat="${chip.id}"]`);
	const hiddenCount = await page.locator(".leaflet-marker-pane .dw-poi-icon").count();
	await page.click(`.dw-poi-chip[data-poi-cat="${chip.id}"]`);
	const shownCount = await page.locator(".leaflet-marker-pane .dw-poi-icon").count();
	check(hiddenCount === found.markers - chip.count && shownCount === found.markers,
		`category chip hides and restores its pins (${chip.id})`, `${found.markers} → ${hiddenCount} → ${shownCount}`);

	// A real click on a pin opens its popup without adding a route point.
	const icons = page.locator(".leaflet-marker-pane .dw-poi-icon");
	let clicked = false;
	for (let i = 0; i < Math.min(await icons.count(), 15) && !clicked; i++) {
		try {
			await icons.nth(i).click({ timeout: 1500 });
			clicked = await page.locator(".dw-poi-pop").isVisible();
		} catch (_) {}
	}
	check(clicked, "clicking a pin opens its POI popup");
	await page.click(".dw-poi-status");
	check(await routeMarkers() === startMarkers, "pin and panel clicks never add route points");

	const before = await page.evaluate(() => window.leafletPlan.waypoints.length);
	await page.locator(".dw-poi-row").first().click();
	await page.waitForSelector(".dw-poi-pop .dw-poi-add-btn:not([disabled])", { timeout: 5_000 });
	const expected = await page.evaluate(() => document.querySelector(".dw-poi-pop b").textContent.trim().slice(0, 16).trim());
	await page.click(".dw-poi-pop .dw-poi-add-btn");
	const added = await page.evaluate(() => ({
		count: window.leafletPlan.waypoints.length,
		name: window.leafletPlan.waypoints.at(-1)?.name,
		changed: window.leafletPlan.changed,
		disabled: document.querySelector(".dw-poi-pop .dw-poi-add-btn")?.disabled,
		rowDone: document.querySelector(".dw-poi-row .dw-poi-row-add")?.disabled,
		status: document.querySelector(".dw-poi-status")?.textContent,
	}));
	if (added.count !== before + 1) console.log(`  status after add: ${added.status}`);
	check(added.count === before + 1 && added.name === expected && added.changed,
		"Add as waypoint creates a named planner waypoint", JSON.stringify({ name: added.name, expected }));
	check(added.disabled && added.rowDone, "added POI is marked done in the popup and list");
	check(await routeMarkers() === startMarkers, "adding a waypoint leaves the route unchanged");

	// The site's Undo removes the waypoint; the POI list follows the plan.
	await page.click("#undo");
	const undone = await page.waitForFunction((count) => window.leafletPlan.waypoints.length === count &&
		document.querySelector(".dw-poi-row .dw-poi-row-add")?.disabled === false, before, { timeout: 10_000 })
		.then(() => true).catch(() => false);
	check(undone, "planner Undo removes the waypoint and re-enables the POI");
	check(await routeMarkers() === startMarkers, "Undo restores the original route");

	await page.click("#dw-poi-btn");
	const cleared = await page.evaluate(() => ({
		panel: !!document.querySelector(".dw-poi-panel"),
		markers: document.querySelectorAll(".dw-poi-icon").length,
		active: document.getElementById("dw-poi-btn").classList.contains("active"),
	}));
	check(!cleared.panel && !cleared.markers && !cleared.active, "pressing the button again clears POIs");
	check(pageErrors.length === 0, "no page errors", pageErrors.slice(0, 2).join(" | "));
	console.log(`  screenshot: ${shot}`);
} catch (error) {
	console.error(`✗ Route POIs: ${error.message}`);
	results.push(false);
} finally {
	await browser.close();
}
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
