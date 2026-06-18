import { gmCancel, gmGet } from "../utils/http.js";
import { decodeGeometry, mvtDecode } from "../utils/mvt.js";

// Vector-tile overlay: fetches visible MVT tiles, decodes them, projects each
// feature into lat/lon, and passes OSM/Overpass-shaped elements to opts.render.
export function makeVectorTileLayer(opts) {
	const debounceMs = opts.debounceMs || 400;
	const timeoutMs = opts.timeoutMs || 20000;
	const padBounds = opts.padBounds || 0;
	const maxNativeZoom = opts.maxNativeZoom || 16;
	const maxTiles = opts.maxTiles || 60;

	const Layer = L.Layer.extend({
		initialize() {
			this._group = null;
			this._debounce = null;
			this._lastKey = null;
			this._gen = 0;
			this._handles = [];
			this._tileEls = new Map();
		},

		onAdd(map) {
			if (!map.getPane(opts.pane)) {
				map.createPane(opts.pane);
				map.getPane(opts.pane).style.zIndex = String(opts.paneZIndex);
			}
			this._group = L.layerGroup().addTo(map);
			this._fetch();
			map.on("moveend zoomend", this._onViewChange, this);
		},

		onRemove(map) {
			clearTimeout(this._debounce);
			this._debounce = null;
			this._gen++;
			this._cancel();
			map.off("moveend zoomend", this._onViewChange, this);
			if (this._group) { this._group.remove(); this._group = null; }
			this._tileEls.clear();
		},

		_cacheTile(tk, els) {
			const TILE_EL_MAX = 256;
			this._tileEls.set(tk, els);
			if (this._tileEls.size > TILE_EL_MAX) {
				const oldest = this._tileEls.keys().next().value;
				this._tileEls.delete(oldest);
			}
		},

		_onViewChange() {
			clearTimeout(this._debounce);
			this._debounce = setTimeout(() => this._fetch(), debounceMs);
		},

		_cancel() {
			for (const h of this._handles) gmCancel(h);
			this._handles = [];
		},

		_fetch() {
			const map = this._map;
			if (!map || !this._group) return;
			const vz = map.getZoom();
			if (vz < opts.minZoom) {
				this._group.clearLayers();
				this._lastKey = null;
				this._cancel();
				return;
			}

			const tz = Math.min(Math.floor(vz), maxNativeZoom);
			const n = Math.pow(2, tz);
			const b = padBounds ? map.getBounds().pad(padBounds) : map.getBounds();
			const lon2t = (lon) => Math.floor((lon + 180) / 360 * n);
			const lat2t = (lat) => {
				const r = lat * Math.PI / 180;
				return Math.floor(
					(1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n);
			};
			const x0 = Math.max(0, lon2t(b.getWest()));
			const x1 = Math.min(n - 1, lon2t(b.getEast()));
			const y0 = Math.max(0, lat2t(b.getNorth()));
			const y1 = Math.min(n - 1, lat2t(b.getSouth()));

			const key = `${tz}:${x0},${y0},${x1},${y1}`;
			if (key === this._lastKey) return;
			this._lastKey = key;

			const coords = [];
			for (let x = x0; x <= x1; x++)
				for (let y = y0; y <= y1; y++) coords.push([x, y]);
			if (coords.length > maxTiles) {
				console.warn(`[CustomTiles] ${opts.label}: ${coords.length} ` +
					`tiles exceeds cap ${maxTiles}, skipping`);
				return;
			}

			const myGen = ++this._gen;
			this._cancel();

			const need = [];
			for (const [x, y] of coords) {
				const tk = `${tz}/${x}/${y}`;
				if (!this._tileEls.has(tk)) need.push([x, y, tk]);
			}
			let pending = need.length;
			let failedAny = false;

			const finish = () => {
				if (myGen !== this._gen || !this._group) return;
				const elements = [];
				for (const [x, y] of coords) {
					const arr = this._tileEls.get(`${tz}/${x}/${y}`);
					if (arr) for (const e of arr) elements.push(e);
				}
				const wayIds = new Set();
				for (const el of elements)
					if (el.type === "way" && el._id) wayIds.add(el._id);
				const seenNode = new Set();
				const out = elements.filter((el) => {
					if (el.type === "node" && el._id) {
						if (wayIds.has(el._id) || seenNode.has(el._id)) return false;
						seenNode.add(el._id);
					}
					return true;
				});
				this._group.clearLayers();
				opts.render(this._group, out, tz);
				if (failedAny) this._lastKey = null;
			};

			if (!pending) { finish(); return; }

			for (const [x, y, tk] of need) {
				const h = gmGet(opts.tileUrl(tz, x, y),
					{ responseType: "arraybuffer", timeout: timeoutMs },
					(err, r) => {
						if (myGen !== this._gen || !this._group) {
							if (--pending === 0) finish();
							return;
						}
						if (!err && r && r.status === 200 && r.response) {
							const tileEls = [];
							try {
								const layers = mvtDecode(r.response);
								for (const layer of layers) {
									const ext = layer.extent || 4096;
									for (const f of layer.features) {
										const props = {};
										for (let i = 0; i < f.tags.length; i += 2)
											props[layer.keys[f.tags[i]]] =
												layer.values[f.tags[i + 1]];
										const rings = decodeGeometry(f.geom).map((ring) =>
											ring.map((p) => ({
												lon: (x + p[0] / ext) / n * 360 - 180,
												lat: Math.atan(Math.sinh(Math.PI *
													(1 - 2 * (y + p[1] / ext) / n))) *
													180 / Math.PI,
											})));
										const els =
											opts.toElements(layer.name, props, f.type, rings);
										if (els) for (const e of els) tileEls.push(e);
									}
								}
								this._cacheTile(tk, tileEls);
							} catch (e) { failedAny = true; }
						} else {
							failedAny = true;
						}
						if (--pending === 0) finish();
					});
				this._handles.push(h);
			}
		},

		getAttribution() { return opts.attribution; },
	});

	return new Layer();
}
