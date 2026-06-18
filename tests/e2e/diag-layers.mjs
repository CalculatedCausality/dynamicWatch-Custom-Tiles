#!/usr/bin/env node
// Diagnostic for two reported bugs:
//   (A) switching base layers before the picked one finishes rendering
//       leaves the imagery unchanged.
//   (B) INTVL Global Map renders UNDER the base when QLD Globe is active.
//
// Not a pass/fail test — it dumps the actual Leaflet/DOM state so we can
// see what's really happening. Run:  node tests/e2e/diag-layers.mjs
import { chromium } from "playwright";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname  = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = resolve(__dirname, "..", "..");
const SCRIPT_SRC = resolve(REPO_ROOT, "dynamicwatch-custom-tiles.user.js");
const BOOTSTRAP  = resolve(__dirname, "lib", "bootstrap.js");
const STATE_PATH = resolve(REPO_ROOT, ".auth", "storage.json");
const HEADED = !!process.env.HEADED;
const URL = "https://dynamic.watch" + (process.env.PLAN || "/plan");

if (!existsSync(STATE_PATH)) { console.error("run npm run e2e:auth first"); process.exit(2); }

const browser = await chromium.launch({
	headless: !HEADED,
	args: ["--disable-web-security", "--disable-features=IsolateOrigins,site-per-process"],
});
const context = await browser.newContext({
	storageState: STATE_PATH,
	viewport: { width: 1600, height: 1000 },
});
await context.addInitScript({ content: readFileSync(BOOTSTRAP, "utf8") });
await context.addInitScript({ content: readFileSync(SCRIPT_SRC, "utf8") });
const page = await context.newPage();
const logs = [];
page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`));

await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
await page.waitForSelector(".leaflet-planner-controls", { timeout: 30_000 });
await page.evaluate(() => {
	document.querySelectorAll(".modal, .modal-backdrop").forEach(el => el.remove());
	document.body.classList.remove("modal-open");
});
await page.waitForFunction(() => !!(window._dwLayerCtrl && window._dwLayerCtrl._map), { timeout: 15_000 });
// Brisbane CBD — inside QLD coverage AND a populated INTVL area.
await page.evaluate(() => window._dwLayerCtrl._map.setView([-27.47, 153.03], 13));
await page.waitForTimeout(500);
const nukeModal = () => page.evaluate(() => {
	document.querySelectorAll(".modal, .modal-backdrop").forEach(el => el.remove());
	document.body.classList.remove("modal-open"); document.body.style.overflow = "";
});

const layerByName = (name) => `(()=>{const c=window._dwLayerCtrl;const e=c._layers.find(l=>l.name===${JSON.stringify(name)});return e&&e.layer;})()`;

// Helper run in page: activate a base + an overlay, then describe stacking.
async function describe(baseName, overlayName) {
	return await page.evaluate(([baseName, overlayName]) => {
		const map = window._dwLayerCtrl._map;
		const ctrl = window._dwLayerCtrl;
		const find = (n) => ctrl._layers.find((l) => l.name === n)?.layer;
		const base = find(baseName), ov = find(overlayName);
		// Remove all other base TileLayers, add target base.
		const bases = ctrl._layers.filter((l) => !l.overlay).map((l) => l.layer);
		bases.forEach((b) => { if (b !== base && map.hasLayer(b)) map.removeLayer(b); });
		if (base && !map.hasLayer(base)) map.addLayer(base);
		if (ov && !map.hasLayer(ov)) map.addLayer(ov);
		return { added: { base: !!base, ov: !!ov } };
	}, [baseName, overlayName]);
}

console.log(`\n=== Reproducing (B): INTVL under QLD Globe (Brisbane z13) ===`);
await describe("QLD Globe", "INTVL Global Map");
await page.waitForTimeout(4000);
await nukeModal();

const stacking = await page.evaluate(() => {
	const map = window._dwLayerCtrl._map;
	// Report every pane that has tiles + its computed z-index.
	const panes = map.getPanes();
	const out = [];
	for (const [name, el] of Object.entries(panes)) {
		const z = getComputedStyle(el).zIndex;
		const tiles = el.querySelectorAll("img.leaflet-tile, canvas").length;
		const loaded = el.querySelectorAll("img.leaflet-tile-loaded").length;
		const childZ = [...el.children].map((c) => getComputedStyle(c).zIndex).join(",");
		if (tiles > 0 || name.startsWith("dw") || name === "tilePane") {
			out.push({ pane: name, zIndex: z, tileEls: tiles, loaded, childZ });
		}
	}
	// Sample the centre pixel stack: what's the topmost visible tile-bearing
	// element at the map centre?
	const size = map.getSize();
	const cx = Math.round(size.x / 2), cy = Math.round(size.y / 2);
	const rect = map.getContainer().getBoundingClientRect();
	const stack = document.elementsFromPoint(rect.left + cx, rect.top + cy)
		.slice(0, 8)
		.map((el) => {
			const paneEl = el.closest(".leaflet-pane");
			return {
				tag: el.tagName.toLowerCase(),
				cls: (el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || "").toString().slice(0, 40),
				pane: paneEl ? [...paneEl.classList].find((c) => c.startsWith("leaflet-") && c.includes("pane")) || paneEl.className : null,
			};
		});
	return { panes: out, centreStack: stack };
});
console.log("Panes (tiles / loaded / child z-indices):");
for (const p of stacking.panes) console.log(`  ${p.pane.padEnd(20)} paneZ=${String(p.zIndex).padEnd(5)} tiles=${p.tileEls} loaded=${p.loaded} childZ=[${p.childZ}]`);
console.log("Centre-pixel element stack (topmost first):");
for (const s of stacking.centreStack) console.log(`  <${s.tag}> ${s.cls}  [pane: ${s.pane}]`);

// Helper: switch base, optionally waiting for tiles to settle between.
async function switchAndReport(names, waitEach) {
	return await page.evaluate(async ([names, waitEach]) => {
		const map = window._dwLayerCtrl._map, ctrl = window._dwLayerCtrl;
		const find = (n) => ctrl._layers.find((l) => l.name === n)?.layer;
		const switchTo = (name) => {
			const target = find(name);
			ctrl._layers.filter((l) => !l.overlay).forEach((l) => {
				if (l.layer !== target && map.hasLayer(l.layer)) map.removeLayer(l.layer);
			});
			if (target && !map.hasLayer(target)) map.addLayer(target);
		};
		const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
		for (const n of names) { switchTo(n); if (waitEach) await sleep(waitEach); }
		return null;
	}, [names, waitEach]);
}
async function baseState() {
	return await page.evaluate(() => {
		const map = window._dwLayerCtrl._map, ctrl = window._dwLayerCtrl;
		const active = ctrl._layers.filter((l) => !l.overlay && map.hasLayer(l.layer)).map((l) => l.name);
		const tp = map.getPane("tilePane");
		const kids = [...tp.children].map((c) => ({
			z: getComputedStyle(c).zIndex,
			loaded: c.querySelectorAll("img.leaflet-tile-loaded").length,
			total: c.querySelectorAll("img.leaflet-tile").length,
			url: (c.querySelector("img.leaflet-tile")?.src || "").slice(0, 55),
		}));
		return { active, kids };
	});
}

console.log(`\n=== (A) SLOW switch (wait 2s each): Google -> QLD Globe -> QLD Topo ===`);
await switchAndReport(["Google Hybrid", "QLD Globe", "QLD Topo"], 2500);
await page.waitForTimeout(2000);
let st = await baseState();
console.log("  active:", st.active.join(", "));
for (const k of st.kids) console.log(`    z=${String(k.z).padEnd(5)} loaded=${k.loaded}/${k.total}  ${k.url}`);

console.log(`\n=== (A) FAST switch (no wait): Google -> QLD Globe -> QLD Topo ===`);
await switchAndReport(["Google Hybrid"], 2500); // settle on Google first
await switchAndReport(["QLD Globe", "QLD Topo"], 0); // rapid
await page.waitForTimeout(4000); // give plenty of time to settle
st = await baseState();
console.log("  active:", st.active.join(", "));
for (const k of st.kids) console.log(`    z=${String(k.z).padEnd(5)} loaded=${k.loaded}/${k.total}  ${k.url}`);

// ---------------------------------------------------------------------
// 3D: the likely home of both bugs (base mirrored as Mapbox raster,
// INTVL as a vector overlay; ordering + async resync live here).
// ---------------------------------------------------------------------
console.log(`\n=== 3D: QLD Globe base + INTVL overlay layer order ===`);
await nukeModal();
// Ensure QLD Globe base + INTVL overlay active in 2D first.
await describe("QLD Globe", "INTVL Global Map");
await page.waitForTimeout(500);
await nukeModal();
// Toggle 3D.
const has3dBtn = await page.evaluate(() => !!document.querySelector(".dw-3d-btn"));
if (!has3dBtn) {
	console.log("  (no .dw-3d-btn found — skipping 3D)");
} else {
	await page.evaluate(() => document.querySelector(".dw-3d-btn").click());
	try {
		await page.waitForFunction(() => window._dwMb && window._dwMb.isStyleLoaded?.(), { timeout: 30_000 });
	} catch { console.log("  (3D style never loaded)"); }
	await page.waitForTimeout(4000);
	const order = await page.evaluate(() => {
		const mb = window._dwMb;
		if (!mb) return { error: "no _dwMb" };
		const layers = (mb.getStyle().layers || []).map((l, i) => ({ i, id: l.id, type: l.type }));
		const idx = (id) => layers.findIndex((l) => l.id === id);
		const baseIdx = idx("active-base");
		const custLayers = layers.filter((l) => l.id.startsWith("dw-cust-"));
		const overlayLayers = layers.filter((l) => l.id.startsWith("dw-overlay-"));
		return {
			order: layers.map((l) => `${l.i}:${l.id}(${l.type})`),
			baseIdx,
			custLayers,
			intvlBelowBase: custLayers.some((l) => l.i < baseIdx),
			overlayLayers,
		};
	});
	if (order.error) { console.log("  ERROR:", order.error); }
	else {
		console.log("  Mapbox layer order (bottom→top):");
		for (const l of order.order) console.log("    " + l);
		console.log(`  active-base at index ${order.baseIdx}`);
		console.log(`  INTVL (dw-cust-*) layers:`, JSON.stringify(order.custLayers));
		console.log(`  >>> INTVL BELOW base? ${order.intvlBelowBase} ${order.intvlBelowBase ? "← BUG REPRODUCED" : "(ok)"}`);
	}

	// Base-switch race in 3D: switch base rapidly, check active-base source.
	console.log(`\n=== 3D base-switch: QLD Globe -> Google -> QLD Topo (rapid) ===`);
	await page.evaluate(async () => {
		const map = window._dwLayerCtrl._map, ctrl = window._dwLayerCtrl;
		const find = (n) => ctrl._layers.find((l) => l.name === n)?.layer;
		const switchTo = (name) => {
			const target = find(name);
			ctrl._layers.filter((l) => !l.overlay).forEach((l) => {
				if (l.layer !== target && map.hasLayer(l.layer)) map.removeLayer(l.layer);
			});
			if (target && !map.hasLayer(target)) map.addLayer(target);
		};
		switchTo("Google Hybrid");
		switchTo("QLD Topo"); // rapid, no wait
	});
	await page.waitForTimeout(4000);
	const after = await page.evaluate(() => {
		const mb = window._dwMb;
		const src = mb.getStyle().sources["active-base"];
		const tiles = src && src.tiles ? src.tiles[0] : null;
		const activeBaseName = (() => {
			const map = window._dwLayerCtrl._map, ctrl = window._dwLayerCtrl;
			return ctrl._layers.filter((l) => !l.overlay && map.hasLayer(l.layer)).map((l) => l.name);
		})();
		return { mbBaseTiles: tiles, leaflet2dActiveBase: activeBaseName };
	});
	console.log(`  [FAST] Leaflet active base: ${after.leaflet2dActiveBase.join(", ")}`);
	console.log(`  [FAST] 3D active-base = ${(after.mbBaseTiles || "").slice(0, 70)}`);
	console.log(`  >>> FAST match? ${after.mbBaseTiles && after.mbBaseTiles.includes("QldMap_Topo") ? "yes (ok)" : "NO — 3D base did not update ← BUG"}`);

	// SLOW switch: wait for the style to idle between each change so
	// _baseTracker's isStyleLoaded() guard passes. If this works while
	// FAST fails, the guard dropping the event is the root cause.
	console.log(`\n=== 3D base-switch SLOW (wait idle each): Google -> QLD Topo ===`);
	const slowSwitch = async (name) => {
		await page.evaluate((n) => {
			const map = window._dwLayerCtrl._map, ctrl = window._dwLayerCtrl;
			const find = (x) => ctrl._layers.find((l) => l.name === x)?.layer;
			const target = find(n);
			ctrl._layers.filter((l) => !l.overlay).forEach((l) => {
				if (l.layer !== target && map.hasLayer(l.layer)) map.removeLayer(l.layer);
			});
			if (target && !map.hasLayer(target)) map.addLayer(target);
		}, name);
		try { await page.waitForFunction(() => window._dwMb?.isStyleLoaded?.(), { timeout: 8000 }); } catch {}
		await page.waitForTimeout(1500);
	};
	await slowSwitch("Google Hybrid");
	await slowSwitch("QLD Topo");
	const afterSlow = await page.evaluate(() => {
		const src = window._dwMb.getStyle().sources["active-base"];
		return src && src.tiles ? src.tiles[0] : null;
	});
	console.log(`  [SLOW] 3D active-base = ${(afterSlow || "").slice(0, 70)}`);
	console.log(`  >>> SLOW match? ${afterSlow && afterSlow.includes("QldMap_Topo") ? "yes (ok)" : "NO"}`);

	// Bug B: with QLD Topo base + INTVL overlay both active in 3D, is
	// INTVL ABOVE active-base in the Mapbox layer stack?
	console.log(`\n=== 3D: INTVL vs active-base order (QLD Topo base) ===`);
	await page.waitForTimeout(1500);
	const bOrder = await page.evaluate(() => {
		const mb = window._dwMb;
		const layers = (mb.getStyle().layers || []).map((l, i) => ({ i, id: l.id }));
		const baseIdx = layers.findIndex((l) => l.id === "active-base");
		const cust = layers.filter((l) => l.id.startsWith("dw-cust-"));
		return {
			order: layers.map((l) => `${l.i}:${l.id}`),
			baseIdx,
			cust,
			intvlBelowBase: cust.length > 0 && cust.some((l) => l.i < baseIdx),
		};
	});
	console.log("  order:", bOrder.order.join("  "));
	console.log(`  active-base @ ${bOrder.baseIdx}, INTVL @ ${JSON.stringify(bOrder.cust.map((l) => l.i))}`);
	console.log(`  >>> INTVL below base? ${bOrder.intvlBelowBase} ${bOrder.intvlBelowBase ? "← BUG B" : "(ok — INTVL on top)"}`);
}

console.log("\n=== relevant console logs ===");
for (const l of logs.filter((l) => l.includes("CustomTiles") || l.toLowerCase().includes("error")).slice(-12)) {
	console.log("  " + l);
}

await browser.close();
