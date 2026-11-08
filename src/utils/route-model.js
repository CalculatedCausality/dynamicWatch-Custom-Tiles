// Dynamic.watch owns the editable route as Leaflet polylines and markers.
// Keep the Leaflet objects with their coordinates so the projected route can
// forward insert/drag interactions back to the planner.
export function _dwGetRouteModel() {
	try {
		const pageWin = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
		const plan = pageWin.leafletPlan;
		if (!plan || !Array.isArray(plan.lines)) return { paths: [], markers: [] };
		const paths = [], markers = [], seenMarkers = new Set();
		const addMarker = (marker, type) => {
			if (!marker || seenMarkers.has(marker) || typeof marker.getLatLng !== "function") return;
			const point = marker.getLatLng();
			if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return;
			seenMarkers.add(marker);
			markers.push({ marker, type, point: [point.lng, point.lat] });
		};
		for (const line of plan.lines) {
			if (!Array.isArray(line)) continue;
			for (let segmentIdx = 0; segmentIdx < line.length; segmentIdx++) {
				const segment = line[segmentIdx];
				addMarker(segment && segment.marker_end,
					segmentIdx === 0 ? "start" : segmentIdx === line.length - 1 ? "end" : "via");
				const polyline = segment && segment.polyline;
				if (!polyline || typeof polyline.getLatLngs !== "function") continue;
				try {
					const visit = (part) => {
						if (!Array.isArray(part) || !part.length) return;
						if (!part.some(Array.isArray)) {
							const points = part
								.filter((point) => point && Number.isFinite(point.lat) && Number.isFinite(point.lng))
								.map((point) => [point.lng, point.lat]);
							if (points.length > 1) paths.push({ points, polyline });
							return;
						}
						for (const child of part) visit(child);
					};
					visit(polyline.getLatLngs());
				} catch (_) {}
			}
		}
		for (const waypoint of Array.isArray(plan.waypoints) ? plan.waypoints : []) {
			addMarker(waypoint && waypoint.marker, "waypoint");
		}
		return { paths, markers };
	} catch (_) { return { paths: [], markers: [] }; }
}

export function _dwGetRoutePaths() {
	return _dwGetRouteModel().paths.map((entry) => entry.points);
}
