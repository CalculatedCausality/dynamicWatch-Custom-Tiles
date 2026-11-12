// Run with `node --test tests/planner-toolbar.mjs`; source modules only, no network.
// Buttons the script adds to dynamic.watch's planner toolbar.
import test from "node:test";
import assert from "node:assert/strict";
import {
	hidePlannerButtonLabel, insertPlannerButton, setPlannerButtonLabel,
} from "../src/ui/planner-toolbar.js";

// Just enough DOM: child lists, siblings and whitespace text nodes.
class FakeNode {
	constructor(nodeType, label, nodeValue = null) {
		Object.assign(this, { nodeType, label, nodeValue, parentNode: null, childNodes: [] });
		this.classes = new Set();
		this.classList = { add: (name) => this.classes.add(name) };
	}
	get previousSibling() { const kids = this.parentNode.childNodes; return kids[kids.indexOf(this) - 1] || null; }
	get nextSibling() { const kids = this.parentNode.childNodes; return kids[kids.indexOf(this) + 1] || null; }
	insertBefore(node, ref) {
		node.parentNode = this;
		this.childNodes.splice(ref ? this.childNodes.indexOf(ref) : this.childNodes.length, 0, node);
		return node;
	}
	querySelector(selector) { return this.childNodes.find((n) => "." + n.label === selector) || null; }
	get ownerDocument() { return { createTextNode: (text) => new FakeNode(3, "ws", text) }; }
}
const el = (label) => new FakeNode(1, label);
const ws = () => new FakeNode(3, "ws", "\n    ");
const row = (...kids) => { const r = el("row"); kids.forEach((k) => r.insertBefore(k, null)); return r; };
const layout = (r) => r.childNodes.map((n) => n.label).join(" ");

test("script buttons get the same whitespace separators as dynamic.watch's own", () => {
	// The site's markup: every button on its own line, then the distance readout.
	const r = row(ws(), el("undo"), ws(), el("save"), ws(), el("elevation"), ws(), el("distance"), ws());
	insertPlannerButton(r, el("3d"));
	assert.equal(layout(r), "ws undo ws save ws elevation ws 3d ws distance ws");
	insertPlannerButton(r, el("poi"));
	assert.equal(layout(r), "ws undo ws save ws elevation ws 3d ws poi ws distance ws",
		"each button is separated from both neighbours exactly once");
	assert.ok(r.childNodes.filter((n) => n.nodeType === 3).every((n) => !/\S/.test(n.nodeValue)));
	const marked = r.childNodes.filter((n) => n.classes.has("dw-planner-btn")).map((n) => n.label);
	assert.deepEqual(marked, ["3d", "poi"], "only the script's buttons carry the narrow-screen class");
});

test("without a distance readout the buttons go at the end, still separated", () => {
	const r = row(ws(), el("undo"), ws(), el("save"), ws());
	insertPlannerButton(r, el("3d"));
	insertPlannerButton(r, el("poi"));
	assert.equal(layout(r), "ws undo ws save ws 3d ws poi");
});

test("a row whose own buttons are not whitespace-separated is left flush", () => {
	const r = row(el("undo"), el("save"), el("distance"));
	insertPlannerButton(r, el("3d"));
	insertPlannerButton(r, el("poi"));
	assert.equal(layout(r), "undo save 3d poi distance");
	const empty = row();
	insertPlannerButton(empty, el("3d"));
	assert.equal(layout(empty), "3d");
});

// A button with attributes and a `title`, and the site's jQuery tooltip:
// like Bootstrap's, setting one up moves `title` into `data-original-title`.
function fakeButton() {
	const attrs = new Map();
	return {
		title: "",
		setAttribute: (name, value) => attrs.set(name, String(value)),
		getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
	};
}
function fakeSite({ mobile = false, broken = false } = {}) {
	const calls = [];
	const jQuery = (el) => ({
		tooltip(arg) {
			calls.push(arg === undefined ? "init" : arg);
			if (broken) throw new Error("tooltip unavailable");
			if (arg === undefined) { el.setAttribute("data-original-title", el.title); el.title = ""; }
		},
	});
	jQuery.fn = { tooltip() {} };
	return { win: { jQuery, is_mobile: mobile }, calls };
}

test("script buttons get the site's own hover label, set up once and kept up to date", () => {
	const btn = fakeButton(), site = fakeSite();
	setPlannerButtonLabel(btn, "Find POIs along the route", site.win);
	assert.deepEqual(site.calls, ["init"]);
	assert.equal(btn.getAttribute("data-toggle"), "tooltip");
	assert.equal(btn.getAttribute("data-placement"), "top");
	assert.equal(btn.getAttribute("data-original-title"), "Find POIs along the route");
	assert.equal(btn.title, "", "no plain browser tooltip on top of the site's label");
	assert.equal(btn.getAttribute("aria-label"), "Find POIs along the route");

	setPlannerButtonLabel(btn, "Clear route POIs", site.win);
	assert.deepEqual(site.calls, ["init"], "not set up twice");
	assert.equal(btn.getAttribute("data-original-title"), "Clear route POIs");
	assert.equal(btn.getAttribute("aria-label"), "Clear route POIs");
	assert.equal(btn.title, "");

	hidePlannerButtonLabel(btn, site.win);
	assert.deepEqual(site.calls, ["init", "hide"]);
});

test("without the site's label code the button keeps a plain title", () => {
	// dynamic.watch doesn't set these labels up on mobile, so neither does the script.
	const mobile = fakeButton(), phone = fakeSite({ mobile: true });
	setPlannerButtonLabel(mobile, "Toggle 3D terrain", phone.win);
	assert.equal(mobile.title, "Toggle 3D terrain");
	assert.deepEqual(phone.calls, []);
	assert.equal(mobile.getAttribute("data-toggle"), null);
	hidePlannerButtonLabel(mobile, phone.win);
	assert.deepEqual(phone.calls, [], "nothing to hide");

	const bare = fakeButton();
	setPlannerButtonLabel(bare, "Toggle 3D terrain", {});
	assert.equal(bare.title, "Toggle 3D terrain");
	setPlannerButtonLabel(bare, "Changed", {});
	assert.equal(bare.title, "Changed");

	const failing = fakeButton(), site = fakeSite({ broken: true });
	setPlannerButtonLabel(failing, "Toggle 3D terrain", site.win);
	assert.equal(failing.title, "Toggle 3D terrain", "a failing tooltip call falls back to the title");
	assert.equal(failing.getAttribute("aria-label"), "Toggle 3D terrain");
});
