/* -- Tile geometry utilities ------------------------------------------ */

// Convert a Leaflet tile coordinate (z,x,y) into the geographic bbox the
// tile covers, in EPSG:4326 (lat/lng degrees). Used by every ArcGIS
// MapServer export-style provider.
export function tileToBBox4326(z, x, y) {
	const n = Math.pow(2, z);
	const lon1 = (x / n) * 360 - 180;
	const lon2 = ((x + 1) / n) * 360 - 180;
	const lat1 =
		(Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
	const lat2 =
		(Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) / Math.PI;
	return { minLon: lon1, minLat: lat2, maxLon: lon2, maxLat: lat1 };
}

// Convert a UTFGrid cell (cx, cy) within tile (z, tx, ty) to lat/lng.
// UTFGrid tiles are 64x64 cells over a 256-pixel tile, so each cell is
// 4 px wide and 4 px tall. We address the centre of the cell (offset
// +0.5) and convert the resulting tile-pixel coordinate through the
// standard slippy-tile Mercator inverse. Precision = tile_size/64:
//   z=10 -> ~600 m   z=12 -> ~150 m   z=14 -> ~38 m   z=16 -> ~9.6 m
// Used by the Geocaching public-tile layer to place markers from the
// UTFGrid response (no per-cache lat/lng in the data; only cell idx).
export function utfGridCellToLatLng(z, tx, ty, cx, cy) {
	const px = (cx + 0.5) / 64;
	const py = (cy + 0.5) / 64;
	const n = Math.pow(2, z);
	const lon = ((tx + px) / n) * 360 - 180;
	const lat =
		(Math.atan(Math.sinh(Math.PI * (1 - (2 * (ty + py)) / n))) * 180) /
		Math.PI;
	return [lat, lon];
}

// Same idea, but in EPSG:3857 Web Mercator metres — for WMS endpoints
// (and anything else that wants the bbox in metres).
const _MERC_ORIGIN = 20037508.3428;
const _MERC_FULL = 2 * _MERC_ORIGIN;
export function tileToBBox3857(z, x, y) {
	const n = Math.pow(2, z);
	const tw = _MERC_FULL / n;
	const west = -_MERC_ORIGIN + x * tw;
	const east = west + tw;
	const north = _MERC_ORIGIN - y * tw;
	const south = north - tw;
	return { west, south, east, north };
}

