import { CFG } from "../config.js";
import { gmCancel, gmGet } from "../utils/http.js";

/* -- Elevation along the route -------------------------------------------
 * Samples the public AWS Terrain Tiles (Terrarium PNG encoding, keyless) at
 * z12, about 35 m per pixel in Queensland: enough for pacing estimates,
 * not survey-grade. Decoded tiles are kept in a small in-memory cache.
 */

const TILE = 256;
const _tiles = new Map();
const TILE_CACHE_MAX = 48;

// Terrarium: metres = R * 256 + G + B / 256 - 32768.
export function decodeTerrarium(rgba) {
	const out = new Float32Array(rgba.length / 4);
	for (let i = 0, p = 0; i < out.length; i++, p += 4) {
		out[i] = rgba[p] * 256 + rgba[p + 1] + rgba[p + 2] / 256 - 32768;
	}
	return out;
}

// Fractional tile coordinates of a point at zoom z.
export function tilePosition(lng, lat, z) {
	const n = 2 ** z;
	const r = Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI / 180;
	return [(lng + 180) / 360 * n, (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n];
}

// Bilinear sample of a decoded tile at pixel-space (px, py).
export function sampleTile(heights, px, py) {
	const x = Math.max(0, Math.min(TILE - 1.001, px - 0.5));
	const y = Math.max(0, Math.min(TILE - 1.001, py - 0.5));
	const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
	const at = (cx, cy) => heights[cy * TILE + cx];
	const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
	const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
	return top * (1 - fy) + bottom * fy;
}

// PNG bytes → RGBA via the browser's image decoder (OffscreenCanvas when
// available). Bytes from GM_xmlhttpRequest never taint the canvas.
async function decodePng(buffer) {
	const bitmap = await createImageBitmap(new Blob([buffer], { type: "image/png" }));
	const canvas = typeof OffscreenCanvas === "function"
		? new OffscreenCanvas(TILE, TILE)
		: Object.assign(document.createElement("canvas"), { width: TILE, height: TILE });
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	ctx.drawImage(bitmap, 0, 0);
	if (bitmap.close) bitmap.close();
	return ctx.getImageData(0, 0, TILE, TILE).data;
}

function gmFetchTile(url, cb) {
	const handle = gmGet(url, { responseType: "arraybuffer", timeout: 20000 }, (err, r) => {
		if (err || !r || r.status !== 200 || !r.response) cb(err || new Error("HTTP " + (r && r.status)));
		else cb(null, r.response);
	});
	return { abort: () => gmCancel(handle) };
}

function cacheTile(key, heights) {
	_tiles.delete(key);
	_tiles.set(key, heights);
	while (_tiles.size > TILE_CACHE_MAX) _tiles.delete(_tiles.keys().next().value);
}

// Elevation (metres) for every sample, or an error when too many tiles fail.
// Samples in a tile that fails get NaN; the timing model skips those steps.
export function fetchRouteElevations(samples, opts, cb) {
	opts = opts || {};
	const z = opts.zoom || CFG.ROUTE_ELEVATION_ZOOM;
	const fetchTile = opts.fetchTile || gmFetchTile;
	const decode = opts.decode || ((buffer) => decodePng(buffer).then(decodeTerrarium));
	const byTile = new Map();
	samples.forEach((s, i) => {
		const [fx, fy] = tilePosition(s.lng, s.lat, z);
		const key = z + "/" + Math.floor(fx) + "/" + Math.floor(fy);
		if (!byTile.has(key)) byTile.set(key, []);
		byTile.get(key).push([i, (fx - Math.floor(fx)) * TILE, (fy - Math.floor(fy)) * TILE]);
	});
	if (byTile.size > CFG.ROUTE_ELEVATION_MAX_TILES) {
		cb(new Error("too many elevation tiles"));
		return { cancel() {} };
	}
	const values = new Float64Array(samples.length).fill(NaN);
	const keys = [...byTile.keys()];
	const inflight = new Set();
	let next = 0, done = 0, failed = 0, cancelled = false;
	const fill = (key, heights) => {
		for (const [i, px, py] of byTile.get(key)) values[i] = sampleTile(heights, px, py);
	};
	const finish = () => {
		if (cancelled || done < keys.length) return;
		cancelled = true;
		if (failed > keys.length / 2) cb(new Error("elevation tiles unavailable"));
		else cb(null, values);
	};
	const pump = () => {
		while (!cancelled && inflight.size < 4 && next < keys.length) {
			const key = keys[next++];
			const cached = _tiles.get(key);
			if (cached) { fill(key, cached); done++; continue; }
			const [tz, tx, ty] = key.split("/");
			const url = CFG.ROUTE_ELEVATION_TILE.replace("{z}", tz).replace("{x}", tx).replace("{y}", ty);
			const slot = {};
			inflight.add(slot);
			slot.request = fetchTile(url, (err, buffer) => {
				inflight.delete(slot);
				if (cancelled) return;
				const settle = (heights) => {
					if (cancelled) return;
					if (heights && heights.length === TILE * TILE) { cacheTile(key, heights); fill(key, heights); }
					else failed++;
					done++;
					pump();
				};
				if (err || !buffer) { settle(null); return; }
				Promise.resolve().then(() => decode(buffer)).then(settle, () => settle(null));
			});
		}
		finish();
	};
	pump();
	return {
		cancel() {
			cancelled = true;
			for (const slot of inflight) { try { slot.request && slot.request.abort(); } catch (_) {} }
			inflight.clear();
		},
	};
}
