#!/usr/bin/env node
// Verify "POIs along route" on a saved plan: the planner-toolbar button finds
// POIs from OpenFreeMap vector tiles, pins them in route order, filters by
// category, reports and highlights the longest stretch without water, adds a
// POI as a planner waypoint, estimates arrival times with daylight and the
// forecast, follows route edits, and never leaks clicks to the planner
// (which would add route points). Nothing is saved.
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
			gaps: document.querySelector(".dw-poi-gaps")?.textContent.trim() || "",
		};
	});
	console.log(`  ${found.status} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
	check(!found.error && found.rows > 0, "button finds POIs along the saved route", `${found.rows} listed`);
	check(found.markers === found.rows, "every listed POI is pinned on the map", `${found.markers} markers`);
	check(found.km.every((km, i) => i === 0 || km >= found.km[i - 1]), "list is ordered by distance along the route");
	check(found.active, "toolbar button shows the active state");
	const waterChip = found.chips.find((c) => c.id === "water");
	check(waterChip ? /Longest stretch without water: [\d.]+ (km|mi)/.test(found.gaps)
		: /No drinking water within/.test(found.gaps), "panel reports the water situation", found.gaps);

	// Timing: a flat estimate at once, refined with elevation, then the forecast.
	const timingText = () => page.evaluate(() => document.querySelector(".dw-poi-timing-out")?.textContent || "");
	await page.waitForFunction(() => {
		const text = document.querySelector(".dw-poi-timing-out")?.textContent || "";
		return /Finish ≈/.test(text) && !/estimating climbs|Loading the forecast/.test(text);
	}, undefined, { timeout: 45_000 }).catch(() => {});
	const timing = await timingText();
	console.log(`  timing: ${timing}`);
	const ascent = Number((/↑\s(\d+)\sm/.exec(timing) || [])[1]);
	check(/Finish ≈ .+ moving/.test(timing) && ascent > 100 && ascent < 3000,
		"timing estimates the finish with climbing from elevation data", `↑ ${ascent} m`);
	check(/Daylight all the way|In the dark:/.test(timing), "timing reports daylight along the route");
	check(/-?\d+ °C–-?\d+ °C/.test(timing), "timing shows the forecast along the route");
	const timedPanel = await page.evaluate(() => ({
		gaps: document.querySelector(".dw-poi-gaps")?.textContent || "",
		rowsTimed: [...document.querySelectorAll(".dw-poi-row .dw-poi-km")].every((el) => /· \d\d:\d\d$/.test(el.textContent)),
	}));
	check(/about \d+ (h|min).*rough guide [\d.–]+ L/.test(timedPanel.gaps), "water gap shows time and a drinking guide", timedPanel.gaps);
	check(timedPanel.rowsTimed, "list rows show arrival times");
	const movingMinutes = (text) => {
		const m = /(?:(\d+) h )?(\d+)(?: min)? moving/.exec(text);
		return m ? Number(m[1] || 0) * 60 + Number(m[2]) : NaN;
	};
	const pace = page.locator("[data-poi-pace]");
	await pace.fill("5:00");
	await page.waitForTimeout(1200);
	const view = () => page.evaluate(() => { const m = window.leafletPlan.map; return `${m.getZoom()} ${m.getCenter()}`; });
	const viewBefore = await view();
	await pace.press("ArrowLeft");
	await pace.press("-");
	await pace.press("Backspace");
	await page.waitForTimeout(900);
	const repaced = await page.evaluate(() => ({
		focused: !!document.activeElement?.matches?.("[data-poi-pace]"),
		value: document.querySelector("[data-poi-pace]")?.value,
		text: document.querySelector(".dw-poi-timing-out")?.textContent || "",
	}));
	const [slow, fast] = [movingMinutes(timing), movingMinutes(repaced.text)];
	check(Math.abs(fast / slow - 5 / 6) < 0.03 && repaced.focused && repaced.value === "5:00",
		"a faster pace scales the estimate while the field keeps focus", `${slow} → ${fast} min`);
	check(await view() === viewBefore, "typing in the timing fields leaves the map alone");
	await pace.fill("6:00");
	await page.waitForTimeout(900);
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
	check(await page.waitForFunction((summary) => document.querySelector(".dw-poi-status")?.textContent === summary,
		found.status, { timeout: 5_000 }).then(() => true).catch(() => false),
	"after Undo the panel shows the search summary again, not the stale \"Added\" note");
	check(await routeMarkers() === startMarkers, "Undo restores the original route");

	// Waypoint names can carry the distance and arrival time to the watch.
	await page.waitForFunction(() => /within .* route/.test(document.querySelector(".dw-poi-status")?.textContent || "") &&
		document.querySelector("[data-poi-names]"), undefined, { timeout: 30_000 });
	await page.selectOption("[data-poi-names]", "km-time");
	await page.locator(".dw-poi-row .dw-poi-row-add:not([disabled])").first().click();
	const timedName = await page.evaluate(() => window.leafletPlan.waypoints.at(-1)?.name || "");
	check(/^\d+(\.\d)?k \d\d:\d\d \S/.test(timedName) && timedName.length <= 16,
		"waypoint names can include distance and arrival time", timedName);
	await page.click("#undo");
	await page.waitForFunction((count) => window.leafletPlan.waypoints.length === count, before, { timeout: 10_000 }).catch(() => {});
	await page.selectOption("[data-poi-names]", "name");

	// Editing the route re-runs the search by itself. Append a temporary
	// stretch along the Mooloolaba esplanade (taps, cafés, toilets), then
	// take it away again. The plan is never saved.
	const status = () => page.evaluate(() => document.querySelector(".dw-poi-status")?.textContent || "");
	const settled = (prev) => page.waitForFunction((p) => {
		const t = document.querySelector(".dw-poi-status")?.textContent || "";
		return /within .* route/.test(t) && t !== p;
	}, prev, { timeout: 30_000 }).then(() => true).catch(() => false);
	// Undo can re-run the search (the planner rounds restored points); let that
	// settle so the baseline is a search result, not a waypoint message.
	const isResult = () => page.waitForFunction(() =>
		/within .* route/.test(document.querySelector(".dw-poi-status")?.textContent || ""), undefined, { timeout: 30_000 });
	await isResult();
	await page.waitForTimeout(3500);
	await isResult();
	const original = await status();
	await page.evaluate(() => {
		const pts = [[-26.6826, 153.1196], [-26.6790, 153.1205], [-26.6745, 153.1180], [-26.6700, 153.1150],
			[-26.6655, 153.1110], [-26.6600, 153.1050], [-26.6540, 153.0990], [-26.6480, 153.0960]];
		const polyline = L.polyline(pts, { color: "#c0f" }).addTo(window.leafletPlan.map);
		window._dwTestSeg = { polyline, marker_end: null };
		window.leafletPlan.lines[0].push(window._dwTestSeg);
	});
	const editStarted = Date.now();
	const followed = await settled(original);
	const extended = await page.evaluate(() => ({
		status: document.querySelector(".dw-poi-status").textContent,
		gaps: document.querySelector(".dw-poi-gaps")?.textContent.trim() || "",
		water: Number(document.querySelector('.dw-poi-chip[data-poi-cat="water"] .dw-poi-count')?.textContent || 0),
	}));
	console.log(`  after edit: ${extended.status} (${((Date.now() - editStarted) / 1000).toFixed(1)} s)`);
	check(followed && extended.status !== original, "POIs update by themselves when the route changes");
	check(extended.water > 0 && /Longest stretch without water: [\d.]+ km \([\d.]+–[\d.]+ km\)/.test(extended.gaps),
		"water gap is measured once the route passes water", extended.gaps);
	await page.click('.dw-poi-gap[data-poi-gap="water"]');
	await page.waitForTimeout(800);
	const highlight = await page.evaluate(() => {
		const map = window.leafletPlan.map;
		const lines = Object.values(map._layers).filter((l) => l.options && l.options.dashArray === "10 8" && l.getBounds);
		return { count: lines.length, inView: lines.length > 0 && lines.every((l) => map.getBounds().pad(0.05).contains(l.getBounds())) };
	});
	check(highlight.count > 0 && highlight.inView, "clicking the gap highlights that stretch and fits it in view",
		JSON.stringify(highlight));
	const gapShot = resolve(reportDir, `route-pois-gap-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
	await page.screenshot({ path: gapShot });
	const beforeRemoval = await status();
	await page.evaluate(() => {
		const line = window.leafletPlan.lines[0];
		line.splice(line.indexOf(window._dwTestSeg), 1);
		window.leafletPlan.map.removeLayer(window._dwTestSeg.polyline);
	});
	const restored = await settled(beforeRemoval);
	const finalStatus = await status();
	check(restored && finalStatus === original && finalStatus === found.status,
		"removing the stretch restores the original results", finalStatus);
	check(await page.evaluate(() => !Object.values(window.leafletPlan.map._layers)
		.some((l) => l.options && l.options.dashArray === "10 8")), "a new search clears the old gap highlight");

	await page.click("#dw-poi-btn");
	const cleared = await page.evaluate(() => ({
		panel: !!document.querySelector(".dw-poi-panel"),
		markers: document.querySelectorAll(".dw-poi-icon").length,
		active: document.getElementById("dw-poi-btn").classList.contains("active"),
	}));
	check(!cleared.panel && !cleared.markers && !cleared.active, "pressing the button again clears POIs");
	check(pageErrors.length === 0, "no page errors", pageErrors.slice(0, 2).join(" | "));
	console.log(`  screenshots: ${shot}\n               ${gapShot}`);
} catch (error) {
	console.error(`✗ Route POIs: ${error.message}`);
	results.push(false);
} finally {
	await browser.close();
}
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
