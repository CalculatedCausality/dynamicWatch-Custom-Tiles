#!/usr/bin/env node
// 3D Mode end-to-end check.
//
// Loads dynamic.watch/plan in real Chromium with a Tampermonkey shim +
// the userscript injected, toggles 3D Mode on, then dumps a structured
// snapshot of Mapbox state (sources, layers, errors, pane visibility,
// dw:// registry status) plus the Leaflet inventory.
//
// Run:
//     npm run e2e:check               # headless
//     npm run e2e:check:headed        # see the browser
//     PLAN=/plan/2344645 node …       # open a specific saved plan
//
// Exit code: 0 if the snapshot collected without crashing, 1 if any
// page-side console errors fired or the script failed to inject.
//
// Reads .auth/storage.json (run `npm run e2e:auth` first if missing).
import { chromium } from "playwright";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname  = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = resolve(__dirname, "..", "..");
const SCRIPT_SRC = resolve(REPO_ROOT, "dynamicwatch-custom-tiles.user.js");
const BOOTSTRAP  = resolve(__dirname, "lib", "bootstrap.js");
const STATE_PATH = resolve(REPO_ROOT, ".auth", "storage.json");
const REPORT_DIR = resolve(REPO_ROOT, "test-results");

const HEADED = !!process.env.HEADED;
const PLAN   = process.env.PLAN || "/plan";
const URL    = "https://dynamic.watch" + PLAN;

if (!existsSync(BOOTSTRAP)) {
	console.error(`Missing bootstrap: ${BOOTSTRAP}`);
	process.exit(2);
}
if (!existsSync(SCRIPT_SRC)) {
	console.error(`Missing userscript: ${SCRIPT_SRC}`);
	process.exit(2);
}
const haveAuth = existsSync(STATE_PATH);
if (!haveAuth) {
	console.warn(`No auth state at ${STATE_PATH} — running without login.`);
	console.warn(`Most of /plan is gated. Run \`npm run e2e:auth\` first.`);
}

const bootstrap = readFileSync(BOOTSTRAP, "utf8");
// Strip the `// @grant …` metadata block and the leading `(function(){`
// wrapper — the userscript is already an IIFE. Inject as-is.
const userscript = readFileSync(SCRIPT_SRC, "utf8");

const browser = await chromium.launch({
	headless: !HEADED,
	args: [
		// Bypass CORS for cross-origin tile fetches the userscript needs.
		"--disable-web-security",
		// Disable Chrome's site-isolation so all the third-party tile
		// endpoints render in the same process as the planner page.
		"--disable-features=IsolateOrigins,site-per-process",
	],
});
const context = await browser.newContext({
	storageState: haveAuth ? STATE_PATH : undefined,
	viewport: { width: 1600, height: 1000 },
	// Mirror Tampermonkey's default Origin-spoof behaviour: the
	// userscript spoofs Origin for Stamen via GM_xmlhttpRequest; here we
	// can't set Origin via fetch, so that one layer won't load. Other
	// layers' headers aren't restricted.
});

// Inject BOTH the polyfill and the userscript before every navigation.
// `addInitScript` runs in document_start, ahead of any page scripts.
await context.addInitScript({ content: bootstrap });
await context.addInitScript({ content: userscript });

const page = await context.newPage();

// Collect console output + page errors.
const logs = [];
const errors = [];
page.on("console", (msg) => {
	logs.push({ type: msg.type(), text: msg.text() });
});
page.on("pageerror", (err) => {
	errors.push({ type: "pageerror", text: err.message, stack: err.stack });
});

console.log(`→ ${URL}`);
const response = await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
const status = response?.status();
if (status && status >= 400) {
	console.error(`HTTP ${status} loading ${URL}`);
	await browser.close();
	process.exit(1);
}
if (page.url().includes("/users/sign_in")) {
	console.error("Redirected to sign_in — auth state missing or expired.");
	console.error(`Run \`npm run e2e:auth\` to refresh ${STATE_PATH}.`);
	await browser.close();
	process.exit(1);
}

// Wait for the planner Leaflet root to render (signals the script has
// hooked into the page).
try {
	await page.waitForSelector(".leaflet-planner-controls", { timeout: 30_000 });
} catch (e) {
	console.error("Timed out waiting for .leaflet-planner-controls — userscript probably didn't load.");
	await dumpAndExit(1);
}

// Wait for the 3D button injection.
try {
	await page.waitForSelector(".dw-3d-btn", { timeout: 10_000 });
	console.log("✓ 3D button injected");
} catch (e) {
	console.error("3D button never appeared — userscript ran but Mode3DButton.attach() didn't fire.");
	await dumpAndExit(1);
}

// Optionally enable Leaflet overlays BEFORE turning 3D on so the
// snapshot covers the layer-mirroring code paths. Pass them via env:
//   OVERLAYS="INTVL Global Map,Geocaches,Mobile Coverage" node …
// Adds layers directly via the control's registry rather than fighting
// the layer-panel UI (which is intercepted by modals at boot).
const overlays = (process.env.OVERLAYS || "")
	.split(",").map(s => s.trim()).filter(Boolean);
if (overlays.length) {
	// Wait for the layer control to actually finish booting. dynamic.watch
	// creates it after Leaflet is ready, but our 3D button can land
	// earlier in the same tick.
	await page.waitForFunction(
		() => !!window._dwLayerCtrl?._map, { timeout: 10_000 },
	).catch(() => {});
	for (const name of overlays) {
		const result = await page.evaluate((n) => {
			const ctrl = window._dwLayerCtrl;
			if (!ctrl) return { ok: false, reason: "no ctrl exposed" };
			const map = ctrl._map;
			if (!map) return { ok: false, reason: "ctrl has no _map" };
			const entry = ctrl._layers.find((l) => l.name === n && l.overlay);
			if (!entry) {
				const all = ctrl._layers.filter(l => l.overlay).map(l => l.name);
				return { ok: false, reason: `not found; have: ${all.join(", ")}` };
			}
			if (map.hasLayer(entry.layer)) return { ok: true, alreadyOn: true };
			map.addLayer(entry.layer);
			return { ok: true };
		}, name);
		if (result.ok) console.log(`✓ Enabled overlay: ${name}${result.alreadyOn ? " (already on)" : ""}`);
		else           console.log(`✗ Overlay '${name}': ${result.reason}`);
	}
	await page.waitForTimeout(1500);
}

// dynamic.watch pops a help / save-route modal on first visit that
// covers the planner row and intercepts clicks. Press Escape and
// dismiss any visible modal-backdrop before reaching the 3D button.
try {
	await page.keyboard.press("Escape");
	await page.waitForTimeout(200);
	await page.evaluate(() => {
		document.querySelectorAll(".modal.fade.in, .modal-backdrop").forEach(el => el.remove());
		document.body.classList.remove("modal-open");
		document.body.style.overflow = "";
	});
} catch (_) {}

// Toggle 3D on, then wait for Mapbox GL to load and the style to ready.
try {
	await page.click(".dw-3d-btn", { timeout: 8_000 });
} catch (e) {
	// Modals re-appearing or React re-render — try a direct DOM click.
	await page.evaluate(() => document.querySelector(".dw-3d-btn")?.click());
}
console.log("✓ Clicked 3D button");
try {
	await page.waitForFunction(() => window._dwMb && window._dwMb.isStyleLoaded?.(), {
		timeout: 30_000,
	});
	console.log("✓ Mapbox style loaded");
} catch (e) {
	console.error("Mapbox style never loaded — see logs.");
	await dumpAndExit(1);
}

// Let any deferred layer-syncs settle.
await page.waitForTimeout(2500);

// Capture the snapshot — same shape as the manual debug snippets.
const snapshot = await page.evaluate(() => {
	const mb  = window._dwMb;
	const map = window._dwMap;
	const reg = window._dwRegistry;
	if (!mb || !map) return { error: "no _dwMb or _dwMap" };

	const style = mb.getStyle();
	const sources = Object.entries(style.sources || {}).map(([id, src]) => ({
		id, type: src.type, tiles: src.tiles?.slice(0, 1),
	}));
	const layers = (style.layers || []).map((l) => ({
		id: l.id, type: l.type, source: l.source, srcLayer: l["source-layer"],
	}));

	// Walk the Leaflet map recursively into LayerGroups.
	const leafletLayers = [];
	const visit = (lyr) => {
		if (lyr instanceof L.LayerGroup) { lyr.eachLayer(visit); return; }
		const opts = lyr.options || {};
		leafletLayers.push({
			class:    lyr.constructor?.name || "?",
			isTile:   lyr instanceof L.TileLayer,
			isPoly:   lyr instanceof L.Polyline,
			isPolygon:lyr instanceof L.Polygon,
			isMarker: lyr instanceof L.Marker,
			isGrid:   lyr instanceof L.GridLayer,
			pane:     opts.pane || "(default)",
			url:      typeof lyr._url === "string" ? lyr._url.slice(0, 80) : null,
			dwMbKey:  lyr._dwMbKey || null,
			has3DUrl: !!lyr._dwMb3DUrl,
			has3DGet: typeof lyr._dwMb3DGetUrl === "function",
			has3DStyle: !!lyr._dwMb3DStyle,
		});
	};
	map.eachLayer(visit);

	const byPane = {};
	for (const l of leafletLayers) {
		byPane[l.pane] = (byPane[l.pane] || 0) + 1;
	}

	return {
		mbStyleLoaded:      mb.isStyleLoaded(),
		mbCenter:           mb.getCenter(),
		mbZoom:             mb.getZoom(),
		mbPitch:            mb.getPitch(),
		mbSources:          sources,
		mbLayers:           layers,
		leafletLayerCount:  leafletLayers.length,
		leafletPaneCounts:  byPane,
		leafletLayersSample:leafletLayers.slice(0, 50),
		dwRegistrySize:     reg ? reg.size : 0,
		dwRegistryKeys:     reg ? [...reg.keys()] : [],
		hasAddProtocol:     typeof window.mapboxgl?.addProtocol === "function",
	};
});

// Persist snapshot + logs + errors to test-results/
if (!existsSync(REPORT_DIR)) mkdirSync(REPORT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const reportPath = resolve(REPORT_DIR, `3d-check-${stamp}.json`);
const shotPath   = resolve(REPORT_DIR, `3d-check-${stamp}.png`);
writeFileSync(reportPath, JSON.stringify({
	url: URL,
	overlays,
	snapshot,
	consoleLogs: logs.slice(-200),
	pageErrors: errors,
}, null, 2));
await page.screenshot({ path: shotPath, fullPage: false });
console.log(`\nReport written: ${reportPath}`);
console.log(`Screenshot:     ${shotPath}`);

// Headline summary to stdout.
console.log("\n=== 3D SNAPSHOT ===");
console.log(JSON.stringify(snapshot, null, 2));

const customTileLogs = logs.filter(l => l.text.includes("CustomTiles"));
if (customTileLogs.length) {
	console.log("\n=== [CustomTiles] logs ===");
	for (const l of customTileLogs.slice(-20)) console.log(`  ${l.type}: ${l.text}`);
}
if (errors.length) {
	console.log("\n=== PAGE ERRORS ===");
	for (const e of errors.slice(-10)) console.log(`  ${e.text}`);
}

await browser.close();
process.exit(errors.length ? 1 : 0);

async function dumpAndExit(code) {
	if (logs.length) {
		console.error("\nConsole logs:");
		for (const l of logs.slice(-30)) console.error(`  [${l.type}] ${l.text}`);
	}
	if (errors.length) {
		console.error("\nPage errors:");
		for (const e of errors) console.error(`  ${e.text}\n${e.stack || ""}`);
	}
	await browser.close();
	process.exit(code);
}
