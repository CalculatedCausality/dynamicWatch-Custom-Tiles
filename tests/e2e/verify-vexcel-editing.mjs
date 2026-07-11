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
const COLLECTION = "au-qld-editing-2026";
const DIRECTIONS = ["oblique-north", "oblique-east", "oblique-south", "oblique-west"];
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
	"base64",
);
const features = DIRECTIONS.map((direction) => ({
	type: "Feature",
	geometry: {
		type: "Polygon",
		coordinates: [[
			[WEST, NORTH], [EAST, NORTH], [EAST, SOUTH], [WEST, SOUTH], [WEST, NORTH],
		]],
	},
	properties: {
		"product-type": direction,
		collection: COLLECTION,
		"image-name": `mock-${direction}-rgb`,
		"source-layer": "urban",
		"raster-size-width": WIDTH,
		"raster-size-height": HEIGHT,
		"capture-date": "2026-01-01",
	},
}));

const browser = await chromium.launch({
	headless: !process.env.HEADED,
	args: ["--disable-web-security", "--disable-features=IsolateOrigins,site-per-process"],
});
const context = await browser.newContext({ storageState: STATE, viewport: { width: 1400, height: 900 } });
let worldToPixel = 0, pixelToWorld = 0, pixelFallbacks = 0;
let delayNextWorldTransform = false;
let failNextPixelTransform = false;
let overscanWorldTransform = false;
await context.route(/https:\/\/api\.vexcelgroup\.com\/.*/, async (route) => {
	const request = route.request();
	const url = request.url();
	if (url.includes("/v2/oriented/transform-points")) {
		const body = request.postDataJSON();
		const values = [...String(body.wkt || "").matchAll(
			/(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g,
		)].map((match) => [Number(match[1]), Number(match[2])]);
		const direction = DIRECTIONS.find((candidate) =>
			String(body["image-name"] || "").includes(candidate)) || "oblique-east";
		const toPixel = ([lng, lat]) => {
			const u = (lng - WEST) / (EAST - WEST);
			const v = (NORTH - lat) / (NORTH - SOUTH);
			if (direction === "oblique-west") return { x: (1 - u) * WIDTH, y: v * HEIGHT };
			if (direction === "oblique-north") return { x: v * WIDTH, y: (1 - u) * HEIGHT };
			if (direction === "oblique-south") return { x: (1 - v) * WIDTH, y: u * HEIGHT };
			return overscanWorldTransform
				? { x: u * (WIDTH + 4) - 2, y: v * HEIGHT }
				: { x: u * WIDTH, y: v * HEIGHT };
		};
		const toWorld = ([x, y]) => {
			let u, v;
			if (direction === "oblique-west") { u = 1 - x / WIDTH; v = y / HEIGHT; }
			else if (direction === "oblique-north") { u = 1 - y / HEIGHT; v = x / WIDTH; }
			else if (direction === "oblique-south") { u = y / HEIGHT; v = 1 - x / WIDTH; }
			else { u = x / WIDTH; v = y / HEIGHT; }
			return { x: WEST + u * (EAST - WEST), y: NORTH - v * (NORTH - SOUTH) };
		};
		const points = body.operation === "world-2-pixel" ? values.map(toPixel) : values.map(toWorld);
		if (body.operation === "world-2-pixel") worldToPixel++;
		else pixelToWorld++;
		// Interaction transforms are deliberately slower. The fifth one also
		// returns no point so Add Waypoint must use the safe footprint fallback.
		if (body.operation !== "world-2-pixel") await new Promise((done) => setTimeout(done, 80));
		if (body.operation === "world-2-pixel" && delayNextWorldTransform) {
			delayNextWorldTransform = false;
			await new Promise((done) => setTimeout(done, 250));
		}
		const useFallback = body.operation !== "world-2-pixel" && failNextPixelTransform;
		if (useFallback) failNextPixelTransform = false;
		if (useFallback) pixelFallbacks++;
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ points: useFallback ? [] : points }),
		});
		return;
	}
	if (url.includes("/v2/oriented/query")) {
		const body = request.postDataJSON();
		const requested = body["product-type"];
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				type: "FeatureCollection",
				features: requested ? features.filter((entry) =>
					entry.properties["product-type"] === requested) : features,
			}),
		});
		return;
	}
	if (url.includes("/v2/ortho/collections")) {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ features: [{ properties: { collection: COLLECTION } }] }),
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

const beforeInsert = await page.locator(".dw-vex-route-visual").evaluateAll(
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
	const after = [...document.querySelectorAll(".dw-vex-route-visual")]
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
const beforeDragPath = await page.locator(".dw-vex-route-visual").allTextContents()
	.then(async () => page.locator(".dw-vex-route-visual").evaluateAll(
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
	const after = [...document.querySelectorAll(".dw-vex-route-visual")]
		.map((path) => path.getAttribute("d"));
	return JSON.stringify(after) !== JSON.stringify(before) &&
		document.querySelector(".dw-vex-route--exact");
}, beforeDragPath);
await page.waitForFunction(() => !window.leafletPlan.ignoringMapClicks);

const inspectProjectedRoute = () => page.evaluate(() => {
	const svg = document.querySelector(".dw-vex-route");
	const children = [...svg.children];
	const visuals = children.map((node, index) => node.classList.contains("dw-vex-route-visual") ? index : -1)
		.filter((index) => index >= 0);
	const hits = children.map((node, index) => node.classList.contains("dw-vex-route-hit") ? index : -1)
		.filter((index) => index >= 0);
	const endpoints = visuals.flatMap((index) => {
		const path = children[index];
		return [path.getPointAtLength(0), path.getPointAtLength(path.getTotalLength())];
	});
	const handles = [...svg.querySelectorAll(
		".dw-vex-route-handle--start,.dw-vex-route-handle--via,.dw-vex-route-handle--end",
	)];
	const maxEndpointError = handles.reduce((maximum, handle) => {
		const x = Number(handle.getAttribute("cx")), y = Number(handle.getAttribute("cy"));
		const nearest = Math.min(...endpoints.map((point) => Math.hypot(point.x - x, point.y - y)));
		return Math.max(maximum, nearest);
	}, 0);
	let adjacencyError = Infinity;
	if (visuals.length === handles.length - 1) {
		adjacencyError = visuals.reduce((maximum, index, segmentIndex) => {
			const path = children[index];
			const start = path.getPointAtLength(0);
			const end = path.getPointAtLength(path.getTotalLength());
			const a = handles[segmentIndex], b = handles[segmentIndex + 1];
			const ap = { x: Number(a.getAttribute("cx")), y: Number(a.getAttribute("cy")) };
			const bp = { x: Number(b.getAttribute("cx")), y: Number(b.getAttribute("cy")) };
			const direct = Math.max(Math.hypot(start.x - ap.x, start.y - ap.y),
				Math.hypot(end.x - bp.x, end.y - bp.y));
			const reverse = Math.max(Math.hypot(start.x - bp.x, start.y - bp.y),
				Math.hypot(end.x - ap.x, end.y - ap.y));
			return Math.max(maximum, Math.min(direct, reverse));
		}, 0);
	}
	const sourcePolylines = window.leafletPlan.lines.flatMap((line) =>
		line.map((segment) => segment.polyline).filter(Boolean));
	const styleMatches = visuals.every((index) => {
		const path = children[index];
		const source = sourcePolylines[Number(path.dataset.sourceIndex)];
		if (!source) return false;
		const options = source.options || {};
		return path.getAttribute("stroke").toLowerCase() === String(options.color || "#9400D3").toLowerCase() &&
			Math.abs(Number(path.getAttribute("stroke-width")) - Number(options.weight || 8)) < 1e-9 &&
			Math.abs(Number(path.getAttribute("stroke-opacity")) - Number(options.opacity ?? 0.4)) < 1e-9 &&
			path.getAttribute("stroke-linecap") === String(options.lineCap || "round") &&
			path.getAttribute("stroke-linejoin") === String(options.lineJoin || "round");
	});
	return {
		visuals: visuals.length,
		hits: hits.length,
		paintOrder: visuals.length > 0 && hits.length > 0 &&
			Math.max(...visuals) < Math.min(...hits),
		finite: [...svg.querySelectorAll("path")].every((path) =>
			!/NaN|Infinity|undefined/.test(path.getAttribute("d") || "")),
		maxEndpointError,
		adjacencyError,
		styleMatches,
	};
});

// Every cardinal camera uses a different rotation/reflection. Insert a real
// route point by clicking the projected line at each angle, verify its handle
// lands on that click, then undo and continue to the next camera.
const angleResults = [];
for (const direction of ["oblique-north", "oblique-south", "oblique-west", "oblique-east"]) {
	const directionButton = page.locator(`.dw-vex-dir[data-dir="${direction}"]`);
	await directionButton.click();
	const angleReady = await page.waitForFunction((activeDirection) => {
		const active = document.querySelector(".dw-vex-dir--on[data-dir]");
		const frameNames = [...document.querySelectorAll(".dw-vex-warp-tile-loaded")]
			.map((tile) => tile.dataset.imageName || "");
		return active?.dataset.dir === activeDirection &&
			frameNames.some((name) => name.includes(activeDirection)) &&
			!!document.querySelector(".dw-vex-route--exact");
	}, direction, { timeout: 20_000 }).then(() => true).catch(() => false);
	if (!angleReady) {
		const state = await page.evaluate(() => ({
			active: document.querySelector(".dw-vex-dir--on[data-dir]")?.dataset.dir,
			buttons: [...document.querySelectorAll(".dw-vex-dir")].map((button) => ({
				text: button.textContent, dir: button.dataset.dir, disabled: button.disabled,
			})),
			images: [...document.querySelectorAll(".dw-vex-warp-tile-loaded")]
				.map((tile) => tile.dataset.imageName),
			exact: !!document.querySelector(".dw-vex-route--exact"),
			message: document.querySelector(".dw-vex-basemsg")?.textContent,
		}));
		throw new Error(`${direction} did not become ready: ${JSON.stringify({ state, pageErrors })}`);
	}
	const beforeCount = await page.evaluate(() => window.leafletPlan.lines[0].length);
	const angleHit = await page.locator(".dw-vex-route-hit").first().evaluate((path) => {
		const local = path.getPointAtLength(path.getTotalLength() * 0.45);
		const screen = new DOMPoint(local.x, local.y).matrixTransform(path.getScreenCTM());
		return { x: screen.x, y: screen.y };
	});
	await page.mouse.click(angleHit.x, angleHit.y);
	await page.waitForFunction((count) => window.leafletPlan.lines[0].length === count + 1,
		beforeCount);
	await page.waitForFunction((segments) =>
		document.querySelectorAll(".dw-vex-route-hit").length === segments + 1 &&
		!!document.querySelector(".dw-vex-route--exact"), beforeCount - 1);
	const insertionError = await page.locator(".dw-vex-route-handle--via").evaluateAll(
		(handles, target) => Math.min(...handles.map((handle) => {
			const rect = handle.getBoundingClientRect();
			return Math.hypot(rect.left + rect.width / 2 - target.x,
				rect.top + rect.height / 2 - target.y);
		})), angleHit,
	);
	const insertedQuality = await inspectProjectedRoute();
	await page.locator(".leaflet-planner-controls #undo").click();
	await page.waitForFunction((count) => window.leafletPlan.lines[0].length === count,
		beforeCount);
	await page.waitForFunction((segments) =>
		document.querySelectorAll(".dw-vex-route-hit").length === segments &&
		!!document.querySelector(".dw-vex-route--exact"), beforeCount - 1);
	const restoredQuality = await inspectProjectedRoute();
	angleResults.push({ direction, insertionError, insertedQuality, restoredQuality });
}
await page.locator('.dw-vex-dir[data-dir="oblique-east"]').click();
await page.waitForTimeout(250);
const repeatedCardinalStayed = await page.evaluate(() =>
	!!document.querySelector(".dw-vex-warp") &&
	!!document.querySelector('.dw-vex-dir--on[data-dir="oblique-east"]'));

// Vexcel can return exact pixels just outside the nominal raster even when
// the geographic segment crosses the frame. Exercise the renderer itself,
// not only the clipping helper, and require one edge-to-edge visible path.
overscanWorldTransform = true;
await page.evaluate(({ west, east, lat }) => {
	const map = window.leafletPlan.map;
	window._dwVexcelClipProbe = L.polyline([[lat, west - 0.001], [lat, east + 0.001]], {
		className: "route-polyline", color: "#ef2929",
	}).addTo(map);
	window.leafletPlan.lines.push([{ polyline: window._dwVexcelClipProbe }]);
}, { west: WEST, east: EAST, lat: (NORTH + SOUTH) / 2 });
await page.waitForFunction(() =>
	document.querySelectorAll(".dw-vex-route-visual").length === 3 &&
	!!document.querySelector(".dw-vex-route--exact"),
);
const clippedCrossingVisible = await page.evaluate((width) =>
	[...document.querySelectorAll(".dw-vex-route-visual")].some((path) => {
		const start = path.getPointAtLength(0);
		const end = path.getPointAtLength(path.getTotalLength());
		return Math.min(start.x, end.x) < 0.01 && Math.max(start.x, end.x) > width - 0.01;
	}), WIDTH);
overscanWorldTransform = false;
await page.evaluate(() => {
	window.leafletPlan.lines.pop();
	window.leafletPlan.map.removeLayer(window._dwVexcelClipProbe);
});
await page.waitForFunction(() =>
	document.querySelectorAll(".dw-vex-route-visual").length === 2 &&
	!!document.querySelector(".dw-vex-route--exact"),
);

const compassState = await page.evaluate(() => ({
	directions: [...document.querySelectorAll(".dw-vex-dir[data-dir]")].map((button) => button.dataset.dir),
	centerText: document.querySelector(".dw-vex-rose .dw-vex-flat")?.textContent,
	flatButtons: document.querySelectorAll(".dw-vex-flat").length,
}));
await page.locator(".dw-vex-rose .dw-vex-flat").click();
await page.waitForFunction(() =>
	!document.querySelector(".dw-vex-warp") &&
	!document.querySelector("#leaflet.dw-vex-perspective-active") &&
	document.querySelector(".dw-vex-flat")?.classList.contains("dw-vex-dir--on"),
);
const flatState = await page.evaluate(() => ({
	warp: !!document.querySelector(".dw-vex-warp"),
	perspective: document.querySelector("#leaflet")?.classList.contains("dw-vex-perspective-active"),
	centerActive: document.querySelector(".dw-vex-flat")?.classList.contains("dw-vex-dir--on"),
}));
await page.locator('.dw-vex-dir[data-dir="oblique-east"]').click();
await page.waitForFunction(() =>
	document.querySelector('.dw-vex-dir--on[data-dir="oblique-east"]') &&
	document.querySelector(".dw-vex-route--exact"),
);

// Also use the planner's actual Add Waypoint mode and save its popup. The
// standalone blue point should be projected and draggable, not disappear.
await page.locator("#travel-mode-btn").click();
await page.locator('#travel-mode-popup a.travel-mode-a[data-id="waypoint"]').click();
const waypointPoint = { x: mapBox.x + mapBox.width * 0.75, y: mapBox.y + mapBox.height * 0.72 };
failNextPixelTransform = true;
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
		visualPaths: document.querySelectorAll(".dw-vex-route-visual").length,
		routeAppearance: (() => {
			const projected = document.querySelector(".dw-vex-route-visual");
			const native = window.leafletPlan.lines.flatMap((line) =>
				line.map((segment) => segment.polyline).filter(Boolean))[0];
			return projected && native ? {
				projected: {
					color: projected.getAttribute("stroke"),
					weight: Number(projected.getAttribute("stroke-width")),
					opacity: Number(projected.getAttribute("stroke-opacity")),
				},
				native: {
					color: native.options.color,
					weight: native.options.weight,
					opacity: native.options.opacity,
				},
			} : null;
		})(),
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
	document.querySelectorAll(".dw-vex-route-visual").length === 1 &&
	!!document.querySelector(".dw-vex-route--exact"),
);
result.worldToPixel = worldToPixel;
result.pixelToWorld = pixelToWorld;
result.pixelFallbacks = pixelFallbacks;
result.insertError = insertError;
result.waypointDragError = waypointDragError;
result.handleStayedConnected = handleStayedConnected;
result.overlayHits = overlayHits;
result.angleResults = angleResults;
result.compassState = compassState;
result.flatState = flatState;
result.clippedCrossingVisible = clippedCrossingVisible;
result.repeatedCardinalStayed = repeatedCardinalStayed;
result.popupAnchorError = popupAnchorError;
result.deleteLineLength = await page.evaluate(() => window.leafletPlan.lines?.[0]?.length);
result.pageErrors = pageErrors;
console.log(JSON.stringify(result, null, 2));

const failures = [];
if (result.lineLength !== 3) failures.push(`expected 3 route points, got ${result.lineLength}`);
if (result.waypoints !== 1) failures.push(`expected 1 standalone waypoint, got ${result.waypoints}`);
if (!result.exact || result.visualPaths !== 2) failures.push("final projected route is not exact/two-segment");
if (result.handles !== 4) failures.push(`expected 4 projected handles, got ${result.handles}`);
if (result.startError > 3 || result.endError > 3) failures.push("added route handles do not match click positions");
if (result.insertError > 3) failures.push(`inserted handle missed route click by ${result.insertError.toFixed(1)}px`);
if (result.viaDragError > 4) failures.push(`dragged handle missed cursor by ${result.viaDragError.toFixed(1)}px`);
if (result.waypointDragError > 4) failures.push(`waypoint drag missed cursor by ${result.waypointDragError.toFixed(1)}px`);
if (!handleStayedConnected) failures.push("exact reprojection replaced an active drag handle");
if (!result.nativeMarkersHidden) failures.push("native flat-map markers leaked into perspective mode");
if (worldToPixel < 12 || pixelToWorld < 10) failures.push("expected both Vexcel transform directions across all angles");
if (pixelFallbacks !== 1) failures.push("failed pixel transform did not exercise exactly one fallback");
if (overlayHits !== 1 || result.waypoints !== 1) failures.push("perspective click capture stole an overlay event");
if (popupAnchorError > 20) failures.push(`route-point popup missed projected handle by ${popupAnchorError.toFixed(1)}px`);
if (result.deleteLineLength !== 2) failures.push("projected route-point delete did not update the course");
for (const angle of angleResults) {
	if (angle.insertionError > 3) failures.push(`${angle.direction} insertion missed by ${angle.insertionError.toFixed(1)}px`);
	for (const [state, quality] of [["inserted", angle.insertedQuality], ["restored", angle.restoredQuality]]) {
		if (!quality.paintOrder || !quality.finite || !quality.styleMatches || quality.maxEndpointError > 0.5 ||
			quality.adjacencyError > 0.5) {
			failures.push(`${angle.direction} ${state} route rendered poorly: ${JSON.stringify(quality)}`);
		}
	}
}
if (!clippedCrossingVisible) failures.push("exact out-of-frame route pixels were dropped instead of clipped");
if (!repeatedCardinalStayed) failures.push("selected cardinal still duplicates the center 2D action");
if (compassState.flatButtons !== 1 || compassState.centerText?.trim() !== "2D" ||
	compassState.directions.length !== 4 || compassState.directions.some((direction) => direction === "nadir")) {
	failures.push(`compass still has duplicate flat/nadir actions: ${JSON.stringify(compassState)}`);
}
if (flatState.warp || flatState.perspective || !flatState.centerActive) {
	failures.push(`center 2D action did not restore flat map: ${JSON.stringify(flatState)}`);
}
if (pageErrors.length) failures.push(`page errors: ${pageErrors.join("; ")}`);

await browser.close();
if (failures.length) {
	console.error(failures.join("\n"));
	process.exit(1);
}
console.log("PASS: route editing stays continuous and aligned across N/E/S/W Vexcel perspectives");
