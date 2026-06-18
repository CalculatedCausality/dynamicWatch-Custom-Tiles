import { hexAlpha } from "./intvl.js";

// Minimal Mapbox Vector Tile PBF parser used by the INTVL layer.
export function mvtDecode(buf) {
	const layers = [];
	const view = new Uint8Array(buf);
	let off = 0;
	while (off < view.length) {
		const tag = readVarint(view, off); off = tag.end;
		const fn = tag.v >>> 3, wt = tag.v & 7;
		if (fn === 3 && wt === 2) {
			const len = readVarint(view, off); off = len.end;
			layers.push(parseLayer(view.subarray(off, off + len.v)));
			off += len.v;
		} else {
			off = skipField(view, off, wt);
		}
	}
	return layers;
}

export function readVarint(buf, off) {
	let result = 0, shift = 0, b;
	do {
		b = buf[off++];
		result |= (b & 0x7f) << shift;
		shift += 7;
	} while (b & 0x80);
	return { v: result >>> 0, end: off };
}

export function skipField(buf, off, wireType) {
	if (wireType === 0)        { return readVarint(buf, off).end; }
	else if (wireType === 1)   { return off + 8; }
	else if (wireType === 2)   { const r = readVarint(buf, off); return r.end + r.v; }
	else if (wireType === 5)   { return off + 4; }
	return off;
}

export function parseLayer(buf) {
	const info = { name: "", extent: 4096, keys: [], values: [], features: [] };
	let off = 0;
	while (off < buf.length) {
		const tag = readVarint(buf, off); off = tag.end;
		const fn = tag.v >>> 3, wt = tag.v & 7;
		if      (fn === 1 && wt === 2) {
			const r = readVarint(buf, off); off = r.end;
			info.name = utf8(buf, off, r.v); off += r.v;
		} else if (fn === 5 && wt === 0) {
			const r = readVarint(buf, off); off = r.end; info.extent = r.v;
		} else if (fn === 3 && wt === 2) {
			const r = readVarint(buf, off); off = r.end;
			info.keys.push(utf8(buf, off, r.v)); off += r.v;
		} else if (fn === 4 && wt === 2) {
			const r = readVarint(buf, off); off = r.end;
			info.values.push(parseValue(buf.subarray(off, off + r.v))); off += r.v;
		} else if (fn === 2 && wt === 2) {
			const r = readVarint(buf, off); off = r.end;
			info.features.push(parseFeature(buf.subarray(off, off + r.v))); off += r.v;
		} else {
			off = skipField(buf, off, wt);
		}
	}
	return info;
}

export function parseValue(buf) {
	let off = 0;
	while (off < buf.length) {
		const tag = readVarint(buf, off); off = tag.end;
		const fn = tag.v >>> 3, wt = tag.v & 7;
		if (fn === 1 && wt === 2) {
			const r = readVarint(buf, off); off = r.end;
			return utf8(buf, off, r.v);
		}
		if (fn === 2 && wt === 5) {
			return new DataView(buf.buffer, buf.byteOffset + off).getFloat32(0, true);
		}
		if (fn === 3 && wt === 1) {
			return new DataView(buf.buffer, buf.byteOffset + off).getFloat64(0, true);
		}
		if ((fn === 4 || fn === 5) && wt === 0) {
			return readVarint(buf, off).v;
		}
		if (fn === 6 && wt === 0) {
			const v = readVarint(buf, off).v;
			return (v >>> 1) ^ -(v & 1);
		}
		if (fn === 7 && wt === 0) {
			return readVarint(buf, off).v !== 0;
		}
		off = skipField(buf, off, wt);
	}
	return null;
}

export function parseFeature(buf) {
	const f = { tags: [], type: 0, geom: [] };
	let off = 0;
	while (off < buf.length) {
		const tag = readVarint(buf, off); off = tag.end;
		const fn = tag.v >>> 3, wt = tag.v & 7;
		if (fn === 2 && wt === 2) {
			const r = readVarint(buf, off); off = r.end;
			const end = off + r.v;
			while (off < end) {
				const x = readVarint(buf, off); off = x.end;
				f.tags.push(x.v);
			}
		} else if (fn === 3 && wt === 0) {
			const r = readVarint(buf, off); off = r.end; f.type = r.v;
		} else if (fn === 4 && wt === 2) {
			const r = readVarint(buf, off); off = r.end;
			const end = off + r.v;
			while (off < end) {
				const x = readVarint(buf, off); off = x.end;
				f.geom.push(x.v);
			}
		} else {
			off = skipField(buf, off, wt);
		}
	}
	return f;
}

// Decode a feature's geometry stream into rings of [tilePxX, tilePxY].
export function decodeGeometry(geom) {
	const rings = [];
	let ring = null;
	let i = 0, x = 0, y = 0;
	while (i < geom.length) {
		const cmd = geom[i] & 0x7;
		const count = geom[i] >>> 3;
		i++;
		if (cmd === 1) {
			for (let k = 0; k < count; k++) {
				x += zig(geom[i++]); y += zig(geom[i++]);
				if (ring && ring.length) rings.push(ring);
				ring = [[x, y]];
			}
		} else if (cmd === 2) {
			for (let k = 0; k < count; k++) {
				x += zig(geom[i++]); y += zig(geom[i++]);
				ring.push([x, y]);
			}
		} else if (cmd === 7) {
			if (ring) { rings.push(ring); ring = null; }
		}
	}
	if (ring && ring.length) rings.push(ring);
	return rings;
}

export function zig(n) { return (n >>> 1) ^ -(n & 1); }

export function utf8(buf, off, len) {
	let s = "";
	let allAscii = true;
	for (let i = 0; i < len; i++) {
		const b = buf[off + i];
		if (b > 127) { allAscii = false; break; }
		s += String.fromCharCode(b);
	}
	return allAscii ? s : new TextDecoder().decode(buf.subarray(off, off + len));
}

export function prepareLayers(layers, fillAlpha) {
	const out = [];
	const fillCache = new Map();
	for (const layer of layers) {
		if (layer.name !== "territories") continue;
		const features = [];
		for (const f of layer.features) {
			if (f.type !== 3) continue;
			const props = {};
			for (let i = 0; i < f.tags.length; i += 2) {
				props[layer.keys[f.tags[i]]] = layer.values[f.tags[i + 1]];
			}
			const colour = props.colour || "#3b82f6";
			let fillStyle = fillCache.get(colour);
			if (!fillStyle) {
				fillStyle = hexAlpha(colour, fillAlpha);
				fillCache.set(colour, fillStyle);
			}
			const rings = decodeGeometry(f.geom);
			let mnX = Infinity, mnY = Infinity, mxX = -Infinity, mxY = -Infinity;
			for (const ring of rings) {
				for (const p of ring) {
					const x = p[0], y = p[1];
					if (x < mnX) mnX = x; if (x > mxX) mxX = x;
					if (y < mnY) mnY = y; if (y > mxY) mxY = y;
				}
			}
			features.push({
				props,
				colour,
				fillStyle,
				startTime: typeof props.startTime === "number" ? props.startTime : 0,
				rings,
				mnX, mnY, mxX, mxY,
			});
		}
		features.sort((a, b) => a.startTime - b.startTime);
		out.push({ name: layer.name, extent: layer.extent, features });
	}
	return out;
}
