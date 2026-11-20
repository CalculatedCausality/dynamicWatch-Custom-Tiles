// Run with `node --test tests/mode-3d-sync.mjs`; source modules only, no network.
// How 3D Mode decides what to rebuild when Leaflet layers change.
import test from "node:test";
import assert from "node:assert/strict";
import {
	describeMapError, layerMoves, planRasterOverlays, rasterKey,
} from "../src/runtime/mode-3d-sync.js";

const spec = (url, extra = {}) => ({ url, maxzoom: 18, opacity: 1, zIndex: 300, ...extra });
const existing = (...entries) => new Map(entries.map(([s, id]) => [rasterKey(s), { id, opacity: s.opacity }]));

test("an unchanged overlay is kept; only what changed is added or removed", () => {
	const sea = spec("https://tiles.example/sea/{z}/{x}/{y}.png");
	const heat = spec("https://dwtile.local/lyr4/{z}/{x}/{y}.png", { opacity: 0.8 });
	const cover = spec("https://cover.example/{z}/{x}/{y}.png");

	const first = planRasterOverlays(new Map(), [sea]);
	assert.deepEqual([first.remove.length, first.keep.length, first.add.map((a) => a.spec)], [0, 0, [sea]]);

	const second = planRasterOverlays(existing([sea, "dw-overlay-1"]), [sea, heat]);
	assert.deepEqual(second.keep.map((k) => k.entry.id), ["dw-overlay-1"], "the first overlay stays");
	assert.deepEqual(second.add.map((a) => a.spec), [heat]);
	assert.equal(second.remove.length, 0);
	assert.deepEqual(second.order, [rasterKey(sea), rasterKey(heat)], "bottom-up draw order follows the specs");

	const swapped = planRasterOverlays(existing([sea, "dw-overlay-1"], [heat, "dw-overlay-2"]), [heat, cover]);
	assert.deepEqual(swapped.remove.map((r) => r.entry.id), ["dw-overlay-1"]);
	assert.deepEqual(swapped.keep.map((k) => k.entry.id), ["dw-overlay-2"]);
	assert.deepEqual(swapped.add.map((a) => a.spec), [cover]);

	const none = planRasterOverlays(existing([sea, "dw-overlay-1"]), []);
	assert.deepEqual(none.remove.map((r) => r.entry.id), ["dw-overlay-1"]);
	assert.deepEqual(none.order, []);
});

test("a changed URL or zoom limit, or a forced pass, rebuilds the source", () => {
	const old = spec("https://qld.example/tiles/{z}/{x}/{y}?token=AAA");
	const rotated = spec("https://qld.example/tiles/{z}/{x}/{y}?token=BBB");
	const plan = planRasterOverlays(existing([old, "dw-overlay-1"]), [rotated]);
	assert.deepEqual([plan.remove.length, plan.keep.length, plan.add.length], [1, 0, 1], "a rotated token is a new source");

	assert.notEqual(rasterKey(spec("u", { maxzoom: 16 })), rasterKey(spec("u", { maxzoom: 18 })));
	assert.equal(rasterKey(spec("u", { opacity: 0.4 })), rasterKey(spec("u", { opacity: 0.9 })),
		"opacity is changed in place, not by rebuilding");
	const dimmer = planRasterOverlays(existing([old, "dw-overlay-1"]), [{ ...old, opacity: 0.5 }]);
	assert.equal(dimmer.keep[0].spec.opacity, 0.5, "the kept entry carries the wanted spec");

	// A layer whose tiles changed behind the same URL (a new capture date).
	const forced = planRasterOverlays(existing([old, "dw-overlay-1"]), [old], true);
	assert.deepEqual([forced.remove.length, forced.keep.length, forced.add.length], [1, 0, 1]);

	const twice = planRasterOverlays(new Map(), [old, { ...old }]);
	assert.equal(twice.add.length, 1, "two layers with the same tiles mirror once");
	assert.equal(rasterKey(null), "");
});

// Apply moves to a list the way Mapbox's moveLayer(id, beforeId) does.
function apply(order, moves) {
	const list = [...order];
	for (const [id, before] of moves) {
		list.splice(list.indexOf(id), 1);
		if (before === undefined) list.push(id);
		else list.splice(list.indexOf(before), 0, id);
	}
	return list;
}

test("layer moves produce the wanted stacking from any starting order", () => {
	const want = ["bg", "active-base", "dw-overlay-2", "dw-overlay-1", "dw-shapes-point-x", "dw-route-line", "sky"];
	const starts = [
		want,
		[...want].reverse(),
		["bg", "dw-overlay-1", "dw-route-line", "active-base", "sky", "dw-shapes-point-x", "dw-overlay-2"],
		["sky", "dw-route-line", "bg", "dw-overlay-2", "active-base", "dw-overlay-1", "dw-shapes-point-x"],
	];
	for (const start of starts) {
		const moves = layerMoves(want, (id) => start.includes(id));
		assert.deepEqual(apply(start, moves), want, "from " + start.join(" > "));
	}
	// Layers that don't exist are skipped, and the rest still end up in order.
	const partial = ["dw-route-line", "sky", "bg", "dw-overlay-1"];
	assert.deepEqual(apply(partial, layerMoves(want, (id) => partial.includes(id))),
		["bg", "dw-overlay-1", "dw-route-line", "sky"]);
	// Other layers keep their place below the ones being ordered.
	const extra = ["bg", "someone-elses-layer", "sky", "active-base"];
	const ordered = apply(extra, layerMoves(want, (id) => extra.includes(id) && id !== "someone-elses-layer"));
	assert.deepEqual(ordered.filter((id) => id !== "someone-elses-layer"), ["bg", "active-base", "sky"]);
	assert.deepEqual(layerMoves(want, () => false), []);
	assert.deepEqual(layerMoves(["a", "a", "b"], () => true), [["b", undefined], ["a", "b"]], "duplicates are moved once");
});

test("map errors are reported briefly and without tokens", () => {
	const tile = describeMapError({
		sourceId: "active-base",
		error: new Error("Not Found: https://a.tile.example/outdoors/12/3789/2363@2x.png?apikey=SECRETKEY123 (404)"),
	});
	assert.equal(tile.text, "active-base: Not Found: https://a.tile.example/outdoors/12/3789/2363@2x.png (404)");
	assert.ok(!tile.text.includes("SECRETKEY123") && !tile.key.includes("SECRETKEY123"));
	const again = describeMapError({ sourceId: "active-base", error: new Error("Not Found: https://a.tile.example/outdoors/12/3789/2363@2x.png?apikey=OTHER (404)") });
	assert.equal(again.key, tile.key, "the same fault with another token groups together");
	assert.notEqual(describeMapError({ sourceId: "dw-overlay-1", error: new Error("x") }).key, describeMapError({ error: new Error("x") }).key);
	assert.equal(describeMapError({}).text, "unknown error");
	assert.equal(describeMapError(null).text, "unknown error");
	assert.equal(describeMapError({ error: new Error("a".repeat(500)) }).text.length, 200);
});
