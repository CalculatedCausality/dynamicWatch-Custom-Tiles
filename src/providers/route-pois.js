import { CFG } from "../config.js";
import { mountPlannerButton } from "../ui/planner-toolbar.js";
import { cachedFetch, gmCancel, gmGet, gmJsonGet } from "../utils/http.js";
import { _escHtml, esc } from "../utils/html.js";
import { decodeGeometry, mvtDecode } from "../utils/mvt.js";
import {
	createRouteIndex,
	haversine,
	longestGap,
	measureRoute,
	routeParts,
	routePasses,
	routeSignature,
	routeTiles,
	sliceRoute,
} from "../utils/route-geometry.js";
import { _dwGetRouteModel } from "../utils/route-model.js";

/* -- POIs along the planned route ---------------------------------------
 * The planner-toolbar button reads dynamic.watch's route, loads the z14
 * OpenMapTiles vector tiles (OpenFreeMap: keyless, CDN-cached) covering a
 * corridor around it, and pins useful stops — water, toilets, food, shops,
 * views, shelter — with their distance along the route. Each POI can be
 * added to the plan as a named waypoint, which dynamic.watch exports to
 * the watch once the route is saved.
 */

export const POI_CATEGORIES = [
	{ id: "water", label: "Water", icon: "fa-tint", color: "#1e88e5",
		types: ["drinking_water", "water_point", "water_tap", "spring"] },
	{ id: "toilets", label: "Toilets", glyph: "WC", color: "#5d4037",
		types: ["toilets"] },
	{ id: "food", label: "Food & drink", icon: "fa-coffee", color: "#ef6c00",
		types: ["cafe", "restaurant", "fast_food", "pub", "bar", "biergarten", "ice_cream", "food_court"] },
	{ id: "shop", label: "Shops & fuel", icon: "fa-shopping-cart", color: "#2e7d32",
		types: ["supermarket", "convenience", "bakery", "greengrocer", "deli", "fuel"] },
	{ id: "views", label: "Views & peaks", icon: "fa-binoculars", color: "#7b1fa2",
		types: ["viewpoint", "peak", "volcano"] },
	{ id: "shelter", label: "Shelter & camping", icon: "fa-home", color: "#455a64",
		types: ["shelter", "alpine_hut", "wilderness_hut", "camp_site"] },
	{ id: "medical", label: "Medical", icon: "fa-medkit", color: "#c62828",
		types: ["pharmacy", "hospital", "defibrillator"] },
	{ id: "bike", label: "Bike", icon: "fa-wrench", color: "#00838f",
		types: ["bicycle_repair_station", "bicycle"] },
];

const CATEGORY = Object.fromEntries(POI_CATEGORIES.map((c) => [c.id, c]));
const CATEGORY_BY_TYPE = new Map(
	POI_CATEGORIES.flatMap((c) => c.types.map((type) => [type, c.id])));

const TYPE_LABELS = {
	drinking_water: "Drinking water", water_point: "Water point", water_tap: "Water tap",
	spring: "Spring", toilets: "Toilets", cafe: "Café", restaurant: "Restaurant",
	fast_food: "Fast food", pub: "Pub", bar: "Bar", biergarten: "Beer garden",
	ice_cream: "Ice cream", food_court: "Food court", supermarket: "Supermarket",
	convenience: "Convenience store", bakery: "Bakery", greengrocer: "Greengrocer",
	deli: "Deli", fuel: "Fuel station", viewpoint: "Viewpoint", peak: "Peak",
	volcano: "Volcano", shelter: "Shelter", alpine_hut: "Hut", wilderness_hut: "Hut",
	camp_site: "Campsite", pharmacy: "Pharmacy", hospital: "Hospital",
	defibrillator: "Defibrillator", bicycle_repair_station: "Bike repair",
	bicycle: "Bike shop",
};
const TYPE_GLYPHS = { peak: "▲", volcano: "▲" };

export const POI_RADIUS_OPTIONS = [50, 100, 250, 500];

// OpenMapTiles `poi` (subclass/class) and `mountain_peak` (class) features.
export function classifyPoi(layerName, props) {
	if (layerName === "mountain_peak") {
		const type = String(props.class || "");
		return type === "peak" || type === "volcano" ? { category: "views", type } : null;
	}
	if (layerName !== "poi") return null;
	const type = String(props.subclass || props.class || "");
	const category = CATEGORY_BY_TYPE.get(type);
	return category ? { category, type } : null;
}

function cleanName(value) {
	return String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 120);
}

// Decode one z/x/y vector tile into category POIs plus bus-stop positions
// (used to drop the many bus shelters tagged amenity=shelter).
export function decodePoiTile(buffer, z, x, y) {
	const n = 2 ** z;
	const pois = [], busStops = [];
	for (const layer of mvtDecode(buffer)) {
		if (layer.name !== "poi" && layer.name !== "mountain_peak") continue;
		const ext = layer.extent || 4096;
		for (const f of layer.features) {
			const props = {};
			for (let i = 0; i + 1 < f.tags.length; i += 2) {
				props[layer.keys[f.tags[i]]] = layer.values[f.tags[i + 1]];
			}
			const busStop = layer.name === "poi" && props.subclass === "bus_stop";
			const kind = busStop ? null : classifyPoi(layer.name, props);
			if (!busStop && !kind) continue;
			const p = decodeGeometry(f.geom)[0]?.[0];
			if (!p) continue;
			const lng = (x + p[0] / ext) / n * 360 - 180;
			const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + p[1] / ext) / n))) * 180 / Math.PI;
			if (busStop) { busStops.push([lng, lat]); continue; }
			const ele = Number(props.ele);
			pois.push({
				...kind, name: cleanName(props.name),
				ele: props.ele != null && Number.isFinite(ele) ? Math.round(ele) : null,
				lng, lat,
			});
		}
	}
	return { pois, busStops };
}

// Keep POIs within `radius` of the route, merge the copies that appear in
// neighbouring tiles' buffers, and order them by distance along the route.
export function selectRoutePois(tiles, route, radius) {
	const index = createRouteIndex(route, radius);
	const stopCells = new Map();
	const cellKey = (lng, lat) => Math.round(lng * 2000) + "," + Math.round(lat * 2000);
	for (const tile of tiles) {
		for (const stop of tile.busStops || []) {
			const key = cellKey(stop[0], stop[1]);
			if (!stopCells.has(key)) stopCells.set(key, []);
			stopCells.get(key).push(stop);
		}
	}
	const nearBusStop = (poi) => {
		const cx = Math.round(poi.lng * 2000), cy = Math.round(poi.lat * 2000);
		for (let dx = -1; dx <= 1; dx++) {
			for (let dy = -1; dy <= 1; dy++) {
				for (const stop of stopCells.get((cx + dx) + "," + (cy + dy)) || []) {
					if (haversine(stop, [poi.lng, poi.lat]) <= 25) return true;
				}
			}
		}
		return false;
	};
	const seen = new Map(), ids = new Set(), kept = [];
	for (const tile of tiles) {
		for (const poi of tile.pois || []) {
			if (poi.type === "shelter" && nearBusStop(poi)) continue;
			const key = poi.type + "|" + poi.name.toLowerCase();
			const same = seen.get(key) || [];
			if (same.some((q) => haversine([q.lng, q.lat], [poi.lng, poi.lat]) < 15)) continue;
			const passes = routePasses(index, poi.lng, poi.lat);
			if (!passes.length) continue;
			same.push(poi);
			seen.set(key, same);
			let id = poi.type + ":" + poi.lat.toFixed(5) + "," + poi.lng.toFixed(5);
			for (let i = 2; ids.has(id); i++) id = id.replace(/#\d+$/, "") + "#" + i;
			ids.add(id);
			kept.push({
				...poi, id, passes,
				along: passes[0].along,
				offset: Math.min(...passes.map((pass) => pass.offset)),
			});
		}
	}
	return kept.sort((a, b) => a.along - b.along || a.offset - b.offset);
}

export function poiTypeLabel(poi) {
	return TYPE_LABELS[poi.type] || CATEGORY[poi.category]?.label || "Point of interest";
}

// dynamic.watch caps waypoint names (16 characters); watches render plain text.
export function waypointName(poi, maxLength = 16) {
	const base = poi.name || poiTypeLabel(poi);
	return base.replace(/\s+/g, " ").trim().slice(0, Math.max(1, maxLength)).trim();
}

export function formatRouteDistance(metres, metric = true) {
	return metric ? (metres / 1000).toFixed(1) + " km" : (metres / 1609.344).toFixed(1) + " mi";
}

export function formatRange(from, to, metric = true) {
	const unit = metric ? 1000 : 1609.344;
	return (from / unit).toFixed(1) + "–" + (to / unit).toFixed(1) + (metric ? " km" : " mi");
}

// Water drives the gap warning; cafés and shops can usually refill a bottle.
export const SUPPLY_GAPS = {
	water: ["water"],
	resupply: ["water", "food", "shop"],
};

// Longest stretch of the route without a POI from `categories`, counting
// every pass of an out-and-back route. `count` is the number of such POIs.
export function supplyGap(pois, total, categories) {
	const wanted = new Set(categories);
	const sources = (pois || []).filter((poi) => wanted.has(poi.category));
	const gap = longestGap(sources.flatMap((poi) => poi.passes.map((pass) => pass.along)), total);
	return gap && { ...gap, count: sources.length };
}

export function formatOffset(metres, metric = true) {
	return metric ? Math.round(metres) + " m" : Math.round(metres * 3.28084) + " ft";
}

/* -- Tile loading -------------------------------------------------------- */

const _tileCache = new Map();
const TILE_CACHE_MAX = 800;
const TEMPLATE_RE = /^https:\/\/tiles\.openfreemap\.org\/[^?#\s]*\{z\}\/\{x\}\/\{y\}\.pbf$/;

function cacheTile(key, value) {
	_tileCache.delete(key);
	_tileCache.set(key, value);
	while (_tileCache.size > TILE_CACHE_MAX) _tileCache.delete(_tileCache.keys().next().value);
}

// The TileJSON names the current planet build; its tile URLs are immutable.
function resolveTileTemplate(cb) {
	cachedFetch("openfreemap_tiles_v1", 12 * 3600 * 1000, (done) => {
		gmJsonGet(CFG.OPENFREEMAP_TILEJSON, { timeout: 15000 }, (err, data) => {
			const template = data && Array.isArray(data.tiles) ? String(data.tiles[0] || "") : "";
			if (err || !TEMPLATE_RE.test(template)) { done(err || new Error("tilejson")); return; }
			done(null, template);
		});
	}, cb);
}

function gmFetchTile(url, cb) {
	const handle = gmGet(url, { responseType: "arraybuffer", timeout: 20000 }, (err, r) => {
		if (err || !r || r.status !== 200 || !r.response) cb(err || new Error("HTTP " + (r && r.status)));
		else cb(null, r.response);
	});
	return { abort: () => gmCancel(handle) };
}

// Fetch and decode tiles with bounded concurrency and one retry each.
export function loadPoiTiles(tiles, { template, z, fetchTile = gmFetchTile, concurrency = 6, onProgress }, cb) {
	const results = new Array(tiles.length);
	const inflight = new Set();
	let next = 0, completed = 0, failed = 0, cancelled = false, finished = false;
	const progress = () => { if (onProgress) onProgress(completed, tiles.length); };
	const finish = () => {
		if (finished || cancelled || completed < tiles.length) return;
		finished = true;
		cb(null, { tiles: results.filter(Boolean), failed });
	};
	const pump = () => {
		while (!cancelled && inflight.size < concurrency && next < tiles.length) {
			const i = next++;
			const [x, y] = tiles[i];
			const key = template + "|" + z + "/" + x + "/" + y;
			const cached = _tileCache.get(key);
			if (cached) {
				results[i] = cached;
				completed++;
				progress();
				continue;
			}
			const url = template.replace("{z}", z).replace("{x}", x).replace("{y}", y);
			const attempt = (retry) => {
				const slot = {};
				inflight.add(slot);
				slot.request = fetchTile(url, (err, buffer) => {
					inflight.delete(slot);
					if (cancelled) return;
					let decoded = null;
					if (!err && buffer) {
						try { decoded = decodePoiTile(buffer, z, x, y); } catch (_) {}
					}
					if (!decoded && !retry) { attempt(true); return; }
					if (decoded) { results[i] = decoded; cacheTile(key, decoded); }
					else failed++;
					completed++;
					progress();
					pump();
				});
			};
			attempt(false);
		}
		finish();
	};
	pump();
	return {
		cancel() {
			cancelled = true;
			for (const slot of inflight) {
				try { slot.request && slot.request.abort && slot.request.abort(); } catch (_) {}
			}
			inflight.clear();
		},
	};
}

function poiError(code, message) {
	const error = new Error(message);
	error.code = code;
	return error;
}

// Route paths ([lng, lat] arrays per planner segment) → POIs along the route.
export function findRoutePois(paths, radius, opts, cb) {
	opts = opts || {};
	const parts = routeParts(paths);
	if (!parts.length) {
		cb(poiError("noroute", "Draw a route first, then press the POI button."));
		return { cancel() {} };
	}
	const route = measureRoute(parts);
	const z = CFG.ROUTE_POI_TILE_ZOOM;
	const tiles = routeTiles(route, radius, z);
	if (tiles.length > CFG.ROUTE_POI_MAX_TILES) {
		cb(poiError("toolong", "This route is too long to search in one go — " +
			"try a smaller corridor or split the route."));
		return { cancel() {} };
	}
	let cancelled = false, inner = null;
	(opts.resolveTemplate || resolveTileTemplate)((err, template) => {
		if (cancelled) return;
		if (err || !template) {
			cb(poiError("tiles", "Couldn't reach the OpenFreeMap map-data index. Try again shortly."));
			return;
		}
		inner = loadPoiTiles(tiles, {
			template, z, fetchTile: opts.fetchTile, onProgress: opts.onProgress,
		}, (_err, result) => {
			if (cancelled) return;
			if (tiles.length && result.failed === tiles.length) {
				cb(poiError("tiles", "Couldn't load map data for this route. Try again shortly."));
				return;
			}
			cb(null, {
				pois: selectRoutePois(result.tiles, route, radius),
				route, tileCount: tiles.length, failedTiles: result.failed,
			});
		});
	});
	return { cancel() { cancelled = true; if (inner) inner.cancel(); } };
}

/* -- Map UI -------------------------------------------------------------- */

function pageWindow() {
	return typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
}

// Firefox userscript managers isolate the sandbox; hand page code a page array.
function toPage(value) {
	return typeof cloneInto === "function" ? cloneInto(value, pageWindow()) : value;
}

function loadPrefs() {
	let prefs = {};
	try { prefs = JSON.parse(GM_getValue(CFG.ROUTE_POI_PREFS_KEY, "{}")) || {}; } catch (_) {}
	const radius = Number(prefs.radius);
	return {
		radius: POI_RADIUS_OPTIONS.includes(radius) ? radius : 100,
		hidden: Array.isArray(prefs.hidden) ? prefs.hidden.filter((id) => CATEGORY[id]) : [],
	};
}

const LIST_LIMIT = 300;
const CONFIRM_ADD_ALL_OVER = 20;
// While POIs are shown, poll the route this often; an edit must hold for two
// polls (router responses included) before the search re-runs.
const ROUTE_WATCH_MS = 1500;

export class RoutePoiController {
	constructor(map) {
		this._map = map;
		this._state = "idle";
		this._gen = 0;
		this._handle = null;
		this._pois = [];
		this._route = null;
		this._markers = new Map();
		this._added = new Set();
		this._group = null;
		this._panel = null;
		this._btn = null;
		this._status = { text: "", error: false, note: false };
		this._summary = null;
		this._prefs = loadPrefs();
		this._syncTimer = null;
		this._gapLayer = null;
		this._watchTimer = null;
		this._searchedSig = null;
		this._pendingSig = null;
		this._scrollReset = false;
		// Undo, deleting a waypoint or reloading the plan swaps planner markers;
		// re-derive which POIs are waypoints after any marker change.
		this._onMapLayers = () => {
			clearTimeout(this._syncTimer);
			this._syncTimer = setTimeout(() => this._syncAdded(), 200);
		};
	}

	attachButton() {
		mountPlannerButton({
			id: "dw-poi-btn",
			className: "dw-poi-btn",
			title: "Find POIs along the route",
			iconClass: "fa-map-signs",
			onClick: () => this.toggle(),
			onMount: (btn) => { this._btn = btn; this._syncButton(); },
		});
	}

	toggle() {
		if (this._state === "idle") this.search();
		else this.clear();
	}

	search(auto = false) {
		this._cancel();
		const gen = ++this._gen;
		this._ensurePanel();
		this._setState("loading");
		this._setStatus(auto ? "Route changed — updating POIs…" : "Finding POIs along the route…");
		const paths = this._currentPaths();
		this._searchedSig = routeSignature(paths);
		this._pendingSig = null;
		this._startWatching();
		this._handle = findRoutePois(paths, this._prefs.radius, {
			onProgress: (done, total) => {
				if (gen === this._gen) this._setStatus(`Reading map data… ${done}/${total} tiles`);
			},
		}, (err, result) => {
			if (gen !== this._gen) return;
			this._handle = null;
			this._pois = err ? [] : result.pois;
			this._route = err ? null : result.route;
			this._map.off("layeradd layerremove", this._onMapLayers);
			if (this._pois.length) this._map.on("layeradd layerremove", this._onMapLayers);
			this._clearGap();
			this._renderMarkers();
			this._scrollReset = true;
			this._setState("active");
			if (err) {
				this._summary = { text: err.message, error: true };
				this._setStatus(err.message, true);
				return;
			}
			const metric = this._metric();
			const found = this._pois.length
				? `${this._pois.length} POI${this._pois.length === 1 ? "" : "s"}`
				: "No POIs";
			const failed = result.failedTiles
				? ` · ${result.failedTiles} of ${result.tileCount} map tiles didn't load` : "";
			this._summary = {
				text: `${found} within ${formatOffset(this._prefs.radius, metric)} of the ` +
					`${formatRouteDistance(result.route.total, metric)} route${failed}`,
				error: !!result.failedTiles,
			};
			this._setStatus(this._summary.text, this._summary.error);
		});
	}

	clear() {
		this._cancel();
		this._gen++;
		this._pois = [];
		this._route = null;
		this._map.off("layeradd layerremove", this._onMapLayers);
		clearTimeout(this._syncTimer);
		this._stopWatching();
		this._clearGap();
		if (this._group) { this._group.remove(); this._group = null; }
		this._markers.clear();
		if (this._panel) { this._panel.remove(); this._panel = null; }
		this._setState("idle");
	}

	_cancel() {
		if (this._handle) { this._handle.cancel(); this._handle = null; }
	}

	_currentPaths() {
		return _dwGetRouteModel().paths.map((entry) => entry.points);
	}

	// -- Following route edits ----------------------------------------------

	_startWatching() {
		if (this._watchTimer) return;
		this._watchTimer = setInterval(() => this._checkRoute(), ROUTE_WATCH_MS);
	}

	_stopWatching() {
		clearInterval(this._watchTimer);
		this._watchTimer = null;
		this._searchedSig = this._pendingSig = null;
	}

	_checkRoute() {
		if (this._state === "idle") return;
		if (typeof document !== "undefined" && document.hidden) return;
		const sig = routeSignature(this._currentPaths());
		if (sig === this._searchedSig) { this._pendingSig = null; return; }
		if (sig !== this._pendingSig) { this._pendingSig = sig; return; }
		this.search(true);
	}

	// -- Supply gaps ---------------------------------------------------------

	_gap(kind) {
		return this._route ? supplyGap(this._pois, this._route.total, SUPPLY_GAPS[kind]) : null;
	}

	_clearGap() {
		if (this._gapLayer) { this._gapLayer.remove(); this._gapLayer = null; }
	}

	// Highlight a gap on the route and fit it beside the panel.
	_showGap(kind) {
		const gap = this._gap(kind);
		if (!gap) return;
		const lines = sliceRoute(this._route, gap.from, gap.to)
			.map((line) => line.map((p) => [p[1], p[0]]));
		if (!lines.length) return;
		this._clearGap();
		this._gapLayer = L.layerGroup(lines.map((line) => L.polyline(line, {
			color: "#e53935", weight: 9, opacity: 0.45, dashArray: "10 8",
			lineCap: "butt", interactive: false,
		}))).addTo(this._map);
		const bounds = L.latLngBounds(lines.flat());
		const panelWidth = this._panel ? this._panel.offsetWidth + 24 : 40;
		this._map.fitBounds(bounds, { paddingTopLeft: [panelWidth, 50], paddingBottomRight: [40, 70] });
	}

	_gapHtml() {
		if (this._state !== "active" || !this._route) return "";
		const metric = this._metric();
		const radius = formatOffset(this._prefs.radius, metric);
		const water = this._gap("water");
		const resupply = this._gap("resupply");
		if (!water) return "";
		const line = (kind, gap, label) =>
			esc`<button type="button" class="dw-poi-gap" data-poi-gap="${kind}" title="Show this stretch on the map">` +
			esc`${label}: <b>${formatRouteDistance(gap.length, metric)}</b> (${formatRange(gap.from, gap.to, metric)})</button>`;
		const parts = [];
		if (!water.count) {
			parts.push(esc`<div class="dw-poi-gap-warn"><i class="fa fa-tint"></i> No drinking water within ${radius} of the route</div>`);
		} else {
			parts.push(`<div><i class="fa fa-tint"></i> ` + line("water", water, "Longest stretch without water") + `</div>`);
		}
		// Only worth a line when cafés and shops shorten the gap noticeably.
		if (resupply && resupply.count > water.count && resupply.length < water.length - 250) {
			parts.push(`<div class="dw-poi-gap-sub">` + line("resupply", resupply, "Counting cafés & shops") + `</div>`);
		}
		return `<div class="dw-poi-gaps">${parts.join("")}</div>`;
	}

	_plan() {
		try { return pageWindow().leafletPlan || null; } catch (_) { return null; }
	}

	_metric() {
		const plan = this._plan();
		return !plan || plan.unitsMetric !== false;
	}

	_savePrefs() {
		try { GM_setValue(CFG.ROUTE_POI_PREFS_KEY, JSON.stringify(this._prefs)); } catch (_) {}
	}

	_setState(state) {
		this._state = state;
		this._syncButton();
	}

	_syncButton() {
		const btn = this._btn;
		if (!btn) return;
		btn.classList.toggle("active", this._state !== "idle");
		btn.setAttribute("aria-pressed", this._state === "idle" ? "false" : "true");
		const icon = btn.querySelector("i");
		if (icon) icon.className = this._state === "loading" ? "fa fa-spinner fa-spin" : "fa fa-map-signs";
		btn.title = this._state === "idle" ? "Find POIs along the route" : "Clear route POIs";
	}

	_setStatus(text, error = false) {
		this._status = { text, error, note: false };
		this._renderPanel();
	}

	// Waypoint messages replace the search summary until the waypoints change.
	_note(text, error = false) {
		this._status = { text, error, note: true };
		this._renderPanel();
	}

	_visiblePois() {
		const hidden = new Set(this._prefs.hidden);
		return this._pois.filter((poi) => !hidden.has(poi.category));
	}

	// -- Markers ----------------------------------------------------------

	_icon(poi) {
		const cat = CATEGORY[poi.category];
		const glyph = TYPE_GLYPHS[poi.type] || cat.glyph;
		const inner = glyph ? `<b>${_escHtml(glyph)}</b>` : `<i class="fa ${cat.icon}"></i>`;
		return L.divIcon({
			className: "dw-poi-icon" + (this._added.has(poi.id) ? " dw-poi-icon--added" : ""),
			html: `<span class="dw-poi-pin" style="background:${cat.color}">${inner}</span>`,
			// A teardrop whose tip marks the POI, so its head stays visible and
			// clickable when a planner marker sits on the same spot.
			iconSize: [22, 22], iconAnchor: [11, 27], popupAnchor: [0, -27], tooltipAnchor: [0, -27],
		});
	}

	_renderMarkers() {
		this._refreshAdded();
		if (!this._group) this._group = L.layerGroup().addTo(this._map);
		this._group.clearLayers();
		this._markers.clear();
		for (const poi of this._visiblePois()) {
			// Below the planner's own draggable route markers.
			const marker = L.marker([poi.lat, poi.lng], {
				icon: this._icon(poi), keyboard: false, riseOnHover: true, zIndexOffset: -1000,
			});
			marker.bindTooltip(() => this._tooltipHtml(poi), { direction: "top", className: "dw-poi-tip" });
			marker.bindPopup(() => this._popupHtml(poi), { className: "dw-poi-popup", maxWidth: 260 });
			marker.on("popupopen", (e) => this._onPopupOpen(poi, e));
			marker.on("popupclose", () => {
				const plan = this._plan();
				if (plan && typeof plan.ignoreMapClicks === "function") plan.ignoreMapClicks(false);
			});
			this._group.addLayer(marker);
			this._markers.set(poi.id, marker);
		}
	}

	_passesText(poi) {
		const metric = this._metric();
		return poi.passes.map((pass) => formatRouteDistance(pass.along, metric)).join(" & ");
	}

	_tooltipHtml(poi) {
		const label = poiTypeLabel(poi);
		return esc`<b>${poi.name || label}</b><br>${label} · ${this._passesText(poi)}`;
	}

	_popupHtml(poi) {
		const label = poiTypeLabel(poi);
		const metric = this._metric();
		const ele = poi.ele != null ? ` · ${formatOffset(poi.ele, metric)}` : "";
		const added = this._added.has(poi.id);
		const maps = "https://www.google.com/maps/search/?api=1&query=" +
			poi.lat.toFixed(6) + "," + poi.lng.toFixed(6);
		return `<div class="dw-poi-pop">` +
			esc`<b>${poi.name || label}</b>` +
			esc`<div class="dw-poi-pop-sub">${label}${ele}</div>` +
			esc`<div>At ${this._passesText(poi)} · ${formatOffset(poi.offset, metric)} off route</div>` +
			`<div class="dw-poi-pop-actions">` +
			esc`<button type="button" class="dw-poi-add-btn" data-poi-id="${poi.id}"` +
			(added ? " disabled>Waypoint added" : ">Add as waypoint") + `</button>` +
			esc`<a href="${maps}" target="_blank" rel="noreferrer">Google Maps ↗</a>` +
			`</div></div>`;
	}

	_onPopupOpen(poi, e) {
		const plan = this._plan();
		if (plan && typeof plan.ignoreMapClicks === "function") plan.ignoreMapClicks(true);
		// Leaflet re-renders function content when an open popup is reopened
		// (e.g. from the list) without another popupopen, so delegate from the
		// popup's persistent container instead of binding the button itself.
		const el = e.popup.getElement ? e.popup.getElement() : e.popup._container;
		if (!el || el._dwPoiBound) return;
		el._dwPoiBound = true;
		L.DomEvent.on(el, "click", (ev) => {
			const btn = ev.target && ev.target.closest ? ev.target.closest(".dw-poi-add-btn") : null;
			if (!btn) return;
			L.DomEvent.stop(ev);
			const target = this._poiById(btn.dataset.poiId) || poi;
			if (this._addWaypoint(target) || this._added.has(target.id)) {
				btn.disabled = true;
				btn.textContent = "Waypoint added";
			}
		});
	}

	_focusPoi(poi) {
		const marker = this._markers.get(poi.id);
		this._map.setView([poi.lat, poi.lng], Math.max(this._map.getZoom(), 16));
		if (marker) marker.openPopup();
	}

	// -- Waypoints ----------------------------------------------------------

	_addWaypoint(poi, quiet = false) {
		const plan = this._plan();
		if (!plan || typeof plan.addWaypoint !== "function") {
			this._note("This dynamic.watch page doesn't support adding waypoints.", true);
			return false;
		}
		if (this._waypointNear(poi)) {
			this._markAdded(poi);
			if (!quiet) this._note("A waypoint is already there.");
			return false;
		}
		const max = Number(plan.waypointCountMax);
		if (Number.isFinite(max) && Array.isArray(plan.waypoints) && plan.waypoints.length >= max) {
			this._note(`This route already has the maximum of ${max} waypoints.`, true);
			return false;
		}
		const name = waypointName(poi, Number(plan.waypointNameLength) || 16);
		let added = null;
		try { added = plan.addWaypoint(toPage([poi.lat, poi.lng]), name, false); } catch (e) {
			console.warn("[CustomTiles] Route POIs: addWaypoint failed", e);
		}
		if (!added) {
			this._note("dynamic.watch didn't accept the waypoint.", true);
			return false;
		}
		this._markAdded(poi);
		if (!quiet) this._note(`Added “${name}” as a waypoint — save the route to keep it.`);
		return true;
	}

	_waypointNear(poi) {
		const plan = this._plan();
		const waypoints = plan && Array.isArray(plan.waypoints) ? plan.waypoints : [];
		return waypoints.some((wp) => {
			const ll = wp && wp.marker && typeof wp.marker.getLatLng === "function" ? wp.marker.getLatLng() : null;
			return !!ll && haversine([ll.lng, ll.lat], [poi.lng, poi.lat]) < 15;
		});
	}

	_refreshAdded() {
		const next = new Set(this._pois.filter((poi) => this._waypointNear(poi)).map((poi) => poi.id));
		const changed = next.size !== this._added.size || [...next].some((id) => !this._added.has(id));
		this._added = next;
		return changed;
	}

	_syncAdded() {
		if (!this._refreshAdded()) return;
		for (const poi of this._pois) {
			const marker = this._markers.get(poi.id);
			if (marker) marker.setIcon(this._icon(poi));
		}
		// e.g. Undo removed the waypoint a note said was added.
		if (this._status.note && this._summary) this._status = { ...this._summary, note: false };
		this._renderPanel();
	}

	_markAdded(poi) {
		this._added.add(poi.id);
		const marker = this._markers.get(poi.id);
		if (marker) marker.setIcon(this._icon(poi));
		this._renderPanel();
	}

	_addAll() {
		this._refreshAdded();
		const pending = this._visiblePois().filter((poi) => !this._added.has(poi.id));
		if (!pending.length) { this._note("Every POI shown is already a waypoint."); return; }
		if (pending.length > CONFIRM_ADD_ALL_OVER &&
			!window.confirm(`Add ${pending.length} waypoints to this route?`)) return;
		let count = 0;
		this._status = { text: "", error: false, note: true };
		for (const poi of pending) {
			if (this._addWaypoint(poi, true)) count++;
			else if (this._status.error) return;
		}
		this._note(count
			? `Added ${count} waypoint${count === 1 ? "" : "s"} — save the route to keep them.`
			: "Those POIs already have waypoints.");
	}

	// -- Panel --------------------------------------------------------------

	_ensurePanel() {
		if (this._panel) return;
		const el = L.DomUtil.create("div", "dw-poi-panel", this._map.getContainer());
		L.DomEvent.disableClickPropagation(el);
		L.DomEvent.disableScrollPropagation(el);
		// Re-rendering detaches the clicked element, after which Leaflet can no
		// longer see it was inside the panel and would add a route point.
		el.addEventListener("click", (e) => {
			e.stopPropagation();
			this._onPanelClick(e);
		});
		el.addEventListener("change", (e) => this._onPanelChange(e));
		this._panel = el;
	}

	_renderPanel() {
		const el = this._panel;
		if (!el) return;
		const metric = this._metric();
		const counts = {};
		for (const poi of this._pois) counts[poi.category] = (counts[poi.category] || 0) + 1;
		const hidden = new Set(this._prefs.hidden);
		const chips = POI_CATEGORIES.filter((cat) => counts[cat.id]).map((cat) =>
			`<button type="button" class="dw-poi-chip${hidden.has(cat.id) ? " dw-poi-chip--off" : ""}"` +
			esc` data-poi-cat="${cat.id}" aria-pressed="${hidden.has(cat.id) ? "false" : "true"}">` +
			`<span class="dw-poi-dot" style="background:${cat.color}"></span>` +
			esc`${cat.label} <span class="dw-poi-count">${counts[cat.id]}</span></button>`).join("");
		const visible = this._visiblePois();
		const rows = visible.slice(0, LIST_LIMIT).map((poi) => {
			const cat = CATEGORY[poi.category];
			const added = this._added.has(poi.id);
			return esc`<li class="dw-poi-row" data-poi-row="${poi.id}">` +
				`<span class="dw-poi-dot" style="background:${cat.color}"></span>` +
				esc`<span class="dw-poi-name" title="${poiTypeLabel(poi)}">${poi.name || poiTypeLabel(poi)}</span>` +
				esc`<span class="dw-poi-km">${formatRouteDistance(poi.along, metric)}</span>` +
				esc`<button type="button" class="dw-poi-row-add" data-poi-add="${poi.id}"` +
				(added ? ' disabled title="Waypoint added">✓' : ' title="Add as waypoint">+') + `</button></li>`;
		}).join("");
		const more = visible.length > LIST_LIMIT
			? `<li class="dw-poi-more">+${visible.length - LIST_LIMIT} more on the map</li>` : "";
		const radiusOptions = POI_RADIUS_OPTIONS.map((r) =>
			`<option value="${r}"${r === this._prefs.radius ? " selected" : ""}>${_escHtml(formatOffset(r, metric))}</option>`).join("");
		const collapsed = el.classList.contains("dw-poi-panel--collapsed");
		const oldList = el.querySelector(".dw-poi-list");
		const scrollTop = oldList && !this._scrollReset ? oldList.scrollTop : 0;
		this._scrollReset = false;
		el.innerHTML =
			`<div class="dw-poi-hd"><b>POIs along route</b><span class="dw-poi-hd-btns">` +
			`<button type="button" data-poi-act="collapse" title="${collapsed ? "Expand" : "Collapse"}">${collapsed ? "+" : "–"}</button>` +
			`<button type="button" data-poi-act="close" title="Close and clear POIs">×</button></span></div>` +
			`<div class="dw-poi-body">` +
			esc`<div class="dw-poi-status${this._status.error ? " dw-poi-status--error" : ""}">${this._status.text}</div>` +
			this._gapHtml() +
			`<div class="dw-poi-opts"><label>Within <select data-poi-radius>${radiusOptions}</select></label>` +
			`<button type="button" data-poi-act="refresh"${this._state === "loading" ? " disabled" : ""}>Search again</button></div>` +
			(chips ? `<div class="dw-poi-chips">${chips}</div>` : "") +
			(rows ? `<ol class="dw-poi-list">${rows}${more}</ol>` : "") +
			(visible.length ? `<div class="dw-poi-ft"><button type="button" data-poi-act="add-all">Add shown as waypoints</button></div>` : "") +
			`<div class="dw-poi-attr">POI data © <a href="https://openmaptiles.org/" target="_blank" rel="noreferrer">OpenMapTiles</a> ` +
			`© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors, via ` +
			`<a href="https://openfreemap.org/" target="_blank" rel="noreferrer">OpenFreeMap</a></div>` +
			`</div>`;
		// Keep the list where the user left it when adding waypoints or filtering.
		const list = el.querySelector(".dw-poi-list");
		if (list && scrollTop) list.scrollTop = scrollTop;
	}

	_poiById(id) {
		return this._pois.find((poi) => poi.id === id) || null;
	}

	_onPanelClick(e) {
		const target = e.target && typeof e.target.closest === "function" ? e.target : null;
		if (!target) return;
		const act = target.closest("[data-poi-act]");
		if (act) {
			const action = act.dataset.poiAct;
			if (action === "close") this.clear();
			else if (action === "refresh") this.search();
			else if (action === "add-all") this._addAll();
			else if (action === "collapse") {
				this._panel.classList.toggle("dw-poi-panel--collapsed");
				this._renderPanel();
			}
			return;
		}
		const gap = target.closest("[data-poi-gap]");
		if (gap) {
			this._showGap(gap.dataset.poiGap);
			return;
		}
		const chip = target.closest("[data-poi-cat]");
		if (chip) {
			const id = chip.dataset.poiCat;
			const hidden = new Set(this._prefs.hidden);
			if (hidden.has(id)) hidden.delete(id);
			else hidden.add(id);
			this._prefs.hidden = [...hidden];
			this._savePrefs();
			this._renderMarkers();
			this._renderPanel();
			return;
		}
		const add = target.closest("[data-poi-add]");
		if (add) {
			const poi = this._poiById(add.dataset.poiAdd);
			if (poi) this._addWaypoint(poi);
			return;
		}
		const row = target.closest("[data-poi-row]");
		if (row) {
			const poi = this._poiById(row.dataset.poiRow);
			if (poi) this._focusPoi(poi);
		}
	}

	_onPanelChange(e) {
		const select = e.target && e.target.closest ? e.target.closest("[data-poi-radius]") : null;
		if (!select) return;
		const radius = Number(select.value);
		if (!POI_RADIUS_OPTIONS.includes(radius)) return;
		this._prefs.radius = radius;
		this._savePrefs();
		this.search();
	}
}
