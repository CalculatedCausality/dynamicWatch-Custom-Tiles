#!/usr/bin/env node
// Exercise the real dynamic.watch planner controls while Vexcel perspective
// mode is active. Vexcel is mocked so this test is deterministic and does not
// require a short-lived production token.
import { chromium } from "playwright";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const STATE = resolve(ROOT, ".auth", "storage.json");
if (!existsSync(STATE)) {
	console.error("run npm run e2e:auth first");
	process.exit(2);
}

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const TOKEN = `${b64({ alg: "HS256" })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
const WIDTH = 1200, HEIGHT = 900;
const WEST = 153.0, EAST = 153.01, NORTH = -26.6, SOUTH = -26.61;
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
	"base64",
);
const feature = {
	type: "Feature",
	geometry: {
		type: "Polygon",
		coordinates: [[
			[WEST, NORTH], [EAST, NORTH], [EAST, SOUTH], [WEST, SOUTH], [WEST, NORTH],
		]],
	},
	properties: {
		"product-type": "oblique-east",
		collection: "au-qld-editing-2026",
		"image-name": "mock-oblique-east-rgb",
		"source-layer": "urban",
		"raster-size-width": WIDTH,
		"raster-size-height": HEIGHT,
		"capture-date": "2026-01-01",
	},
};

const browser = await chromium.launch({
	headless: !process.env.HEADED,
	args: ["--disable-web-security", "--disable-features=IsolateOrigins,site-per-process"],
});
const context = await browser.newContext({ storageState: STATE, viewport: { width: 1400, height: 900 } });
let worldToPixel = 0, pixelToWorld = 0, pixelFallbacks = 0;
let delayNextWorldTransform = false;
await context.route(/https:\/\/api\.vexcelgroup\.com\/.*/, async (route) => {
	const request = route.request();
	const url = request.url();
	if (url.includes("/v2/oriented/transform-points")) {
		const body = request.postDataJSON();
		const values = [...String(body.wkt || "").matchAll(
			/(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g,
		)].map((match) => [Number(match[1]), Number(match[2])]);
		const points = body.operation === "world-2-pixel"
			? values.map(([lng, lat]) => ({
				x: (lng - WEST) / (EAST - WEST) * WIDTH,
				y: (NORTH - lat) / (NORTH - SOUTH) * HEIGHT,
			}))
			: values.map(([x, y]) => ({
				x: WEST + x / WIDTH * (EAST - WEST),
				y: NORTH - y / HEIGHT * (NORTH - SOUTH),
			}));
		if (body.operation === "world-2-pixel") worldToPixel++;
		else pixelToWorld++;
		// Interaction transforms are deliberately slower. The fifth one also
		// returns no point so Add Waypoint must use the safe footprint fallback.
		if (body.operation !== "world-2-pixel") await new Promise((done) => setTimeout(done, 80));
		if (body.operation === "world-2-pixel" && delayNextWorldTransform) {
			delayNextWorldTransform = false;
			await new Promise((done) => setTimeout(done, 250));
		}
		const useFallback = body.operation !== "world-2-pixel" && pixelToWorld === 5;
		if (useFallback) pixelFallbacks++;
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ points: useFallback ? [] : points }),
		});
		return;
	}
	if (url.includes("/v2/oriented/query")) {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ type: "FeatureCollection", features: [feature] }),
		});
		return;
	}
	if (url.includes("/v2/ortho/collections")) {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ features: [{ properties: { collection: feature.properties.collection } }] }),
		});
		return;
	}
	if (url.includes("/v2/oriented/tile") || url.includes("/v2/ortho/")) {
		await route.fulfill({ status: 200, contentType: "image/png", body: PNG });
		return;
	}
	await route.fulfill({ status: 404, body: "" });
});

await context.addInitScript({ content: readFileSync(resolve(__dirname, "lib", "bootstrap.js"), "utf8") });
await context.addInitScript({ content: `
	localStorage.setItem("GM:dw_vexcel_token", ${JSON.stringify(JSON.stringify(TOKEN))});
	localStorage.setItem("GM:dw_vexcel_session", ${JSON.stringify(JSON.stringify(JSON.stringify({ s: "mock-session", k: "sig" })))});
` });
await context.addInitScript({ content: readFileSync(resolve(ROOT, "dynamicwatch-custom-tiles.user.js"), "utf8") });

const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));

let loaded = false;
for (let attempt = 0; attempt < 5 && !loaded; attempt++) {
	pageErrors.length = 0;
	if (attempt) await page.waitForTimeout(1000);
	await page.goto("https://dynamic.watch/plan", {
		waitUntil: "domcontentloaded", timeout: 45_000,
	}).catch(() => {});
	loaded = await page.waitForFunction(
		() => !!window.leafletPlan?.map && !!window._dwLayerCtrl?._map,
		undefined, { timeout: 20_000 },
	).then(() => true).catch(() => false);
}
if (!loaded) throw new Error(`dynamic.watch planner did not initialize: ${pageErrors.join("; ")}`);
await page.waitForSelector(".leaflet-planner-controls", { timeout: 30_000 });
await page.waitForTimeout(800);
await page.evaluate(() => {
	document.querySelectorAll(".modal,.modal-backdrop").forEach((element) => element.remove());
	document.body.classList.remove("modal-open");
	document.body.style.overflow = "";
	window.leafletPlan.map.setView([-26.605, 153.005], 17);
});

// Straight-line mode avoids an external routing dependency while retaining
// dynamic.watch's real add/insert/drag code paths.
await page.locator("#travel-mode-btn").click();
await page.locator('#travel-mode-popup a.travel-mode-a[data-id="none"]').click();

await page.evaluate(() => {
	const map = window._dwLayerCtrl._map;
	const control = window._dwLayerCtrl;
	const vexcel = control._layers.find((entry) => entry.name === "Vexcel Aerial")?.layer;
	control._layers.filter((entry) => !entry.overlay).forEach((entry) => {
		if (entry.layer !== vexcel && map.hasLayer(entry.layer)) map.removeLayer(entry.layer);
	});
	if (!map.hasLayer(vexcel)) map.addLayer(vexcel);
});
await page.waitForSelector('.dw-vex-dir[data-dir="oblique-east"]');
await page.locator('.dw-vex-dir[data-dir="oblique-east"]').click();
await page.waitForSelector(".dw-vex-warp-tile-loaded", { timeout: 20_000 });

const mapBox = await page.locator("#leaflet").boundingBox();
if (!mapBox) throw new Error("planner map is not visible");
const first = { x: mapBox.x + mapBox.width * 0.38, y: mapBox.y + mapBox.height * 0.48 };
const second = { x: mapBox.x + mapBox.width * 0.64, y: mapBox.y + mapBox.height * 0.55 };

// Deliberately do not wait between these clicks. Their async pixel transforms
// must be serialized so both planner events arrive in input order.
await page.mouse.click(first.x, first.y);
await page.mouse.click(second.x, second.y);
await page.waitForFunction(() =>
	window.leafletPlan.currentLine?.length === 2 &&
	!!window.leafletPlan.currentLine[1]?.polyline,
);
await page.waitForFunction(() =>
	document.querySelectorAll(".dw-vex-route-handle").length === 2 &&
	!!document.querySelector(".dw-vex-route--exact .dw-vex-route-hit"),
);

const beforeInsert = await page.locator(".dw-vex-route path[stroke='#ef2929']").evaluateAll(
	(paths) => paths.map((path) => path.getAttribute("d")),
);
const hitPoint = await page.locator(".dw-vex-route-hit").first().evaluate((path) => {
	const local = path.getPointAtLength(path.getTotalLength() / 2);
	const screen = new DOMPoint(local.x, local.y).matrixTransform(path.getScreenCTM());
	return { x: screen.x, y: screen.y };
});
await page.mouse.click(hitPoint.x, hitPoint.y);
await page.waitForFunction(() => window.leafletPlan.currentLine?.length === 3);
await page.waitForFunction(() =>
	document.querySelectorAll(".dw-vex-route-handle--via").length === 1 &&
	document.querySelectorAll(".dw-vex-route-hit").length === 2,
);
await page.waitForFunction((before) => {
	const after = [...document.querySelectorAll(".dw-vex-route path[stroke='#ef2929']")]
		.map((path) => path.getAttribute("d"));
	return JSON.stringify(after) !== JSON.stringify(before) &&
		!!document.querySelector(".dw-vex-route--exact");
}, beforeInsert);
const via = page.locator(".dw-vex-route-handle--via");
const insertError = await via.evaluate((handle, target) => {
	const rect = handle.getBoundingClientRect();
	return Math.hypot(rect.left + rect.width / 2 - target.x,
		rect.top + rect.height / 2 - target.y);
}, hitPoint);

const viaBox = await via.boundingBox();
if (!viaBox) throw new Error("projected route handle is not visible");
const beforeDrag = await page.evaluate(() => {
	const segment = window.leafletPlan.currentLine[1];
	const point = segment.marker_end.getLatLng();
	return { lat: point.lat, lng: point.lng };
});
const beforeDragPath = await page.locator(".dw-vex-route path[stroke='#ef2929']").allTextContents()
	.then(async () => page.locator(".dw-vex-route path[stroke='#ef2929']").evaluateAll(
		(paths) => paths.map((path) => path.getAttribute("d")),
	));
const dragTarget = {
	x: viaBox.x + viaBox.width / 2 + 80,
	y: viaBox.y + viaBox.height / 2 - 55,
};
// Start a delayed exact reprojection, then keep the pointer down long enough
// for it to finish. The callback must not replace the captured drag handle.
delayNextWorldTransform = true;
await page.evaluate(() => {
	const polyline = window.leafletPlan.currentLine[1].polyline;
	polyline.setLatLngs(polyline.getLatLngs());
});
await page.waitForTimeout(150);
await page.mouse.move(viaBox.x + viaBox.width / 2, viaBox.y + viaBox.height / 2);
await page.mouse.down();
await page.mouse.move(dragTarget.x, dragTarget.y, { steps: 12 });
await page.waitForTimeout(300);
const handleStayedConnected = await via.evaluate((handle) => handle.isConnected);
await page.mouse.up();
await page.waitForFunction(({ lat, lng }) => {
	const point = window.leafletPlan.currentLine?.[1]?.marker_end?.getLatLng();
	return point && (Math.abs(point.lat - lat) > 1e-7 || Math.abs(point.lng - lng) > 1e-7);
}, beforeDrag);
await page.waitForFunction((before) => {
	const after = [...document.querySelectorAll(".dw-vex-route path[stroke='#ef2929']")]
		.map((path) => path.getAttribute("d"));
	return JSON.stringify(after) !== JSON.stringify(before) &&
		document.querySelector(".dw-vex-route--exact");
}, beforeDragPath);
await page.waitForFunction(() => !window.leafletPlan.ignoringMapClicks);

// Also use the planner's actual Add Waypoint mode and save its popup. The
// standalone blue point should be projected and draggable, not disappear.
await page.locator("#travel-mode-btn").click();
await page.locator('#travel-mode-popup a.travel-mode-a[data-id="waypoint"]').click();
const waypointPoint = { x: mapBox.x + mapBox.width * 0.75, y: mapBox.y + mapBox.height * 0.72 };
await page.mouse.click(waypointPoint.x, waypointPoint.y);
const waypointAdded = await page.waitForFunction(
	() => window.leafletPlan.waypoints?.length === 1,
	undefined, { timeout: 10_000 },
).then(() => true).catch(() => false);
if (!waypointAdded) {
	const state = await page.evaluate(() => ({
		travelMode: window.leafletPlan?.travelMode,
		waypoints: window.leafletPlan?.waypoints?.length,
		lineLength: window.leafletPlan?.currentLine?.length,
		popup: document.querySelector(".leaflet-popup-content")?.textContent,
		modal: document.querySelector(".modal")?.textContent,
	}));
	throw new Error(`Add Waypoint did not create a waypoint: ${JSON.stringify(state)}`);
}
await page.locator('.waypoint-popup input[id^="waypoint-name-"]').fill("Vexcel point");
await page.locator('.waypoint-popup button[id^="waypoint-save-button-"]').click();
await page.waitForSelector(".dw-vex-route-handle--waypoint", { timeout: 10_000 });
const waypointHandle = page.locator(".dw-vex-route-handle--waypoint");
const waypointBox = await waypointHandle.boundingBox();
if (!waypointBox) throw new Error("projected standalone waypoint is not visible");
const waypointBeforeDrag = await page.evaluate(() => {
	const point = window.leafletPlan.waypoints[0].marker.getLatLng();
	return { lat: point.lat, lng: point.lng };
});
const waypointDragTarget = {
	x: waypointBox.x + waypointBox.width / 2 - 45,
	y: waypointBox.y + waypointBox.height / 2 + 35,
};
await page.mouse.move(waypointBox.x + waypointBox.width / 2,
	waypointBox.y + waypointBox.height / 2);
await page.mouse.down();
await page.mouse.move(waypointDragTarget.x, waypointDragTarget.y, { steps: 10 });
await page.mouse.up();
await page.waitForFunction(({ lat, lng }) => {
	const point = window.leafletPlan.waypoints?.[0]?.marker?.getLatLng();
	return point && (Math.abs(point.lat - lat) > 1e-7 || Math.abs(point.lng - lng) > 1e-7);
}, waypointBeforeDrag);
await page.waitForFunction(() => !window.leafletPlan.ignoringMapClicks);
const waypointDragError = await waypointHandle.evaluate((handle, target) => {
	const rect = handle.getBoundingClientRect();
	return Math.hypot(rect.left + rect.width / 2 - target.x,
		rect.top + rect.height / 2 - target.y);
}, waypointDragTarget);

// Perspective click conversion must not steal events from normal Leaflet
// overlays. A native interactive circle should receive its own click without
// creating another planner waypoint.
await page.evaluate(() => {
	const map = window.leafletPlan.map;
	const latlng = map.containerPointToLatLng([map.getSize().x * 0.2, map.getSize().y * 0.2]);
	window._dwVexcelInteractiveProbe = L.circleMarker(latlng, {
		radius: 12, className: "dw-vexcel-interactive-probe", bubblingMouseEvents: false,
	}).on("click", () => { window._dwVexcelInteractiveHits = (window._dwVexcelInteractiveHits || 0) + 1; })
		.addTo(map);
});
const probeBox = await page.locator(".dw-vexcel-interactive-probe").boundingBox();
if (!probeBox) throw new Error("interactive Leaflet probe is not visible");
await page.mouse.click(probeBox.x + probeBox.width / 2, probeBox.y + probeBox.height / 2);
await page.waitForFunction(() => window._dwVexcelInteractiveHits === 1);
const overlayHits = await page.evaluate(() => window._dwVexcelInteractiveHits || 0);

const result = await page.evaluate(({ first, second, dragTarget }) => {
	const centers = [...document.querySelectorAll(".dw-vex-route-handle")].map((handle) => {
		const rect = handle.getBoundingClientRect();
		return {
			className: handle.getAttribute("class"),
			x: rect.left + rect.width / 2,
			y: rect.top + rect.height / 2,
		};
	});
	const distance = (point, target) => Math.hypot(point.x - target.x, point.y - target.y);
	const start = centers.find((point) => point.className.includes("--start"));
	const end = centers.find((point) => point.className.includes("--end"));
	const via = centers.find((point) => point.className.includes("--via"));
	return {
		lineLength: window.leafletPlan.lines?.[0]?.length,
		waypoints: window.leafletPlan.waypoints?.length,
		exact: !!document.querySelector(".dw-vex-route--exact"),
		redPaths: document.querySelectorAll(".dw-vex-route path[stroke='#ef2929']").length,
		handles: centers.length,
		startError: start ? distance(start, first) : Infinity,
		endError: end ? distance(end, second) : Infinity,
		viaDragError: via ? distance(via, dragTarget) : Infinity,
		nativeMarkersHidden: [...document.querySelectorAll(".leaflet-marker-pane .circle")]
			.every((marker) => getComputedStyle(marker).opacity === "0"),
	};
}, { first, second, dragTarget });

// Delete the projected route point through dynamic.watch's real marker popup.
// The popup must be anchored at the projected handle rather than the hidden
// flat-map marker.
const deleteHandleBox = await via.boundingBox();
if (!deleteHandleBox) throw new Error("projected route point disappeared before delete");
const deletePoint = {
	x: deleteHandleBox.x + deleteHandleBox.width / 2,
	y: deleteHandleBox.y + deleteHandleBox.height / 2,
};
await page.mouse.click(deletePoint.x, deletePoint.y, { button: "right" });
await page.waitForSelector(".line-marker-popup");
const popupAnchorError = await page.locator(".line-marker-popup").evaluate((content, point) => {
	const popup = content.closest(".leaflet-popup");
	const rect = popup.getBoundingClientRect();
	const nearestX = Math.max(rect.left, Math.min(point.x, rect.right));
	const nearestY = Math.max(rect.top, Math.min(point.y, rect.bottom));
	return Math.hypot(point.x - nearestX, point.y - nearestY);
}, deletePoint);
await page.locator('.line-marker-popup button[id^="line-marker-delete-button-"]').click();
await page.waitForFunction(() => window.leafletPlan.lines?.[0]?.length === 2);
await page.waitForFunction(() =>
	document.querySelectorAll(".dw-vex-route-handle--via").length === 0 &&
	document.querySelectorAll(".dw-vex-route path[stroke='#ef2929']").length === 1 &&
	!!document.querySelector(".dw-vex-route--exact"),
);
result.worldToPixel = worldToPixel;
result.pixelToWorld = pixelToWorld;
result.pixelFallbacks = pixelFallbacks;
result.insertError = insertError;
result.waypointDragError = waypointDragError;
result.handleStayedConnected = handleStayedConnected;
result.overlayHits = overlayHits;
result.popupAnchorError = popupAnchorError;
result.deleteLineLength = await page.evaluate(() => window.leafletPlan.lines?.[0]?.length);
result.pageErrors = pageErrors;
console.log(JSON.stringify(result, null, 2));

const failures = [];
if (result.lineLength !== 3) failures.push(`expected 3 route points, got ${result.lineLength}`);
if (result.waypoints !== 1) failures.push(`expected 1 standalone waypoint, got ${result.waypoints}`);
if (!result.exact || result.redPaths !== 2) failures.push("final projected route is not exact/two-segment");
if (result.handles !== 4) failures.push(`expected 4 projected handles, got ${result.handles}`);
if (result.startError > 3 || result.endError > 3) failures.push("added route handles do not match click positions");
if (result.insertError > 3) failures.push(`inserted handle missed route click by ${result.insertError.toFixed(1)}px`);
if (result.viaDragError > 4) failures.push(`dragged handle missed cursor by ${result.viaDragError.toFixed(1)}px`);
if (result.waypointDragError > 4) failures.push(`waypoint drag missed cursor by ${result.waypointDragError.toFixed(1)}px`);
if (!handleStayedConnected) failures.push("exact reprojection replaced an active drag handle");
if (!result.nativeMarkersHidden) failures.push("native flat-map markers leaked into perspective mode");
if (worldToPixel < 4 || pixelToWorld < 6) failures.push("expected both Vexcel transform directions to be exercised");
if (pixelFallbacks !== 1) failures.push("failed pixel transform did not exercise exactly one fallback");
if (overlayHits !== 1 || result.waypoints !== 1) failures.push("perspective click capture stole an overlay event");
if (popupAnchorError > 20) failures.push(`route-point popup missed projected handle by ${popupAnchorError.toFixed(1)}px`);
if (result.deleteLineLength !== 2) failures.push("projected route-point delete did not update the course");
if (pageErrors.length) failures.push(`page errors: ${pageErrors.join("; ")}`);

await browser.close();
if (failures.length) {
	console.error(failures.join("\n"));
	process.exit(1);
}
console.log("PASS: add, insert, drag, delete, and standalone waypoint editing stay aligned in Vexcel perspective mode");
