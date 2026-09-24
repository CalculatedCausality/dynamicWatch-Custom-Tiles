// Run directly against source modules: no userscript bundle or live network needed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { makeArcgisQueryLayer } from "../src/providers/qld-environment.js";
import { makeVectorTileLayer } from "../src/layers/vector-tile-layer.js";

class Group {
	constructor() { this.layers = []; }
	addTo() { return this; }
	addLayer(layer) { this.layers.push(layer); return this; }
	removeLayer(layer) { this.layers.splice(this.layers.indexOf(layer), 1); }
	clearLayers() { this.layers.length = 0; }
	remove() { this.clearLayers(); }
}

globalThis.L = {
	Layer: { extend: (methods) => class {
		constructor() { Object.assign(this, methods); this.initialize(); }
	} },
	layerGroup: () => new Group(),
	geoJSON: (data) => ({ data, addTo(group) { group.addLayer(this); } }),
};

function bounds(west, south, east, north) {
	return {
		getWest: () => west, getSouth: () => south,
		getEast: () => east, getNorth: () => north,
	};
}

function mapAt(zoom, view) {
	return {
		zoom, view,
		getZoom() { return this.zoom; },
		getBounds() { return this.view; },
		getPane() { return {}; },
		on() {}, off() {},
	};
}

function add(layer, map) {
	layer._map = map; // Leaflet sets this before onAdd.
	layer.onAdd(map);
	return layer._group;
}

const featureCollection = { type: "FeatureCollection", features: [] };
const a = bounds(-170, 10, -100, 60); // z2 tile 0/1
const b = bounds(-80, 10, -10, 60);   // z2 tile 1/1
const tooWide = bounds(-170, 10, -10, 60); // two z2 tiles

test("ArcGIS retries a failed bbox and a transform failure, then caches success", () => {
	const requests = [];
	const map = mapAt(8, a);
	const layer = makeArcgisQueryLayer({
		pane: "parks", minZoom: 8, label: "parks", queryUrl: "/query",
		where: "1=1", outFields: "*", transform(raw) {
			if (raw.bad) throw new Error("bad transform");
			return raw;
		},
	}, (url, opts, cb) => requests.push({ url, cb }));
	const group = add(layer, map);
	assert.equal(requests.length, 1);
	requests[0].cb(new Error("network"));
	layer._fetch();
	assert.equal(requests.length, 2);
	assert.equal(requests[1].url, requests[0].url);
	requests[1].cb(null, { error: { message: "service unavailable" } });
	layer._fetch();
	assert.equal(requests.length, 3);
	requests[2].cb(null, { bad: true });
	layer._fetch();
	assert.equal(requests.length, 4);
	requests[3].cb(null, featureCollection);
	assert.equal(group.layers.length, 1);
	layer._fetch();
	assert.equal(requests.length, 4);
});

test("ArcGIS zooming below minimum immediately invalidates an in-flight response", () => {
	const requests = [];
	const map = mapAt(8, a);
	const layer = makeArcgisQueryLayer({
		pane: "parks", minZoom: 8, label: "parks", queryUrl: "/query",
		where: "1=1", outFields: "*",
	}, (_url, _opts, cb) => requests.push(cb));
	const group = add(layer, map);
	map.zoom = 7;
	layer._onViewChange();
	requests[0](null, featureCollection);
	assert.equal(group.layers.length, 0);
	map.zoom = 8;
	layer._fetch();
	assert.equal(requests.length, 2);
	requests[1](null, featureCollection);
	assert.equal(group.layers.length, 1);
});

function vectorLayer() {
	return makeVectorTileLayer({
		pane: "vectors", minZoom: 2, maxTiles: 1, label: "vectors",
		tileUrl: (z, x, y) => `${z}/${x}/${y}`,
		toElements: () => [],
		render: (group, elements) => group.addLayer(elements.map((el) => el._id)),
	});
}

test("over-cap vector views clear old features and do not freeze the previous key", () => {
	const map = mapAt(2, a);
	const layer = vectorLayer();
	layer._tileEls.set("2/0/1", [{ type: "node", _id: "A" }]);
	const group = add(layer, map);
	assert.deepEqual(group.layers, [["A"]]);
	map.view = tooWide;
	layer._fetch();
	assert.deepEqual(group.layers, []);
	assert.equal(layer._lastKey, null);
	map.view = a;
	layer._fetch();
	assert.deepEqual(group.layers, [["A"]]);
});

test("over-cap and below-min views invalidate pending vector tiles", () => {
	const requests = [];
	globalThis.GM_xmlhttpRequest = (req) => {
		const handle = { aborted: false, abort() { this.aborted = true; } };
		requests.push({ req, handle });
		return handle;
	};
	const map = mapAt(2, b);
	const layer = vectorLayer();
	const group = add(layer, map);
	assert.equal(requests.length, 1);
	map.view = tooWide;
	layer._fetch();
	assert.equal(requests[0].handle.aborted, true);
	// Even a late callback delivered after abort must not cache or paint the old tile.
	requests[0].req.onload({ status: 200, response: new ArrayBuffer(0) });
	assert.deepEqual(group.layers, []);
	assert.equal(layer._tileEls.size, 0);
	map.view = b;
	layer._fetch();
	assert.equal(requests.length, 2);
	map.zoom = 1;
	layer._onViewChange();
	assert.equal(requests[1].handle.aborted, true);
	requests[1].req.onload({ status: 200, response: new ArrayBuffer(0) });
	assert.deepEqual(group.layers, []);
	map.zoom = 2;
	layer._fetch();
	assert.equal(requests.length, 3);
	requests[2].req.onload({ status: 200, response: new ArrayBuffer(0) });
	assert.deepEqual(group.layers, [[]]);
});
