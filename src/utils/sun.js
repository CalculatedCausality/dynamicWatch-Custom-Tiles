// Sunrise, sunset and civil twilight for a date and place, after the NOAA /
// SunCalc approximations (accurate to about a minute away from the poles).
// Times are epoch milliseconds; null when the sun doesn't cross that angle
// (polar day or night). The solar day nearest `ms` at that longitude is used.
const RAD = Math.PI / 180;
const DAY_MS = 864e5;
const J1970 = 2440588;
const J2000 = 2451545;
const J0 = 0.0009;
const OBLIQUITY = RAD * 23.4397;

const toDays = (ms) => ms / DAY_MS - 0.5 + J1970 - J2000;
const fromJulian = (j) => (j + 0.5 - J1970) * DAY_MS;

export function sunTimes(ms, lat, lng) {
	const lw = RAD * -lng;
	const phi = RAD * lat;
	const n = Math.round(toDays(ms) - J0 - lw / (2 * Math.PI));
	const transit = (ht) => J0 + (ht + lw) / (2 * Math.PI) + n;
	const ds = transit(0);
	const M = RAD * (357.5291 + 0.98560028 * ds);
	const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
	const L = M + C + RAD * 102.9372 + Math.PI;
	const dec = Math.asin(Math.sin(OBLIQUITY) * Math.sin(L));
	const solarTransit = (d) => J2000 + d + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
	const noon = solarTransit(ds);
	const pair = (angle) => {
		const cosH = (Math.sin(angle * RAD) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
		if (!(cosH >= -1 && cosH <= 1)) return [null, null];
		const set = solarTransit(transit(Math.acos(cosH)));
		return [fromJulian(noon - (set - noon)), fromJulian(set)];
	};
	const [sunrise, sunset] = pair(-0.833);
	const [dawn, dusk] = pair(-6);
	return { sunrise, sunset, dawn, dusk, noon: fromJulian(noon) };
}

// Stretches of [startMs, endMs] when the sun is down (sunset → sunrise),
// checking every solar day the window touches.
export function darkIntervals(startMs, endMs, lat, lng) {
	if (!(endMs > startMs)) return [];
	const light = [];
	let polarNight = true;
	for (let t = startMs - DAY_MS; t <= endMs + DAY_MS; t += DAY_MS) {
		const { sunrise, sunset, noon } = sunTimes(t, lat, lng);
		if (sunrise != null && sunset != null) {
			light.push([sunrise, sunset]);
			polarNight = false;
		} else {
			// No crossing: all day light if the sun is up at noon, else dark.
			const up = Math.sin(lat * RAD) * Math.sin(declinationAt(noon)) +
				Math.cos(lat * RAD) * Math.cos(declinationAt(noon)) > Math.sin(-0.833 * RAD);
			if (up) { light.push([noon - DAY_MS / 2, noon + DAY_MS / 2]); polarNight = false; }
		}
	}
	if (polarNight) return [[startMs, endMs]];
	light.sort((a, b) => a[0] - b[0]);
	const dark = [];
	let cursor = startMs;
	for (const [rise, set] of light) {
		if (set <= cursor) continue;
		if (rise > cursor) dark.push([cursor, Math.min(rise, endMs)]);
		cursor = Math.max(cursor, set);
		if (cursor >= endMs) break;
	}
	if (cursor < endMs) dark.push([cursor, endMs]);
	return dark.filter(([a, b]) => b - a > 60_000);
}

function declinationAt(ms) {
	const d = toDays(ms);
	const M = RAD * (357.5291 + 0.98560028 * d);
	const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
	return Math.asin(Math.sin(OBLIQUITY) * Math.sin(M + C + RAD * 102.9372 + Math.PI));
}
