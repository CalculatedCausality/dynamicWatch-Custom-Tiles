// Append alpha to a #rrggbb colour -> 'rgba(r,g,b,a)' for canvas fill.
export function hexAlpha(hex, a) {
	const m = /^#([0-9a-f]{6})$/i.exec(hex);
	if (!m) return hex;
	const v = parseInt(m[1], 16);
	return `rgba(${(v >> 16) & 0xff},${(v >> 8) & 0xff},${v & 0xff},${a})`;
}

// Ray-casting point-in-polygon for hit testing.
export function pointInRing(px, py, ring) {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const xi = ring[i][0], yi = ring[i][1];
		const xj = ring[j][0], yj = ring[j][1];
		const intersect = ((yi > py) !== (yj > py)) &&
			(px < (xj - xi) * (py - yi) / (yj - yi + 1e-12) + xi);
		if (intersect) inside = !inside;
	}
	return inside;
}

export function intvlActivityTime(activityId) {
	if (typeof activityId !== "string" || activityId.length < 9 ||
	    activityId[0] !== "c") return null;
	const ms = parseInt(activityId.slice(1, 9), 36);
	if (!Number.isFinite(ms) ||
	    ms < Date.UTC(2018, 0, 1) || ms > Date.now() + 864e5) return null;
	return new Date(ms);
}

export function intvlAgo(date) {
	if (!(date instanceof Date) || isNaN(date)) return "";
	const days = Math.floor((Date.now() - date.getTime()) / 864e5);
	if (days < 0) return "";
	if (days === 0) return "today";
	if (days === 1) return "yesterday";
	if (days < 30) return days + " days ago";
	const months = Math.floor(days / 30);
	if (months < 12) return months + (months === 1 ? " month" : " months") + " ago";
	const years = Math.floor(days / 365);
	const rem = Math.floor((days - years * 365) / 30);
	return years + "y" + (rem ? " " + rem + "mo" : "") + " ago";
}

export function intvlArea(m2) {
	const v = Number(m2) || 0;
	if (v < 1e5) return Math.round(v).toLocaleString() + " m\u00b2";
	const km2 = v / 1e6;
	return (km2 < 10 ? km2.toFixed(2) : km2.toFixed(1)) + " km²";
}
