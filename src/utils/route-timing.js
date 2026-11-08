// Arrival-time estimates along a measured route (see route-geometry.js).
// The route is sampled every `step` metres; a pace model scales the runner's
// flat pace by the gradient of each step.

export const SAMPLE_STEP_M = 50;

// Points every `step` metres along each part, plus every part's end, with
// distance along the route (`along`, metres) continuing across parts.
export function resampleRoute(route, step = SAMPLE_STEP_M) {
	const samples = [];
	for (const { points, cum } of route.parts) {
		let i = 1;
		const end = cum[cum.length - 1];
		// Snap to the end rather than leave a sliver of a step.
		for (let at = cum[0]; ; at = end - at < step + 1 ? end : at + step) {
			while (i < cum.length - 1 && cum[i] < at) i++;
			const a = cum[i - 1], b = cum[i];
			const t = b > a ? (at - a) / (b - a) : 0;
			const p = points[i - 1], q = points[i];
			samples.push({ along: at, lng: p[0] + (q[0] - p[0]) * t, lat: p[1] + (q[1] - p[1]) * t, partStart: at === cum[0] });
			if (at >= end) break;
		}
	}
	return samples;
}

// Pace multiplier for a gradient (rise/run). Climbs follow Minetti et al.'s
// energy cost of running (2002), as grade-adjusted pace does; descents get a
// modest boost that peaks near -10% and fades on steep ground, where trail
// runners have to brake.
export function gradeFactor(grade) {
	const g = Math.max(-0.45, Math.min(0.45, Number(grade) || 0));
	if (g >= 0) {
		const cost = 155.4 * g ** 5 - 30.4 * g ** 4 - 43.3 * g ** 3 + 46.3 * g ** 2 + 19.5 * g + 3.6;
		return cost / 3.6;
	}
	return 1 + 1.8 * g + 9 * g * g;
}

// Centred moving average; DEM noise otherwise inflates climbing.
export function smoothElevations(values, window = 5) {
	const half = Math.floor(window / 2), out = new Float64Array(values.length);
	for (let i = 0; i < values.length; i++) {
		let sum = 0, n = 0;
		for (let k = i - half; k <= i + half; k++) {
			if (k >= 0 && k < values.length && Number.isFinite(values[k])) { sum += values[k]; n++; }
		}
		out[i] = n ? sum / n : NaN;
	}
	return out;
}

// Cumulative seconds at every sample for a flat pace (seconds per km), and
// total ascent/descent when elevations are known. Gaps between route parts
// (a new part starts) take no time.
export function routeTiming(samples, elevations, paceSecPerKm) {
	const times = new Float64Array(samples.length);
	const smooth = elevations ? smoothElevations(elevations) : null;
	let ascent = 0, descent = 0;
	for (let i = 1; i < samples.length; i++) {
		const dist = samples[i].along - samples[i - 1].along;
		let factor = 1;
		if (smooth && !samples[i].partStart && dist > 0) {
			const rise = smooth[i] - smooth[i - 1];
			if (Number.isFinite(rise)) {
				factor = gradeFactor(rise / dist);
				if (rise > 0) ascent += rise;
				else descent -= rise;
			}
		}
		times[i] = times[i - 1] + (samples[i].partStart ? 0 : dist / 1000 * paceSecPerKm * factor);
	}
	return {
		alongs: samples.map((s) => s.along), times,
		total: times[times.length - 1] || 0,
		ascent: smooth ? ascent : null, descent: smooth ? descent : null,
	};
}

function locate(sorted, value) {
	let lo = 0, hi = sorted.length - 1;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (sorted[mid] <= value) lo = mid; else hi = mid;
	}
	return lo;
}

// Seconds after the start at which the route passes `along` metres.
export function timeAt(timing, along) {
	const { alongs, times } = timing;
	if (!alongs.length) return 0;
	if (along <= alongs[0]) return times[0];
	if (along >= alongs[alongs.length - 1]) return times[times.length - 1];
	const i = locate(alongs, along);
	const span = alongs[i + 1] - alongs[i];
	return times[i] + (span > 0 ? (along - alongs[i]) / span : 0) * (times[i + 1] - times[i]);
}

// Distance along the route reached after `seconds`.
export function alongAt(timing, seconds) {
	const { alongs, times } = timing;
	if (!alongs.length) return 0;
	if (seconds <= times[0]) return alongs[0];
	if (seconds >= times[times.length - 1]) return alongs[alongs.length - 1];
	const i = locate(times, seconds);
	const span = times[i + 1] - times[i];
	return alongs[i] + (span > 0 ? (seconds - times[i]) / span : 0) * (alongs[i + 1] - alongs[i]);
}

// "6:00" or "6" (minutes per km or mile) → seconds; null when unreadable.
export function parsePace(text) {
	const m = /^\s*(\d{1,2})(?::([0-5]\d))?\s*$/.exec(String(text || ""));
	if (!m) return null;
	const seconds = Number(m[1]) * 60 + Number(m[2] || 0);
	return seconds >= 120 && seconds <= 3600 ? seconds : null;
}

export function formatPace(seconds) {
	const s = Math.round(seconds);
	return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

export function formatDuration(seconds) {
	const minutes = Math.round(seconds / 60);
	const h = Math.floor(minutes / 60), m = minutes % 60;
	return h ? `${h} h ${String(m).padStart(2, "0")}` : `${m} min`;
}
