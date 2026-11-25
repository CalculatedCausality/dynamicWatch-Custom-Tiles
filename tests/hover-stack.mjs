// Run with `node --test tests/hover-stack.mjs`; source module only, no network.
import test from "node:test";
import assert from "node:assert/strict";

// Minimal Leaflet tooltip stand-in: records what the shared box shows.
const shown = [];
globalThis.L = {
	tooltip: (options) => ({
		options, _map: null, _html: "", _latlng: null,
		setLatLng(ll) { this._latlng = ll; return this; },
		setContent(h) { this._html = h; return this; },
		addTo(map) { this._map = map; shown.push(this); return this; },
		remove() { this._map = null; return this; },
	}),
};
const { hoverSlot, hoverStackHtml } = await import("../src/ui/hover-stack.js");

test("several overlays share one hover box, in a fixed order", () => {
	const map = {};
	const runner = hoverSlot({ className: "dw-intvl-tip", order: 10 });
	const suburb = hoverSlot({ className: "dw-qpws-tip" });
	const postcode = hoverSlot({ className: "dw-qpws-tip" });
	postcode.setLatLng([1, 2]).setContent("<b>Postcode 4558</b>"); postcode.addTo(map);
	suburb.setLatLng([1, 2]).setContent("<b>Maroochydore</b>"); suburb.addTo(map);
	runner.setLatLng([1, 2]).setContent("<b>Clayton</b>"); runner.addTo(map);
	assert.equal(shown.length, 1, "one real tooltip");
	const tip = shown[0];
	assert.ok(tip.options.className.includes("dw-hover-stack"));
	assert.deepEqual([...tip._html.matchAll(/<b>([^<]+)<\/b>/g)].map((m) => m[1]), ["Clayton", "Maroochydore", "Postcode 4558"],
		"runner first, then the others in the order their layers were set up, whatever order the answers came in");
	assert.equal(tip._html.split("dw-hover-sep").length - 1, 2, "a rule between each part");
	assert.ok(tip._html.includes('class="dw-hover-part dw-intvl-tip"'), "each part keeps its class");
	runner.remove();
	assert.ok(!tip._html.includes("Clayton") && tip._map, "a cleared slot leaves the rest showing");
	postcode.setContent("<b>Postcode 4560</b>");
	assert.ok(tip._html.includes("4560") && !tip._html.includes("4558"), "updates in place");
	postcode.remove(); suburb.remove();
	assert.equal(tip._map, null, "box closes when every slot is cleared");
	assert.equal(suburb._map, null);
});

test("empty slots add nothing; slot bookkeeping is per map", () => {
	const a = hoverSlot(), b = hoverSlot();
	b.setContent("x");
	assert.equal(hoverStackHtml([a]), "");
	assert.equal(hoverStackHtml([a, b]), '<div class="dw-hover-part">x</div>');
	const m1 = {}, m2 = {};
	const before = shown.length;
	hoverSlot().setLatLng([0, 0]).setContent("one").addTo(m1);
	hoverSlot().setLatLng([0, 0]).setContent("two").addTo(m2);
	assert.equal(shown.length - before, 2, "each map has its own box");
});
