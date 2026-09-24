// Run directly with `node --test tests/polling-data-layer.mjs`; no bundle or network.
import test from "node:test";
import assert from "node:assert/strict";

globalThis.window = {};
globalThis.GM_getValue = (key, fallback) =>
	key === "dw_waze_token_manual" ? "test-token" : fallback;

const requests = [];
globalThis.GM_xmlhttpRequest = (opts) => {
	requests.push(opts);
	return { abort() {} };
};

class TestGroup {
	constructor() { this.layers = new Set(); this._map = null; }
	addTo(map) { this._map = map; return this; }
	addLayer(layer) { this.layers.add(layer); return this; }
	removeLayer(layer) { this.layers.delete(layer); return this; }
	hasLayer(layer) { return this.layers.has(layer); }
	clearLayers() { this.layers.clear(); return this; }
	remove() { this._map = null; this.clearLayers(); }
}

class TestMarker {
	constructor(latlng) { this.latlng = latlng; }
	bindTooltip(tip) { this.tip = tip; return this; }
	setTooltipContent(tip) { this.tip = tip; return this; }
	setLatLng(latlng) { this.latlng = latlng; return this; }
	setIcon(icon) { this.icon = icon; return this; }
	addTo(group) { group.addLayer(this); return this; }
	on() { return this; }
}

globalThis.L = {
	Layer: {},
	layerGroup: () => new TestGroup(),
	marker: (latlng) => new TestMarker(latlng),
	divIcon: (opts) => opts,
	polyline: (latlng) => new TestMarker(latlng),
};
// Leaflet's extend copies methods onto the layer prototype.
L.Layer.extend = (methods) => {
	class Layer { constructor() { this.initialize(); } }
	Object.assign(Layer.prototype, methods);
	return Layer;
};

const { pollingDataLayer } = await import("../src/layers/polling-data-layer.js");
const { FlightsLayerProvider, WazeLayerProvider, MarineTrafficLayerProvider } =
	await import("../src/providers/live-data.js");

function mapAt(zoom = 10) {
	return {
		zoom, west: 0.1, east: 0.2, south: 0.1, north: 0.2,
		panes: new Map(),
		getZoom() { return this.zoom; },
		getMaxZoom() { return 18; },
		getPane(name) { return this.panes.get(name); },
		createPane(name) { this.panes.set(name, { style: {} }); },
		getBounds() {
			return {
				getSouth: () => this.south, getWest: () => this.west,
				getNorth: () => this.north, getEast: () => this.east,
			};
		},
		getCenter() { return { lat: 0.15, lng: 0.15 }; },
		project([lat, lon]) { return { x: lon * 1000, y: lat * 1000 }; },
		on() {}, off() {},
	};
}

function add(layer, map) {
	layer._map = map;
	layer.onAdd(map);
	return layer._group;
}

function remove(layer, map) {
	layer.onRemove(map);
	layer._map = null;
}

function reply(req, data) {
	req.onload({ status: 200, responseText: JSON.stringify(data) });
}

function names(group) {
	return [...group.layers].map((layer) => layer.tip);
}

function flight(id) {
	const state = [];
	state[0] = id; state[1] = id;
	state[5] = 1; state[6] = 2;
	return state;
}

function ship(name, mmsi) {
	return { LAT: "0.15", LON: "0.15", SHIPNAME: name, MMSI: mmsi };
}

test("poll guard invalidates immediately on view change, low zoom, newer poll and removal/re-add", () => {
	const guards = [];
	const Layer = pollingDataLayer({
		pane: "test", minZoom: 6, pollMs: 0, debounceMs: 10000,
		fetch: (_map, _group, _layer, isCurrent) => guards.push(isCurrent),
	});
	const layer = new Layer(), map = mapAt();
	try {
		const group = add(layer, map);
		assert.equal(guards[0](), true);
		layer._onViewChange();
		assert.equal(guards[0](), false, "view invalidates before debounce");
		layer._fetchGuarded();
		assert.equal(guards[1](), true);
		layer._fetchGuarded();
		assert.equal(guards[1](), false, "newer poll wins");
		group.addLayer({});
		map.zoom = 5;
		assert.equal(guards[2](), false, "zoom check works before zoomend");
		layer._onViewChange();
		assert.equal(group.layers.size, 0, "zooming out clears existing markers");
		layer._fetchGuarded();
		assert.equal(guards.length, 3, "no fetch below minZoom");
		map.zoom = 10;
		layer._fetchGuarded();
		assert.equal(guards[3](), true);
		remove(layer, map);
		assert.equal(guards[3](), false);
		add(layer, map);
		assert.equal(guards[3](), false, "old attachment never becomes current again");
		assert.equal(guards[4](), true);
	} finally {
		if (layer._group) remove(layer, map);
	}
});

test("Flights ignores old responses after a newer poll, view change and re-add", () => {
	requests.length = 0;
	const layer = new FlightsLayerProvider().create(), map = mapAt();
	try {
		const group = add(layer, map);
		const old = requests[0];
		layer._fetchGuarded();
		const latest = requests[1];
		reply(latest, { states: [flight("new")] });
		reply(old, { states: [flight("old")] });
		assert.match(names(group)[0], /new/);
		assert.equal(group.layers.size, 1);

		layer._fetchGuarded();
		const beforePan = requests[2];
		layer._onViewChange();
		reply(beforePan, { states: [flight("pan-stale")] });
		assert.match(names(group)[0], /new/);

		layer._fetchGuarded();
		const beforeRemove = requests[3];
		remove(layer, map);
		const newGroup = add(layer, map);
		reply(beforeRemove, { states: [flight("removed")] });
		assert.equal(newGroup.layers.size, 0);
		reply(requests[4], { states: [flight("re-added")] });
		assert.match(names(newGroup)[0], /re-added/);
	} finally {
		if (layer._group) remove(layer, map);
	}
});

test("Waze skips stale tokens before request and stale georss responses after request", async () => {
	requests.length = 0;
	const layer = new WazeLayerProvider().create(), map = mapAt();
	try {
		const group = add(layer, map);
		layer._onViewChange(); // first token resolves after a view change
		await Promise.resolve();
		assert.equal(requests.length, 0, "view change during token mint skips georss");
		layer._fetchGuarded();
		layer._fetchGuarded(); // previous token resolves after a newer poll has started
		await Promise.resolve();
		assert.equal(requests.length, 1, "stale token must not launch georss");
		const previous = requests[0];
		layer._fetchGuarded();
		await Promise.resolve();
		const current = requests[1];
		reply(current, { alerts: [{ id: 2, type: "HAZARD", location: { x: 1, y: 2 } }] });
		reply(previous, { alerts: [{ id: 1, type: "POLICE", location: { x: 1, y: 2 } }] });
		assert.equal(group.layers.size, 1);
		assert.match(names(group)[0], /Hazard/);

		layer._fetchGuarded();
		await Promise.resolve();
		map.zoom = 8;
		reply(requests[2], { alerts: [{ id: 3, type: "POLICE", location: { x: 1, y: 2 } }] });
		assert.match(names(group)[0], /Hazard/, "zoom below minimum blocks response");
		layer._onViewChange();
		assert.equal(group.layers.size, 0);
		map.zoom = 10;
		layer._fetchGuarded();
		remove(layer, map);
		await Promise.resolve();
		assert.equal(requests.length, 3, "removal during token mint skips georss");
	} finally {
		if (layer._group) remove(layer, map);
	}
});

test("Marine waits for all tiles and rejects interleaved old batches", () => {
	requests.length = 0;
	const layer = new MarineTrafficLayerProvider().create(), map = mapAt(6);
	map.east = 6.1; // two adjacent z6 tiles
	try {
		const group = add(layer, map);
		assert.equal(requests.length, 2);
		layer._fetchGuarded();
		assert.equal(requests.length, 4);
		reply(requests[2], { data: { rows: [ship("current", "1")] } });
		assert.equal(group.layers.size, 0, "partial batch is not rendered");
		reply(requests[0], { data: { rows: [ship("stale", "2")] } });
		reply(requests[1], { data: { rows: [] } });
		assert.equal(group.layers.size, 0, "old batch completion cannot render");
		reply(requests[3], { data: { rows: [] } });
		assert.match(names(group)[0], /current/);

		layer._fetchGuarded();
		layer._onViewChange();
		reply(requests[4], { data: { rows: [ship("panned", "3")] } });
		reply(requests[5], { data: { rows: [] } });
		assert.match(names(group)[0], /current/);

		layer._fetchGuarded();
		remove(layer, map);
		const newGroup = add(layer, map);
		reply(requests[6], { data: { rows: [ship("removed", "4")] } });
		reply(requests[7], { data: { rows: [] } });
		assert.equal(newGroup.layers.size, 0);
		reply(requests[8], { data: { rows: [ship("re-added", "5")] } });
		reply(requests[9], { data: { rows: [] } });
		assert.match(names(newGroup)[0], /re-added/);
	} finally {
		if (layer._group) remove(layer, map);
	}
});
