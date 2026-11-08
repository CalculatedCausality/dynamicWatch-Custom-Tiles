// The route sampled at even spacing (see route-geometry.js), for its
// elevation profile and the course features found along it.

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
