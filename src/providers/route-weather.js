import { CFG } from "../config.js";
import { gmJsonGet } from "../utils/http.js";
import { alongAt, timeAt } from "../utils/route-timing.js";

/* -- Forecast along the route at the expected arrival times --------------
 * One Open-Meteo request (keyless; free for non-commercial use, CC BY 4.0)
 * covers up to a dozen points spread along the route; each point takes the
 * forecast hour nearest the time you're expected there.
 */

const HOURLY = "temperature_2m,apparent_temperature,precipitation_probability," +
	"precipitation,wind_speed_10m,wind_gusts_10m,uv_index,weather_code";
const HOUR_MS = 3600e3;
const FORECAST_DAYS = 16;
const _cache = new Map();
const CACHE_MS = 30 * 60e3;

// Points spread along the route (start and finish included) with their ETA.
export function weatherPoints(samples, timing, startMs, maxPoints = 12) {
	if (!samples.length) return [];
	const total = samples[samples.length - 1].along;
	const count = Math.max(2, Math.min(maxPoints, Math.ceil((total - 1) / 3000) + 1));
	const points = [];
	let j = 0;
	for (let k = 0; k < count; k++) {
		const along = total * k / (count - 1);
		while (j < samples.length - 1 && samples[j + 1].along <= along) j++;
		const s = samples[j];
		points.push({ along, lat: s.lat, lng: s.lng, eta: startMs + timeAt(timing, along) * 1000 });
	}
	return points;
}

const isoHour = (ms) => new Date(Math.floor(ms / HOUR_MS) * HOUR_MS).toISOString().slice(0, 13) + ":00";

export function weatherUrl(points) {
	const first = Math.min(...points.map((p) => p.eta));
	const last = Math.max(...points.map((p) => p.eta));
	const params = new URLSearchParams({
		latitude: points.map((p) => p.lat.toFixed(4)).join(","),
		longitude: points.map((p) => p.lng.toFixed(4)).join(","),
		hourly: HOURLY,
		timezone: "GMT", timeformat: "unixtime", wind_speed_unit: "kmh",
		start_hour: isoHour(first), end_hour: isoHour(last + HOUR_MS),
	});
	return CFG.OPEN_METEO_FORECAST + "?" + params;
}

// Attach the forecast hour nearest each point's ETA.
export function applyForecast(points, data) {
	const sites = Array.isArray(data) ? data : [data];
	return points.map((p, i) => {
		const hourly = sites[i] && sites[i].hourly;
		if (!hourly || !Array.isArray(hourly.time) || !hourly.time.length) return { ...p, wx: null };
		let best = 0;
		for (let h = 1; h < hourly.time.length; h++) {
			if (Math.abs(hourly.time[h] * 1000 - p.eta) < Math.abs(hourly.time[best] * 1000 - p.eta)) best = h;
		}
		const pick = (k) => (Array.isArray(hourly[k]) && Number.isFinite(hourly[k][best]) ? hourly[k][best] : null);
		return {
			...p,
			wx: {
				temp: pick("temperature_2m"), feels: pick("apparent_temperature"),
				rainChance: pick("precipitation_probability"), rain: pick("precipitation"),
				wind: pick("wind_speed_10m"), gusts: pick("wind_gusts_10m"),
				uv: pick("uv_index"), code: pick("weather_code"),
			},
		};
	});
}

// Extremes along the route, each with where/when it happens.
export function summarizeWeather(points) {
	const withWx = points.filter((p) => p.wx);
	if (!withWx.length) return null;
	const extreme = (key, better) => withWx.reduce((best, p) =>
		p.wx[key] != null && (best == null || better(p.wx[key], best.wx[key])) ? p : best, null);
	const at = (p, key) => (p ? { value: p.wx[key], along: p.along, eta: p.eta } : null);
	const storms = withWx.filter((p) => p.wx.code != null && p.wx.code >= 95);
	return {
		minTemp: at(extreme("temp", (a, b) => a < b), "temp"),
		maxTemp: at(extreme("temp", (a, b) => a > b), "temp"),
		maxFeels: at(extreme("feels", (a, b) => a > b), "feels"),
		maxRainChance: at(extreme("rainChance", (a, b) => a > b), "rainChance"),
		maxGusts: at(extreme("gusts", (a, b) => a > b), "gusts"),
		maxUv: at(extreme("uv", (a, b) => a > b), "uv"),
		storm: storms.length ? { along: storms[0].along, eta: storms[0].eta } : null,
	};
}

// Highest feels-like temperature between two distances along the route.
export function maxFeelsBetween(points, from, to) {
	let max = null;
	for (const p of points) {
		if (!p.wx || p.wx.feels == null || p.along < from - 1500 || p.along > to + 1500) continue;
		if (max == null || p.wx.feels > max) max = p.wx.feels;
	}
	return max;
}

export function fetchRouteWeather(points, opts, cb) {
	opts = opts || {};
	const now = opts.now != null ? opts.now : Date.now();
	if (!points.length) { cb(null, { status: "none" }); return; }
	const first = Math.min(...points.map((p) => p.eta));
	const last = Math.max(...points.map((p) => p.eta));
	if (last < now - HOUR_MS) { cb(null, { status: "past" }); return; }
	if (first > now + (FORECAST_DAYS - 0.5) * 24 * HOUR_MS) { cb(null, { status: "too-far" }); return; }
	const url = weatherUrl(points);
	const hit = _cache.get(url);
	if (hit && now - hit.at < CACHE_MS) { cb(null, { status: "ok", points: applyForecast(points, hit.data) }); return; }
	(opts.fetchJson || gmJsonGet)(url, { timeout: 20000 }, (err, data) => {
		if (err || !data || data.error) { cb(err || new Error(String(data && data.reason || "forecast"))); return; }
		_cache.set(url, { at: now, data });
		cb(null, { status: "ok", points: applyForecast(points, data) });
	});
}

// Re-exported so callers can map a time to a place (e.g. sunset → km).
export { alongAt };
