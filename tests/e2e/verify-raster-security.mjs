#!/usr/bin/env node
// Exercise a public raster base in 2D and 3D with Chromium's normal CORS
// and site-isolation rules. The main 3D harness disables browser security.
import { chromium } from "playwright";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const auth = resolve(root, ".auth", "storage.json");
const bootstrap = resolve(root, "tests", "e2e", "lib", "bootstrap.js");
const userscript = resolve(root, "dynamicwatch-custom-tiles.user.js");
const url = "https://dynamic.watch" + (process.env.PLAN || "/plan");
const tilePath = "/Basemaps/QldMap_Topo/MapServer/tile/";
const tileHost = "spatial-gis.information.qld.gov.au";

if (!existsSync(auth)) {
	console.error(`No auth state at ${auth} — run \`npm run e2e:auth\` first.`);
	process.exit(2);
}

const browser = await chromium.launch({ headless: !process.env.HEADED });
try {
	const context = await browser.newContext({
		storageState: auth,
		viewport: { width: 1400, height: 900 },
	});
	await context.addInitScript({ content: readFileSync(bootstrap, "utf8") });
	await context.addInitScript({ content: readFileSync(userscript, "utf8") });
	const page = await context.newPage();
	const tileResponses = [];
	const tileFailures = [];
	const corsErrors = [];
	let phase = "2D";
	page.on("response", (response) => {
		if (response.url().includes(tilePath)) {
			tileResponses.push({ phase, status: response.status(), url: response.url() });
		}
	});
	page.on("requestfailed", (request) => {
		if (request.url().includes(tilePath)) {
			tileFailures.push({ phase, error: request.failure()?.errorText, url: request.url() });
		}
	});
	page.on("console", (message) => {
		if (message.type() === "error" && /CORS|cross.origin/i.test(message.text()) &&
			message.text().includes(tileHost)) corsErrors.push({ phase, text: message.text() });
	});

	console.log(`→ ${url} (normal Chromium security)`);
	const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
	if (response?.status() >= 400) throw new Error(`HTTP ${response.status()} loading ${url}`);
	if (page.url().includes("/users/sign_in")) {
		throw new Error("Redirected to sign_in — run `npm run e2e:auth` to refresh auth.");
	}
	await page.waitForSelector(".leaflet-planner-controls", { timeout: 30_000 });
	await page.waitForFunction(() => !!window._dwLayerCtrl?._map, { timeout: 15_000 });
	const selected = await page.evaluate(() => {
		const ctrl = window._dwLayerCtrl, map = ctrl._map;
		const entry = ctrl._layers.find((l) => l.name === "QLD Topo" && !l.overlay);
		if (!entry) return false;
		map.setView([-27.47, 153.03], 13); // Brisbane: inside the public QLD tile cache.
		for (const base of ctrl._layers.filter((l) => !l.overlay)) {
			if (base !== entry && map.hasLayer(base.layer)) map.removeLayer(base.layer);
		}
		if (!map.hasLayer(entry.layer)) map.addLayer(entry.layer);
		return map.hasLayer(entry.layer);
	});
	if (!selected) throw new Error("QLD Topo base missing or could not be activated in 2D");

	// Check images belonging to the selected layer, not leftover tiles in
	// Leaflet's shared tile pane. crossOrigin:true also makes this a CORS check.
	await page.waitForFunction((path) => {
		const entry = window._dwLayerCtrl?._layers.find((l) => l.name === "QLD Topo" && !l.overlay);
		return [...(entry?.layer?._container?.querySelectorAll("img.leaflet-tile") || [])]
			.some((img) => img.src.includes(path) && img.complete && img.naturalWidth > 0);
	}, tilePath, { timeout: 20_000 });
	const decoded2d = await page.evaluate((path) => {
		const layer = window._dwLayerCtrl._layers.find((l) => l.name === "QLD Topo" && !l.overlay).layer;
		return [...layer._container.querySelectorAll("img.leaflet-tile")]
			.filter((img) => img.src.includes(path) && img.complete && img.naturalWidth > 0).length;
	}, tilePath);
	const bad2d = tileResponses.filter((r) => r.phase === "2D" && r.status !== 200);
	const failures2d = tileFailures.filter((r) => r.phase === "2D");
	const errors2d = corsErrors.filter((r) => r.phase === "2D");
	if (bad2d.length || failures2d.length || errors2d.length) {
		throw new Error(`2D QLD Topo tile failures: ${JSON.stringify({
			responses: bad2d.slice(0, 3), failures: failures2d.slice(0, 3),
			corsErrors: errors2d.slice(0, 3),
		})}`);
	}
	console.log(`✓ 2D QLD Topo: ${decoded2d} decoded tile(s)`);

	await page.waitForSelector(".dw-3d-btn", { timeout: 10_000 });
	// The planner may show a help modal above the button. Click the same
	// control through the DOM as the existing 3D assertions do.
	phase = "3D";
	await page.evaluate(() => document.querySelector(".dw-3d-btn").click());
	await page.waitForFunction((path) => {
		const mb = window._dwMb;
		if (!mb?.isStyleLoaded?.()) return false;
		const src = mb.getStyle().sources?.["active-base"];
		return mb.getLayer("active-base")?.type === "raster" &&
			src?.type === "raster" && src.tiles?.some((tile) => tile.includes(path)) &&
			mb.isSourceLoaded("active-base");
	}, tilePath, { timeout: 35_000 });
	// A Mapbox source can exist even when every fetch is CORS-blocked. Require
	// real successful 3D requests as well as the loaded raster source.
	await page.waitForTimeout(1000);
	const loaded3d = tileResponses.filter((r) => r.phase === "3D" && r.status === 200);
	const bad3d = tileResponses.filter((r) => r.phase === "3D" && r.status !== 200);
	// A camera/style transition may cancel tiles, and the host network can
	// change mid-load. Neither indicates a browser-security rejection when
	// other tiles from this same source have successfully rendered.
	const failures3d = tileFailures.filter((r) => r.phase === "3D" &&
		!/net::ERR_(?:ABORTED|NETWORK_CHANGED)\b/.test(r.error || ""));
	const transient3d = tileFailures.filter((r) => r.phase === "3D").length - failures3d.length;
	const errors3d = corsErrors.filter((r) => r.phase === "3D");
	console.log(`  3D tile responses: ${loaded3d.length} HTTP 200; other: ${bad3d.length}; failed: ${failures3d.length}; cancelled/network-changed: ${transient3d}; CORS errors: ${errors3d.length}`);
	if (!loaded3d.length || bad3d.length || failures3d.length || errors3d.length) {
		throw new Error(`3D QLD Topo tiles did not load cleanly: ${JSON.stringify({
			responses: tileResponses.filter((r) => r.phase === "3D").slice(0, 5),
			failures: failures3d.slice(0, 3), corsErrors: errors3d.slice(0, 3),
		})}`);
	}
	console.log("✓ 3D QLD Topo: raster source loaded with successful tile fetches under normal CORS");
} catch (error) {
	console.error(`✗ Normal-security raster check: ${error.message}`);
	process.exitCode = 1;
} finally {
	await browser.close();
}
