import { CFG } from "../config.js";
import { LayerProvider } from "../layers/provider-factories.js";
import { _escHtml, esc } from "../utils/html.js";
import { gmCancel, gmGet } from "../utils/http.js";

/* -- Old Railways ----------------------------------------------------------
 * Abandoned, disused, dismantled and razed railway lines from OpenStreetMap,
 * via the Overpass API: old branch lines, sugar-cane and timber tramways.
 * Many alignments are now roads or rail trails, which the hover says.
 * Overpass is slow and shared, so the map is fetched in zoom-10 squares
 * (about 40 km), one request at a time, and each square is kept in
 * userscript storage for 30 days (the lines don't change).
 */

const TILE_Z = 10;
const KEEP_MS = 30 * 864e5;
const KEEP_TILES = 60;

export function railTileBox(x, y) {
	const n = 2 ** TILE_Z;
	const lon = (i) => i / n * 360 - 180;
	const lat = (j) => Math.atan(Math.sinh(Math.PI * (1 - 2 * j / n))) * 180 / Math.PI;
	return { south: lat(y + 1), west: lon(x), north: lat(y), east: lon(x + 1) };
}

export function railTilesFor(bounds) {
	const n = 2 ** TILE_Z;
	const tx = (lon) => Math.floor((lon + 180) / 360 * n);
	const ty = (lat) => { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n); };
	const out = [];
	for (let x = tx(bounds.west); x <= tx(bounds.east); x++) for (let y = ty(bounds.north); y <= ty(bounds.south); y++) out.push([x, y]);
	return out;
}

export function railQuery(box) {
	const b = [box.south, box.west, box.north, box.east].map((v) => v.toFixed(5)).join(",");
	return `[out:json][timeout:60];(` +
		`way["railway"~"^(abandoned|disused|dismantled|razed)$"](${b});` +
		`way["abandoned:railway"](${b});way["disused:railway"](${b});` +
		`);out tags geom;`;
}

// Overpass answer → compact lines: name, status, what the alignment is now,
// and the geometry rounded to about 1 m.
export function parseRailways(data) {
	const out = [];
	for (const e of (data && Array.isArray(data.elements)) ? data.elements : []) {
		if (e.type !== "way" || !Array.isArray(e.geometry) || e.geometry.length < 2) continue;
		const t = e.tags || {};
		const status = /^(abandoned|disused|dismantled|razed)$/.test(t.railway) ? t.railway
			: t["disused:railway"] ? "disused" : "abandoned";
		out.push({
			n: String(t.name || t["railway:name"] || "").slice(0, 80),
			s: status,
			h: String(t.highway || ""),
			o: String(t.operator || t["was:operator"] || "").slice(0, 60),
			g: e.geometry.map((p) => [Number(p.lat.toFixed(5)), Number(p.lon.toFixed(5))]),
		});
	}
	return out;
}

const NOW = { path: "now a path", footway: "now a path", cycleway: "now a cycle path", track: "now a track",
	bridleway: "now a bridle trail" };

export function _formatOldRailway(r) {
	const now = r.h ? (NOW[r.h] || "now a road") : "";
	const what = r.s === "disused" ? "Disused railway" : r.s === "razed" ? "Railway, removed" : "Old railway line";
	const lines = [esc`<b>${r.n || what}</b>`];
	lines.push(_escHtml([r.n ? what : "", now].filter(Boolean).join(" · ") || what));
	if (r.o) lines.push(esc`<span class="dw-cad-sub">${r.o}</span>`);
	return lines.join("<br>");
}

function loadCache() {
	try { const c = JSON.parse(GM_getValue(CFG.OLD_RAIL_CACHE_KEY, "{}")); return c && typeof c === "object" ? c : {}; }
	catch (_) { return {}; }
}
function saveCache(cache) {
	const keys = Object.keys(cache).sort((a, b) => cache[b].t - cache[a].t).slice(0, KEEP_TILES);
	try { GM_setValue(CFG.OLD_RAIL_CACHE_KEY, JSON.stringify(Object.fromEntries(keys.map((k) => [k, cache[k]])))); } catch (_) {}
}

export class OldRailwaysLayerProvider extends LayerProvider {
	create() {
		const PANE = "dwOldRailPane";
		const Layer = L.Layer.extend({
			onAdd(map) {
				if (!map.getPane(PANE)) { map.createPane(PANE); map.getPane(PANE).style.zIndex = "411"; }
				this._group = L.layerGroup().addTo(map);
				this._cache = loadCache();
				this._drawn = new Set();
				this._queue = [];
				this._tries = {};
				this._busy = null;
				map.on("moveend", this._update, this);
				this._update();
			},
			onRemove(map) {
				map.off("moveend", this._update, this);
				if (this._busy) { gmCancel(this._busy); this._busy = null; }
				this._queue = [];
				clearTimeout(this._retryTimer);
				this._note(false);
				if (this._group) { this._group.remove(); this._group = null; }
			},
			_note(on, text) {
				const box = this._map && this._map.getContainer();
				if (!on) { if (this._noteEl) { this._noteEl.remove(); this._noteEl = null; } return; }
				if (!this._noteEl && box) this._noteEl = L.DomUtil.create("div", "dw-at-note", box);
				if (this._noteEl) this._noteEl.textContent = text ||
					"Loading old railways from OpenStreetMap… (slow the first time; kept for a month)";
			},
			_update() {
				const map = this._map;
				if (!map || map.getZoom() < CFG.OLD_RAIL_MIN_ZOOM) { this._group && this._group.clearLayers(); this._drawn.clear(); return; }
				const b = map.getBounds();
				const want = railTilesFor({ west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() });
				const now = Date.now();
				for (const [x, y] of want) {
					const k = `${x}/${y}`;
					const hit = this._cache[k];
					if (hit && now - hit.t < KEEP_MS) this._draw(k, hit.r);
					else if (!this._queue.includes(k)) this._queue.push(k);
				}
				this._next();
			},
			_next() {
				if (this._busy || this._retryTimer || !this._queue.length || !this._map) {
					if (!this._busy && !this._retryTimer) this._note(false);
					return;
				}
				const k = this._queue.shift();
				const [x, y] = k.split("/").map(Number);
				this._note(true);
				this._busy = gmGet(CFG.OVERPASS_URL, {
					method: "POST", timeout: 90000,
					// Overpass refuses unidentified browser requests (406); it accepts
					// them with the page they come from.
					headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: "https://dynamic.watch/" },
					data: "data=" + encodeURIComponent(railQuery(railTileBox(x, y))),
				}, (err, r) => {
					this._busy = null;
					if (!this._map) return;
					let ok = false;
					if (!err && r && r.status === 200) {
						try {
							const rails = parseRailways(JSON.parse(r.responseText));
							this._cache[k] = { t: Date.now(), r: rails };
							saveCache(this._cache);
							this._draw(k, rails);
							ok = true;
						} catch (_) { /* treated as a failed square below */ }
					}
					if (!ok) {
						// Overpass is shared and often busy: try the square again after
						// 30, 60 and 90 s, then leave it until the map is next moved.
						const n = (this._tries[k] = (this._tries[k] || 0) + 1);
						if (n <= 3) {
							this._queue.unshift(k);
							this._note(true, `OpenStreetMap is busy; trying the old railways again in ${30 * n} s…`);
							this._retryTimer = setTimeout(() => { this._retryTimer = null; this._next(); }, 30000 * n);
							return;
						}
						delete this._tries[k];
						this._note(true, "Couldn't load old railways from OpenStreetMap; move the map to try again.");
						setTimeout(() => { if (!this._busy && !this._retryTimer) this._note(false); }, 8000);
						// Keep the message up unless other squares are still waiting.
						if (!this._queue.length) return;
					}
					this._next();
				});
			},
			_draw(k, rails) {
				if (this._drawn.has(k) || !this._group) return;
				this._drawn.add(k);
				for (const r of rails) {
					L.polyline(r.g, { pane: PANE, color: "#fff", weight: 6, opacity: 0.7, interactive: false }).addTo(this._group);
					L.polyline(r.g, { pane: PANE, color: r.s === "disused" ? "#57534e" : "#7c2d12", weight: 3, opacity: 0.95, dashArray: "8 4" })
						.bindTooltip(_formatOldRailway(r), { className: "dw-abw-tip", sticky: true })
						.addTo(this._group);
				}
			},
			getAttribution() {
				return 'Old railways &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors';
			},
		});
		return new Layer();
	}
}
