import { dwRegisterMbLayer } from "../bridge/mapbox-tile-bridge.js";
import { CFG } from "../config.js";
import { LayerProvider } from "../layers/provider-factories.js";
import { gmGet } from "../utils/http.js";

const FILENAME_MASK1 = "olhwjsktri";
const FILENAME_MASK2 = "eizxdwknmo";
const FOW_MAP_WIDTH = 512;
const FOW_TILE_WIDTH = 8192;
const FOW_BLOCKS = 128;
const FOW_BLOCK_WIDTH = 64;
const FOW_HEADER_SIZE = FOW_BLOCKS * FOW_BLOCKS * 2;
const FOW_BITMAP_SIZE = 512;
const FOW_BLOCK_SIZE = 515;
const FOW_NATIVE_ZOOM = 22;
const FOW_CHUNK_ZOOM = 9;
const CACHE_LIMIT = 16;
const CACHE_TTL = 5 * 60 * 1000;

// Fog of World uses the first four MD5 hex characters of the decimal tile
// id as a filename prefix. Tile ids are at most six ASCII digits, so one MD5
// block is sufficient and avoids bundling a general-purpose crypto library.
function md5ShortAscii(value) {
	const bytes = Array.from(String(value), (char) => char.charCodeAt(0));
	const words = new Int32Array(16);
	for (let i = 0; i < bytes.length; i++) {
		words[i >> 2] |= bytes[i] << ((i & 3) * 8);
	}
	words[bytes.length >> 2] |= 0x80 << ((bytes.length & 3) * 8);
	words[14] = bytes.length * 8;
	const shifts = [
		7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
		5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
		4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
		6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
	];
	let a = 0x67452301 | 0;
	let b = 0xefcdab89 | 0;
	let c = 0x98badcfe | 0;
	let d = 0x10325476 | 0;
	const initial = [a, b, c, d];
	for (let i = 0; i < 64; i++) {
		let f, g;
		if (i < 16) { f = (b & c) | (~b & d); g = i; }
		else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
		else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) & 15; }
		else { f = c ^ (b | ~d); g = (7 * i) & 15; }
		const sum = (a + f + (Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) | 0) + words[g]) | 0;
		const rotated = (sum << shifts[i]) | (sum >>> (32 - shifts[i]));
		const oldD = d;
		d = c;
		c = b;
		b = (b + rotated) | 0;
		a = oldD;
	}
	const state = [(a + initial[0]) | 0, (b + initial[1]) | 0,
		(c + initial[2]) | 0, (d + initial[3]) | 0];
	let hex = "";
	for (const word of state) {
		for (let i = 0; i < 4; i++) hex += ((word >>> (i * 8)) & 0xff).toString(16).padStart(2, "0");
	}
	return hex;
}

export function _fowFilenameForId(id) {
	if (!Number.isInteger(id) || id < 0 || id >= FOW_MAP_WIDTH * FOW_MAP_WIDTH) return "";
	const digits = String(id);
	const body = Array.from(digits, (d) => FILENAME_MASK1[Number(d)]).join("");
	const suffix = Array.from(digits, (d) => FILENAME_MASK2[Number(d)]).join("").slice(-2);
	return md5ShortAscii(digits).slice(0, 4) + body + suffix;
}

export function _fowDecodeFilename(filename) {
	if (typeof filename !== "string" || filename.length < 7) return null;
	const body = filename.slice(4, -2);
	let id = 0;
	for (const char of body) {
		const digit = FILENAME_MASK1.indexOf(char);
		if (digit < 0) return null;
		id = id * 10 + digit;
	}
	if (id < 0 || id >= FOW_MAP_WIDTH * FOW_MAP_WIDTH) return null;
	if (_fowFilenameForId(id) !== filename) return null;
	return { id, x: id % FOW_MAP_WIDTH, y: Math.floor(id / FOW_MAP_WIDTH) };
}

export function _fowParseInflated(filename, bytes) {
	const coords = _fowDecodeFilename(filename);
	if (!coords) throw new Error("invalid Fog of World filename: " + filename);
	if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
	if (bytes.byteLength < FOW_HEADER_SIZE) {
		throw new Error(filename + ": truncated Fog of World header");
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const blocks = new Map();
	for (let i = 0; i < FOW_BLOCKS * FOW_BLOCKS; i++) {
		const blockIndex = view.getUint16(i * 2, true);
		if (!blockIndex) continue;
		const start = FOW_HEADER_SIZE + (blockIndex - 1) * FOW_BLOCK_SIZE;
		if (start + FOW_BLOCK_SIZE > bytes.byteLength) {
			throw new Error(filename + ": block index past end of file");
		}
		blocks.set(i, bytes.subarray(start, start + FOW_BITMAP_SIZE));
	}
	return { ...coords, filename, blocks };
}

export function _fowVisited(bitmap, x, y) {
	return (bitmap[Math.floor(x / 8) + y * 8] & (1 << (7 - (x & 7)))) !== 0;
}

async function inflateZlib(arrayBuffer) {
	if (typeof DecompressionStream !== "function") {
		throw new Error("This browser does not support zlib decompression");
	}
	const stream = new Blob([arrayBuffer]).stream()
		.pipeThrough(new DecompressionStream("deflate"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

function dropboxSessionGet(url) {
	return new Promise((resolve, reject) => {
		gmGet(url, {
			responseType: "arraybuffer",
			timeout: 60000,
			anonymous: false,
		}, (err, response) => {
			if (err) { reject(err); return; }
			if (!response || response.status === 404) { resolve(null); return; }
			if (/\/login(?:\?|$)/.test(response.finalUrl || "")) {
				reject(new Error("Sign in to dropbox.com in this browser first"));
				return;
			}
			if (response.status < 200 || response.status >= 300) {
				reject(new Error("Dropbox HTTP " + response.status));
				return;
			}
			const bytes = new Uint8Array(response.response || new ArrayBuffer(0));
			// A missing private file resolves to the normal Dropbox HTML view.
			// A Fog of World chunk is a zlib stream (RFC 1950 header checksum).
			if (bytes.length < 2 || bytes[0] !== 0x78 || ((bytes[0] << 8) + bytes[1]) % 31 !== 0) {
				resolve(null);
				return;
			}
			resolve(response.response);
		});
	});
}

function canvasPng(canvas) {
	return new Promise((resolve, reject) => {
		canvas.toBlob((blob) => {
			if (!blob) { reject(new Error("Fog of World tile encoding failed")); return; }
			blob.arrayBuffer().then(resolve, reject);
		}, "image/png");
	});
}

class DropboxFogSource {
	constructor() {
		this.folder = GM_getValue(CFG.FOW_DROPBOX_FOLDER_KEY, CFG.FOW_DROPBOX_DEFAULT_FOLDER);
		this.cache = new Map();
		this.layer = null;
		this._registerConfigMenu();
	}

	_registerConfigMenu() {
		if (typeof GM_registerMenuCommand !== "function") return;
		GM_registerMenuCommand("Set Fog of World Dropbox folder", () => {
			this.configure();
		});
	}

	configure() {
		const enteredFolder = prompt(
			"Dropbox web folder containing the Fog of World chunk files:",
			this.folder || CFG.FOW_DROPBOX_DEFAULT_FOLDER,
		);
		if (enteredFolder === null) return false;
		this.folder = this._normaliseFolder(enteredFolder);
		GM_setValue(CFG.FOW_DROPBOX_FOLDER_KEY, this.folder);
		this.cache.clear();
		if (this.layer?._map) this.layer.redraw();
		return true;
	}

	_normaliseFolder(folder) {
		let path = String(folder || CFG.FOW_DROPBOX_DEFAULT_FOLDER).trim();
		if (!path.startsWith("/")) path = "/" + path;
		return path.replace(/\/+$/, "") || "/";
	}

	async getChunk(id) {
		const now = Date.now();
		const existing = this.cache.get(id);
		if (existing && existing.expires > now) {
			this.cache.delete(id);
			this.cache.set(id, existing);
			return existing.promise;
		}
		const pending = this._downloadChunk(id).catch((error) => {
			this.cache.delete(id);
			throw error;
		});
		this.cache.set(id, { expires: now + CACHE_TTL, promise: pending });
		while (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value);
		return pending;
	}

	async _downloadChunk(id) {
		const filename = _fowFilenameForId(id);
		const folder = this.folder.split("/").filter(Boolean).map(encodeURIComponent).join("/");
		const url = "https://www.dropbox.com/home/" + folder +
			"?preview=" + encodeURIComponent(filename) + "&dl=1";
		const compressed = await dropboxSessionGet(url);
		if (!compressed) return null;
		return _fowParseInflated(filename, await inflateZlib(compressed));
	}

	async paint(canvas, z, rawX, y) {
		if (z < FOW_CHUNK_ZOOM) return;
		const worldTiles = 2 ** z;
		const x = ((rawX % worldTiles) + worldTiles) % worldTiles;
		const chunkDivisor = 2 ** (z - FOW_CHUNK_ZOOM);
		const chunkX = Math.floor(x / chunkDivisor);
		const chunkY = Math.floor(y / chunkDivisor);
		if (chunkY < 0 || chunkY >= FOW_MAP_WIDTH) return;
		const id = chunkY * FOW_MAP_WIDTH + chunkX;
		const chunk = await this.getChunk(id);

		const ctx = canvas.getContext("2d");
		ctx.clearRect(0, 0, 256, 256);
		ctx.fillStyle = "rgba(8, 15, 29, 0.72)";
		ctx.fillRect(0, 0, 256, 256);
		if (!chunk) return;

		const sourcePerPixel = 2 ** (FOW_NATIVE_ZOOM - z);
		const sourceX = x * 256 * sourcePerPixel - chunkX * FOW_TILE_WIDTH;
		const sourceY = y * 256 * sourcePerPixel - chunkY * FOW_TILE_WIDTH;
		const sourceRight = sourceX + 256 * sourcePerPixel;
		const sourceBottom = sourceY + 256 * sourcePerPixel;
		const minBx = Math.max(0, Math.floor(sourceX / FOW_BLOCK_WIDTH));
		const minBy = Math.max(0, Math.floor(sourceY / FOW_BLOCK_WIDTH));
		const maxBx = Math.min(FOW_BLOCKS - 1, Math.floor((sourceRight - Number.EPSILON) / FOW_BLOCK_WIDTH));
		const maxBy = Math.min(FOW_BLOCKS - 1, Math.floor((sourceBottom - Number.EPSILON) / FOW_BLOCK_WIDTH));
		const outputSize = Math.max(1, 1 / sourcePerPixel);

		for (let by = minBy; by <= maxBy; by++) {
			for (let bx = minBx; bx <= maxBx; bx++) {
				const bitmap = chunk.blocks.get(by * FOW_BLOCKS + bx);
				if (!bitmap) continue;
				for (let py = 0; py < FOW_BLOCK_WIDTH; py++) {
					const sy = by * FOW_BLOCK_WIDTH + py;
					if (sy < sourceY || sy >= sourceBottom) continue;
					for (let byteX = 0; byteX < 8; byteX++) {
						const bits = bitmap[py * 8 + byteX];
						if (!bits) continue;
						for (let bit = 0; bit < 8; bit++) {
							if (!(bits & (1 << (7 - bit)))) continue;
							const sx = bx * FOW_BLOCK_WIDTH + byteX * 8 + bit;
							if (sx < sourceX || sx >= sourceRight) continue;
							const dx = Math.floor((sx - sourceX) / sourcePerPixel);
							const dy = Math.floor((sy - sourceY) / sourcePerPixel);
							ctx.clearRect(dx, dy, outputSize, outputSize);
						}
					}
				}
			}
		}
	}
}

export class FogOfWorldLayerProvider extends LayerProvider {
	create() {
		const source = new DropboxFogSource();
		const FogLayer = L.GridLayer.extend({
			createTile(coords, done) {
				const canvas = document.createElement("canvas");
				canvas.width = 256;
				canvas.height = 256;
				source.paint(canvas, coords.z, coords.x, coords.y)
					.then(() => done(null, canvas))
					.catch((error) => {
						console.warn("[CustomTiles] Fog of World tile:", error.message);
						done(error, canvas);
					});
				return canvas;
			},

			onAdd(map) {
				L.GridLayer.prototype.onAdd.call(this, map);
				source.layer = this;
			},

			onRemove(map) {
				L.GridLayer.prototype.onRemove.call(this, map);
			},
		});

		const layer = new FogLayer({
			tileSize: 256,
			minZoom: FOW_CHUNK_ZOOM,
			maxZoom: 25,
			opacity: 1,
			attribution: "Fog of World data via Dropbox",
		});
		dwRegisterMbLayer(layer, async (z, x, y) => {
			const canvas = document.createElement("canvas");
			canvas.width = 256;
			canvas.height = 256;
			await source.paint(canvas, z, x, y);
			return canvasPng(canvas);
		});
		return layer;
	}
}
