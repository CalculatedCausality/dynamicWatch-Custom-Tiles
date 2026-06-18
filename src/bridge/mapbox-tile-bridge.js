import { gmGet } from "../utils/http.js";

export const _dwMbLayers = new Map();
let _dwMbNextId = 1;
let _dwMbHasProtocol = false;

export function hasDwMbProtocol() {
	return _dwMbHasProtocol;
}

export function setDwMbHasProtocol(value) {
	_dwMbHasProtocol = !!value;
}

export function dwRegisterMbLayer(lyr, fetchTile) {
	const key = "lyr" + (_dwMbNextId++);
	_dwMbLayers.set(key, fetchTile);
	lyr._dwMbKey = key;
	return key;
}

export function dwUnregisterMbLayer(lyr) {
	if (lyr && lyr._dwMbKey) {
		_dwMbLayers.delete(lyr._dwMbKey);
		lyr._dwMbKey = null;
	}
}

export function dwMbProtocolHandler(params) {
	const m = (params.url || "").match(/^dw:\/\/(\w+)\/(\d+)\/(\d+)\/(\d+)\b/);
	if (!m) return Promise.reject(new Error("dw://: bad url " + params.url));
	const [, key, z, x, y] = m;
	const fetchTile = _dwMbLayers.get(key);
	if (!fetchTile) return Promise.reject(new Error("dw://: no layer " + key));
	return Promise.resolve()
		.then(() => fetchTile(+z, +x, +y))
		.then((data) => ({ data }));
}

export function dwMbFetchAB(url) {
	return fetch(url, { credentials: "omit" }).then((r) => {
		if (!r.ok) throw new Error("HTTP " + r.status + " " + url);
		return r.arrayBuffer();
	});
}

export function dwMbGmFetchAB(url, opts) {
	return new Promise((resolve, reject) => {
		gmGet(url, { responseType: "arraybuffer", ...(opts || {}) }, (err, r) => {
			if (err) return reject(err);
			if (!r || r.status >= 400) return reject(new Error("HTTP " + (r?.status || "?") + " " + url));
			resolve(r.response);
		});
	});
}

export const DW_TILE_PREFIX = "https://dwtile.local/";
export const DW_TRANSPARENT_PNG =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

export function dwTileSentinel(key) {
	return `${DW_TILE_PREFIX}${key}/{z}/{x}/{y}.png`;
}

export const _dwTileBlobs    = new Map();
export const _dwTileInflight = new Set();
export const _dwTileFailed   = new Map();

const DW_TILE_FAIL_RETRY_MS = 60 * 1000;
const DW_TILE_BLOB_MAX = 600;

export function _dwTileFailedRecently(cacheKey) {
	const at = _dwTileFailed.get(cacheKey);
	return at != null && (Date.now() - at) < DW_TILE_FAIL_RETRY_MS;
}

export function _dwTileEvict() {
	while (_dwTileBlobs.size > DW_TILE_BLOB_MAX) {
		const first = _dwTileBlobs.keys().next().value;
		const url = _dwTileBlobs.get(first);
		_dwTileBlobs.delete(first);
		setTimeout(() => {
			try { URL.revokeObjectURL(url); } catch (_) {}
		}, 30 * 1000);
	}
}
