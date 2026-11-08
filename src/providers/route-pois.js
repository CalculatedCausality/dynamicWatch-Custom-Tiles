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
import {
	abbreviate, climbLabel, climbTopLabel, creekCrossings, findClimbs, trackSections,
} from "../utils/route-features.js";
import { resampleRoute } from "../utils/route-profile.js";
import { fetchRouteElevations } from "./route-elevation.js";

/* -- POIs along the planned route ---------------------------------------
 * The planner-toolbar button reads dynamic.watch's route, loads the z14
 * OpenMapTiles vector tiles (OpenFreeMap: keyless, CDN-cached) covering a
 * corridor around it, and pins useful stops — water, toilets, food, shops,
 * views, shelter — with their distance along the route. The same tiles and
 * an elevation profile give course features on the route itself (climbs,
 * creek crossings, named track sections). Each can be added to the plan as a
 * named waypoint, which dynamic.watch exports to the watch's Up Ahead list
 * once the route is saved.
 */

export const POI_CATEGORIES = [
	{ id: "climb", label: "Climbs", icon: "fa-line-chart", color: "#d84315", types: ["climb"] },
	{ id: "climbtop", label: "Climb tops", icon: "fa-flag", color: "#6a1b9a", types: ["climb_top"] },
	{ id: "creek", label: "Creek crossings", glyph: "≈", color: "#0277bd", types: ["creek_crossing"] },
	{ id: "track", label: "Track sections", icon: "fa-road", color: "#6d4c41", types: ["track_section"] },
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
	{ id: "parking", label: "Car parks & picnic", glyph: "P", color: "#546e7a",
		types: ["parking", "picnic_site"] },
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
	bicycle: "Bike shop", parking: "Car park", picnic_site: "Picnic area",
	climb: "Climb", climb_top: "Top of climb", creek_crossing: "Creek crossing",
	track_section: "Track or road",
};
const TYPE_GLYPHS = { peak: "▲", volcano: "▲" };
const COURSE_TYPES = new Set(["climb", "climb_top", "creek_crossing", "track_section"]);
// OpenMapTiles transportation classes in plain words.
const TRACK_KINDS = {
	path: "path", track: "track", minor: "road", service: "road", tertiary: "road",
	secondary: "main road", primary: "main road", trunk: "highway", motorway: "motorway",
};

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

const LINE_WATERWAYS = new Set(["river", "stream", "canal"]);

// Decode one z/x/y vector tile into category POIs, bus-stop positions (used
// to drop the many bus shelters tagged amenity=shelter), and waterway and
// named road lines. Lines stay in tile pixels (Int16) so the tile cache stays
// small; tileLines() turns them into [lng, lat].
export function decodePoiTile(buffer, z, x, y) {
	const n = 2 ** z;
	const pois = [], busStops = [], lines = [];
	for (const layer of mvtDecode(buffer)) {
		const water = layer.name === "waterway", road = layer.name === "transportation_name";
		if (layer.name !== "poi" && layer.name !== "mountain_peak" && !water && !road) continue;
		const ext = layer.extent || 4096;
		for (const f of layer.features) {
			const props = {};
			for (let i = 0; i + 1 < f.tags.length; i += 2) {
				props[layer.keys[f.tags[i]]] = layer.values[f.tags[i + 1]];
			}
			if (water || road) {
				const name = cleanName(props.name);
				if (f.type !== 2 || (water && !LINE_WATERWAYS.has(String(props.class))) || (road && !name)) continue;
				for (const line of decodeGeometry(f.geom)) {
					if (line.length > 1) lines.push({ kind: water ? "water" : "road", name, cls: String(props.class || ""), ext, xy: Int16Array.from(line.flat()) });
				}
				continue;
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
	return { pois, busStops, lines, z, x, y };
}

export function tileLines(tile) {
	const n = 2 ** tile.z;
	return (tile.lines || []).map(({ kind, name, cls, ext, xy }) => {
		const line = [];
		for (let i = 0; i + 1 < xy.length; i += 2) {
			line.push([(tile.x + xy[i] / ext) / n * 360 - 180,
				Math.atan(Math.sinh(Math.PI * (1 - 2 * (tile.y + xy[i + 1] / ext) / n))) * 180 / Math.PI]);
		}
		return { kind, name, cls, line };
	});
}

// Course features as list items shaped like POIs (on the route: offset 0).
export function courseFeatures({ route, samples, elevations, lines, metric = true }) {
	const items = [];
	const id = (type, lng, lat) => type + ":" + lat.toFixed(5) + "," + lng.toFixed(5);
	const item = (type, category, at, name, passes, extra) => ({
		id: id(type, at.lng, at.lat), category, type, name, ele: null, lng: at.lng, lat: at.lat,
		passes: passes.map((along) => ({ along, offset: 0 })), along: passes[0], offset: 0, ...extra,
	});
	for (const c of creekCrossings(route, lines.filter((l) => l.kind === "water"))) {
		items.push(item("creek_crossing", "creek", c, c.name, c.passes, { cls: c.cls }));
	}
	for (const t of trackSections(samples, lines.filter((l) => l.kind === "road"))) {
		items.push(item("track_section", "track", t, t.name, [t.along], { cls: t.cls, until: t.to }));
	}
	for (const c of findClimbs(samples, elevations)) {
		const base = samples[c.startIndex], top = samples[c.endIndex];
		items.push(item("climb", "climb", base, climbLabel(c, metric), [c.from], { climb: c, ele: Math.round(c.base) }));
		items.push(item("climb_top", "climbtop", top, climbTopLabel(c, metric), [c.to], { climb: c, ele: Math.round(c.top) }));
	}
	return items;
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
	return waypointLabel(poi, { mode: "name", maxLength });
}

// How POI waypoints are named. dynamic.watch syncs only a waypoint's location
// and name, so the distance has to travel inside the name.
export const NAME_MODES = [
	{ id: "name", label: "Name only" },
	{ id: "km", label: "Distance + name" },
];

export function waypointLabel(poi, { mode = "name", along = poi.along, metric = true, maxLength = 16 } = {}) {
	const max = Math.max(1, maxLength);
	let prefix = "";
	if (mode === "km" && Number.isFinite(along)) {
		const d = along / (metric ? 1000 : 1609.344);
		prefix = (d < 10 ? d.toFixed(1) : String(Math.round(d))) + (metric ? "k" : "mi") + " ";
	}
	const room = Math.max(1, max - prefix.length);
	let base;
	if (poi.climb && poi.type === "climb") base = climbLabel(poi.climb, metric, room);
	else if (poi.climb && poi.type === "climb_top") base = climbTopLabel(poi.climb, metric, room);
	else base = (poi.name || poiTypeLabel(poi)).replace(/\s+/g, " ").trim();
	if (base.length > room) base = abbreviate(base);
	return (prefix + base.slice(0, room)).slice(0, max).trim();
}

// Up Ahead shows only the next few entries, so several waypoints at one spot
// waste them. When adding in bulk, each stretch of `windowM` metres along the
// route gets only its most useful item, and none if it already has a waypoint
// from the list (`taken`).
const CATEGORY_PRIORITY = {
	water: 0, toilets: 1, food: 2, shop: 2, medical: 3, climb: 4, climbtop: 4, creek: 5, track: 6,
	views: 7, shelter: 7, bike: 7,
};
const TYPE_PRIORITY = { picnic_site: 8, parking: 9 };

export function waypointPriority(poi) {
	return TYPE_PRIORITY[poi.type] ?? CATEGORY_PRIORITY[poi.category] ?? 7;
}

export function thinClusters(candidates, taken = [], windowM = 100) {
	const all = candidates.map((poi) => ({ poi, taken: false }))
		.concat(taken.map((poi) => ({ poi, taken: true })))
		.sort((a, b) => a.poi.along - b.poi.along);
	const keep = [];
	for (let i = 0; i < all.length;) {
		let j = i;
		while (j + 1 < all.length && all[j + 1].poi.along - all[i].poi.along <= windowM) j++;
		const group = all.slice(i, j + 1);
		if (!group.some((g) => g.taken)) {
			keep.push(group.reduce((best, g) => (waypointPriority(g.poi) < waypointPriority(best.poi) ? g : best)).poi);
		}
		i = j + 1;
	}
	return keep;
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

// Route paths ([lng, lat] arrays per planner segment) → POIs and course
// features along the route. Map tiles and the elevation profile load in
// parallel; without elevations the search still succeeds, minus climbs.
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
	const samples = resampleRoute(route);
	let cancelled = false, inner = null, elevationJob = null, tileResult = null, elevation = null;
	const stop = () => {
		cancelled = true;
		if (inner) inner.cancel();
		if (elevationJob && elevationJob.cancel) elevationJob.cancel();
	};
	const fail = (error) => { if (!cancelled) { stop(); cb(error); } };
	const finish = () => {
		if (cancelled || !tileResult || !elevation) return;
		cancelled = true;
		const lines = tileResult.tiles.flatMap(tileLines);
		const features = courseFeatures({ route, samples, elevations: elevation.values, lines, metric: opts.metric !== false });
		const pois = selectRoutePois(tileResult.tiles, route, radius).concat(features)
			.sort((a, b) => a.along - b.along || a.offset - b.offset);
		cb(null, {
			pois, route, samples, elevations: elevation.values, elevationError: elevation.err || null,
			tileCount: tiles.length, failedTiles: tileResult.failed,
		});
	};
	const fetchElevations = opts.fetchElevations || ((points, done) => fetchRouteElevations(points, {}, done));
	try {
		elevationJob = fetchElevations(samples, (err, values) => {
			elevation = { err: err || null, values: err ? null : values };
			finish();
		});
	} catch (e) {
		elevation = { err: e, values: null };
	}
	(opts.resolveTemplate || resolveTileTemplate)((err, template) => {
		if (cancelled) return;
		if (err || !template) {
			fail(poiError("tiles", "Couldn't reach the OpenFreeMap map-data index. Try again shortly."));
			return;
		}
		inner = loadPoiTiles(tiles, {
			template, z, fetchTile: opts.fetchTile, onProgress: opts.onProgress,
		}, (_err, result) => {
			if (cancelled) return;
			if (tiles.length && result.failed === tiles.length) {
				fail(poiError("tiles", "Couldn't load map data for this route. Try again shortly."));
				return;
			}
			tileResult = result;
			finish();
		});
	});
	return { cancel: stop };
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
	// 7.15's "distance + time" names fall back to distance only.
	const nameMode = prefs.nameMode === "km-time" ? "km" : prefs.nameMode;
	return {
		radius: POI_RADIUS_OPTIONS.includes(radius) ? radius : 100,
		hidden: Array.isArray(prefs.hidden) ? prefs.hidden.filter((id) => CATEGORY[id]) : [],
		nameMode: NAME_MODES.some((m) => m.id === nameMode) ? nameMode : "name",
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
		this._hasElevation = false;
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
			metric: this._metric(),
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
			this._hasElevation = !err && !!result.elevations;
			if (err) {
				this._summary = { text: err.message, error: true };
				this._setStatus(err.message, true);
				return;
			}
			const metric = this._metric();
			const course = this._pois.filter((poi) => COURSE_TYPES.has(poi.type)).length;
			const nearby = this._pois.length - course;
			const found = nearby ? `${nearby} POI${nearby === 1 ? "" : "s"}` : "No POIs";
			const failed = (result.failedTiles
				? ` · ${result.failedTiles} of ${result.tileCount} map tiles didn't load` : "") +
				(result.elevationError ? " · no climbs (elevation data didn't load)" : "");
			this._summary = {
				text: `${found} within ${formatOffset(this._prefs.radius, metric)} of the ` +
					`${formatRouteDistance(result.route.total, metric)} route` +
					(course ? ` · ${course} course point${course === 1 ? "" : "s"}` : "") + failed,
				error: !!(result.failedTiles || result.elevationError),
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
		this._hasElevation = false;
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

	// Extra popup lines for climbs and track sections.
	_featureHtml(poi) {
		const metric = this._metric();
		const c = poi.climb;
		if (c) {
			const dist = formatRouteDistance(c.length, metric);
			const pct = (g) => Math.round(g * 100) + "%";
			const line = esc`↑ ${formatOffset(c.gain, metric)} over ${dist} · average ${pct(c.grade)} · steepest ${pct(c.steepest)}`;
			const span = poi.type === "climb_top"
				? esc`From ${formatRouteDistance(c.from, metric)} (${formatOffset(c.base, metric)})`
				: esc`Top at ${formatRouteDistance(c.to, metric)} (${formatOffset(c.top, metric)})`;
			return `<div>${line}</div><div>${span}</div>`;
		}
		if (poi.type === "track_section" && poi.until != null) {
			const kind = TRACK_KINDS[poi.cls] || "";
			return esc`<div>Until about ${formatRouteDistance(poi.until, metric)}${kind ? " · " + kind : ""}</div>`;
		}
		return "";
	}

	_popupHtml(poi) {
		const label = poiTypeLabel(poi);
		const metric = this._metric();
		const ele = poi.ele != null ? ` · ${formatOffset(poi.ele, metric)}` : "";
		const added = this._added.has(poi.id);
		const maps = "https://www.google.com/maps/search/?api=1&query=" +
			poi.lat.toFixed(6) + "," + poi.lng.toFixed(6);
		const onRoute = COURSE_TYPES.has(poi.type);
		return `<div class="dw-poi-pop">` +
			esc`<b>${poi.name || label}</b>` +
			esc`<div class="dw-poi-pop-sub">${label}${ele}</div>` +
			this._featureHtml(poi) +
			esc`<div>At ${this._passesText(poi)}${onRoute ? "" : ` · ${formatOffset(poi.offset, metric)} off route`}</div>` +
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
		const zoom = Math.max(this._map.getZoom(), 16);
		// Centre the POI in the map beside the panel. Without animation, so the
		// popup's auto-pan can't cut the move short and leave it under the panel.
		const panel = this._panel && !this._panel.classList.contains("dw-poi-panel--collapsed") ? this._panel : null;
		const shift = panel ? (panel.offsetWidth + 12) / 2 : 0;
		const centre = this._map.unproject(this._map.project([poi.lat, poi.lng], zoom).subtract([shift, 0]), zoom);
		this._map.setView(centre, zoom, { animate: false });
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
		const name = waypointLabel(poi, {
			mode: this._prefs.nameMode, metric: this._metric(),
			maxLength: Number(plan.waypointNameLength) || 16,
		});
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
		const chosen = thinClusters(pending, this._pois.filter((poi) => this._added.has(poi.id)));
		const left = pending.length - chosen.length;
		if (!chosen.length) { this._note("Every stretch shown already has a waypoint."); return; }
		if (chosen.length > CONFIRM_ADD_ALL_OVER &&
			!window.confirm(`Add ${chosen.length} waypoints to this route?`)) return;
		let count = 0;
		this._status = { text: "", error: false, note: true };
		for (const poi of chosen) {
			if (this._addWaypoint(poi, true)) count++;
			else if (this._status.error) return;
		}
		const skipped = left ? ` (${left} next to a more useful one left out)` : "";
		this._note(count
			? `Added ${count} waypoint${count === 1 ? "" : "s"}${skipped} — save the route to keep them.`
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
		// The panel lives inside the map container: keep typing from panning or
		// zooming the map and from reaching dynamic.watch's shortcuts.
		const isField = (t) => t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.nodeName);
		for (const type of ["keydown", "keypress", "keyup"]) {
			el.addEventListener(type, (e) => { if (isField(e.target)) e.stopPropagation(); });
		}
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
		const nameOptions = NAME_MODES.map((m) =>
			`<option value="${m.id}"${m.id === this._prefs.nameMode ? " selected" : ""}>${_escHtml(m.label)}</option>`).join("");
		el.innerHTML =
			`<div class="dw-poi-hd"><b>POIs along route</b><span class="dw-poi-hd-btns">` +
			`<button type="button" data-poi-act="collapse" title="${collapsed ? "Expand" : "Collapse"}">${collapsed ? "+" : "–"}</button>` +
			`<button type="button" data-poi-act="close" title="Close and clear POIs">×</button></span></div>` +
			`<div class="dw-poi-body">` +
			esc`<div class="dw-poi-status${this._status.error ? " dw-poi-status--error" : ""}">${this._status.text}</div>` +
			this._gapHtml() +
			`<div class="dw-poi-opts"><label>Within <select data-poi-radius>${radiusOptions}</select></label>` +
			`<button type="button" data-poi-act="refresh"${this._state === "loading" ? " disabled" : ""}>Search again</button></div>` +
			`<div class="dw-poi-opts"><label title="Waypoint names are all that reach the watch">Waypoint names ` +
			`<select data-poi-names>${nameOptions}</select></label></div>` +
			(chips ? `<div class="dw-poi-chips">${chips}</div>` : "") +
			(rows ? `<ol class="dw-poi-list">${rows}${more}</ol>` : "") +
			(visible.length ? `<div class="dw-poi-ft"><button type="button" data-poi-act="add-all">Add shown as waypoints</button></div>` : "") +
			`<div class="dw-poi-attr">POI data © <a href="https://openmaptiles.org/" target="_blank" rel="noreferrer">OpenMapTiles</a> ` +
			`© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors, via ` +
			`<a href="https://openfreemap.org/" target="_blank" rel="noreferrer">OpenFreeMap</a>` +
			(this._state === "active" && this._hasElevation
				? ` · Elevation <a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noreferrer">AWS Terrain Tiles</a>` : "") +
			`</div></div>`;
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
		const names = e.target && e.target.closest ? e.target.closest("[data-poi-names]") : null;
		if (names) {
			if (NAME_MODES.some((m) => m.id === names.value)) {
				this._prefs.nameMode = names.value;
				this._savePrefs();
			}
			return;
		}
		const select = e.target && e.target.closest ? e.target.closest("[data-poi-radius]") : null;
		if (!select) return;
		const radius = Number(select.value);
		if (!POI_RADIUS_OPTIONS.includes(radius)) return;
		this._prefs.radius = radius;
		this._savePrefs();
		this.search();
	}
}
