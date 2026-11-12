#!/usr/bin/env node
// Verify "POIs along route" on a saved plan: the planner-toolbar button finds
// POIs from OpenFreeMap vector tiles, pins them in route order, filters by
// category, reports and highlights the longest stretch without water, adds a
// POI as a planner waypoint, finds course features (climbs, creek crossings,
// track sections), follows route edits, and never leaks clicks to the planner
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
let page = null;
try {
	const context = await browser.newContext({ storageState: auth, viewport: { width: 1400, height: 900 } });
	await context.addInitScript({ content: readFileSync(resolve(root, "tests/e2e/lib/bootstrap.js"), "utf8") });
	await context.addInitScript({ content: readFileSync(resolve(root, "dynamicwatch-custom-tiles.user.js"), "utf8") });
	page = await context.newPage();
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
	// The script's toolbar buttons must sit in the row like the site's own.
	await page.waitForSelector("#dw-3d-btn", { timeout: 15_000 }).catch(() => {});
	const toolbar = await page.evaluate(() => {
		const row = document.querySelector(".leaflet-planner-controls");
		const kids = [...row.children].filter((el) => getComputedStyle(el).display !== "none");
		const rects = kids.map((el) => el.getBoundingClientRect());
		return {
			ids: kids.map((el) => el.id || el.className.split(" ")[0]),
			gaps: rects.slice(1).map((r, i) => Math.round((r.left - rects[i].right) * 10) / 10),
			lines: new Set(rects.map((r) => Math.round(r.top))).size,
		};
	});
	const nativeGap = toolbar.gaps[0];
	check(toolbar.ids.includes("dw-3d-btn") && toolbar.ids.includes("dw-poi-btn") && toolbar.lines === 1 &&
		toolbar.gaps.every((gap) => Math.abs(gap - nativeGap) <= 0.6),
	"toolbar buttons added by the script are spaced like the native ones", `gaps ${toolbar.gaps.join(", ")} px`);
	// ...and show the same label when pointed at.
	const hoverLabel = async (selector) => {
		await page.mouse.move(700, 300);
		await page.waitForTimeout(350);
		await page.hover(selector);
		await page.waitForTimeout(600);
		return page.evaluate((sel) => {
			const btn = document.querySelector(sel), tips = [...document.querySelectorAll(".tooltip")];
			const b = btn.getBoundingClientRect(), t = tips[0] ? tips[0].getBoundingClientRect() : null;
			return {
				count: tips.length, cls: tips[0] ? tips[0].className : "", text: tips[0] ? tips[0].textContent : "",
				above: t ? Math.round(b.top - t.bottom) : null, title: btn.getAttribute("title") || "",
			};
		}, selector);
	};
	const nativeLabel = await hoverLabel("#undo");
	const labels = [await hoverLabel("#dw-3d-btn"), await hoverLabel("#dw-poi-btn")];
	await page.mouse.move(700, 300);
	check(nativeLabel.count === 1 && nativeLabel.text.length > 0 &&
		labels.every((l) => l.count === 1 && l.cls === nativeLabel.cls && l.above === nativeLabel.above && !l.title) &&
		labels[0].text === "Toggle 3D terrain" && labels[1].text === "Find POIs along the route",
	"the script's toolbar buttons show the same hover label as the native ones",
	`"${labels[0].text}", "${labels[1].text}", ${labels[1].above} px above like "${nativeLabel.text}"`);
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
	const activeLabel = await hoverLabel("#dw-poi-btn");
	await page.mouse.move(700, 300);
	check(activeLabel.count === 1 && activeLabel.text === "Clear route POIs", "the POI button's label follows its state",
		activeLabel.text);
	const waterChip = found.chips.find((c) => c.id === "water");
	check(waterChip ? /Longest stretch without water: [\d.]+ (km|mi)/.test(found.gaps)
		: /No drinking water within/.test(found.gaps), "panel reports the water situation", found.gaps);
	const counts = Object.fromEntries(found.chips.map((c) => [c.id, c.count]));
	check(counts.climb > 0 && counts.climbtop === counts.climb, "climbs and their tops come from elevation data",
		`${counts.climb || 0} climbs`);
	check(counts.creek > 0, "creek crossings are found on the route", `${counts.creek || 0}`);
	check(counts.track > 0, "named track and road sections are found", `${counts.track || 0}`);
	check(/ · \d+ course points?/.test(found.status), "the status counts course points separately", found.status);
	await page.locator(".dw-poi-row", { hasText: /^Climb \d+m/ }).first().click();
	const climbPopup = await page.waitForSelector(".dw-poi-pop", { timeout: 5_000 }).then((el) => el.textContent()).catch(() => "");
	check(/average \d+% · steepest \d+%/.test(climbPopup) && /Top at [\d.]+ km/.test(climbPopup),
		"a climb's popup shows its gradient and where it ends", climbPopup.replace(/\s+/g, " ").slice(0, 160));
	await page.evaluate(() => window.leafletPlan.map.closePopup());

	const listHeight = await page.evaluate(() => document.querySelector(".dw-poi-list")?.clientHeight || 0);
	check(listHeight >= 100, "the list keeps room for several rows", `${listHeight}px`);
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
	// Close the pin's popup so the row's own popup is the one read below.
	await page.evaluate(() => window.leafletPlan.map.closePopup());
	const firstRow = page.locator(".dw-poi-row").first();
	const rowName = (await firstRow.locator(".dw-poi-name").textContent()).trim();
	await firstRow.click();
	await page.waitForFunction((name) => document.querySelector(".dw-poi-pop b")?.textContent.trim() === name,
		rowName, { timeout: 5_000 });
	await page.waitForSelector(".dw-poi-pop .dw-poi-add-btn:not([disabled])", { timeout: 5_000 });
	const besidePanel = await page.evaluate(() => {
		const a = document.querySelector(".leaflet-popup").getBoundingClientRect();
		const b = document.querySelector(".dw-poi-panel").getBoundingClientRect();
		return a.left >= b.right || a.top >= b.bottom || a.bottom <= b.top;
	});
	check(besidePanel, "a list click opens its popup beside the panel, not under it");
	const expected = await page.evaluate(() => document.querySelector(".dw-poi-pop b").textContent.trim().slice(0, 16).trim());
	await page.click(".dw-poi-pop .dw-poi-add-btn");
	const added = await page.evaluate(() => ({
		count: window.leafletPlan.waypoints.length,
		name: window.leafletPlan.waypoints.at(-1)?.name,
		changed: window.leafletPlan.changed,
		disabled: document.querySelector(".dw-poi-pop .dw-poi-add-btn")?.disabled,
		rowDone: !!document.querySelector(".dw-poi-row .dw-poi-row-add")?.classList.contains("dw-poi-row-add--added"),
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
		document.querySelector(".dw-poi-row .dw-poi-row-add")?.classList.contains("dw-poi-row-add--added") === false, before, { timeout: 10_000 })
		.then(() => true).catch(() => false);
	check(undone, "planner Undo removes the waypoint and re-enables the POI");
	check(await page.waitForFunction((summary) => document.querySelector(".dw-poi-status")?.textContent === summary,
		found.status, { timeout: 5_000 }).then(() => true).catch(() => false),
	"after Undo the panel shows the search summary again, not the stale \"Added\" note");
	check(await routeMarkers() === startMarkers, "Undo restores the original route");

	// Waypoint names can carry the distance to the watch.
	await page.waitForFunction(() => /within .* route/.test(document.querySelector(".dw-poi-status")?.textContent || "") &&
		document.querySelector("[data-poi-names]"), undefined, { timeout: 30_000 });
	await page.selectOption("[data-poi-names]", "km");
	const ownNames = await page.evaluate(() => window.leafletPlan.waypoints.map((w) => w.name));
	const plusRow = page.locator(".dw-poi-row", { has: page.locator(".dw-poi-row-add:not(.dw-poi-row-add--added)") }).first();
	const rowId = await plusRow.getAttribute("data-poi-row");
	await plusRow.locator(".dw-poi-row-add").click();
	const kmName = await page.evaluate(() => window.leafletPlan.waypoints.at(-1)?.name || "");
	check(/^\d+(\.\d)?k \S/.test(kmName) && kmName.length <= 16, "waypoint names can lead with the distance", kmName);

	// The tick on an added row takes its waypoint off again, and the site's
	// Undo still works afterwards.
	const rowState = () => page.evaluate((id) => {
		const row = [...document.querySelectorAll(".dw-poi-row")].find((r) => r.dataset.poiRow === id);
		return {
			ticked: !!row?.querySelector(".dw-poi-row-add--added"),
			names: window.leafletPlan.waypoints.map((w) => w.name),
			status: document.querySelector(".dw-poi-status")?.textContent || "",
		};
	}, rowId);
	const ticked = await rowState();
	await page.locator(".dw-poi-row", { has: page.locator(".dw-poi-row-add--added") }).first().locator("[data-poi-remove]").click();
	const unticked = await rowState();
	check(ticked.ticked && !unticked.ticked && JSON.stringify(unticked.names) === JSON.stringify(ownNames) &&
		unticked.status === `Removed “${kmName}” — Undo brings it back.`,
	"the tick on an added row removes that waypoint and no other", unticked.status);
	check(await routeMarkers() === startMarkers, "removing a waypoint leaves the route unchanged");
	await page.click("#undo");
	const broughtBack = await page.waitForFunction((count) => window.leafletPlan.waypoints.length === count &&
		!!document.querySelector(".dw-poi-row .dw-poi-row-add--added"), before + 1, { timeout: 10_000 })
		.then(() => true).catch(() => false);
	check(broughtBack && (await rowState()).ticked, "planner Undo brings a removed waypoint back, ticked again");
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
	if (page) {
		mkdirSync(reportDir, { recursive: true });
		const failShot = resolve(reportDir, `route-pois-failure-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
		await page.screenshot({ path: failShot }).then(() => console.error(`  failure screenshot: ${failShot}`), () => {});
	}
} finally {
	await browser.close();
}
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
