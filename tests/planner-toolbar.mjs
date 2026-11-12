// Run with `node --test tests/planner-toolbar.mjs`; source modules only, no network.
// Buttons the script adds to dynamic.watch's planner toolbar.
import test from "node:test";
import assert from "node:assert/strict";
import { insertPlannerButton } from "../src/ui/planner-toolbar.js";

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
