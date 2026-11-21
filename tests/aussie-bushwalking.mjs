// Run with `node --test tests/aussie-bushwalking.mjs`; source modules only, no network.
// The Aussie Bushwalking overlay: what it draws from a map tile and what it links to.
import test from "node:test";
import assert from "node:assert/strict";
import {
	abwDifficultyColor, abwPopupHtml, abwSummary, abwToElements, abwWalkUrl,
} from "../src/providers/aussie-bushwalking.js";

const walk = {
	Id: 606, Name: "Coobong Circuit", Url: "/qld/se-qld/parklands-con-park/coobong-circuit",
	Distance: "5.3km return", Difficulty: "Medium", Duration: "90 mins",
	Region: "Parklands Conservation Park, Queensland", Description: "A loop through open forest.",
};

test("tracks become lines and walks become one pin each", () => {
	const line = [{ lat: -26.6, lon: 152.9 }, { lat: -26.61, lon: 152.91 }];
	const tracks = abwToElements("abwTracks", walk, 2, [line, [{ lat: 0, lon: 0 }]]);
	assert.equal(tracks.length, 1, "a one-point fragment is dropped");
	assert.deepEqual([tracks[0].type, tracks[0].geometry, tracks[0].tags.Name], ["way", line, "Coobong Circuit"]);
	assert.equal(tracks[0]._id, undefined, "pieces of a track clipped by tile edges are all kept");

	const pins = abwToElements("abw", walk, 1, [[{ lat: -26.6, lon: 152.9 }]]);
	assert.deepEqual(pins, [{ type: "node", lat: -26.6, lon: 152.9, tags: walk, _id: "abw606" }]);
	assert.equal(abwToElements("abw", walk, 2, [line]), null, "wrong geometry for the layer");
	assert.equal(abwToElements("somethingElse", walk, 1, [[{ lat: 0, lon: 0 }]]), null);
	assert.equal(abwToElements("abw", { Name: "No id" }, 1, [[{ lat: 0, lon: 0 }]]), null);
});

test("links only ever point at the walk's own page on the site", () => {
	assert.equal(abwWalkUrl(walk.Url), "https://www.aussiebushwalking.com/qld/se-qld/parklands-con-park/coobong-circuit");
	for (const bad of ["https://evil.example/x", "//evil.example/x", "javascript:alert(1)", "/a b", "/x?next=//evil", "/x\"onmouseover=\"1", "", null]) {
		assert.equal(abwWalkUrl(bad), "", String(bad));
	}
});

test("pop-ups summarise the walk and escape what contributors wrote", () => {
	assert.equal(abwSummary(walk), "5.3km return · Medium · 90 mins");
	assert.equal(abwSummary({ Distance: "2km" }), "2km");
	const html = abwPopupHtml(walk);
	assert.match(html, /<b>Coobong Circuit<\/b>/);
	assert.match(html, /5\.3km return · Medium · 90 mins/);
	assert.match(html, /href="https:\/\/www\.aussiebushwalking\.com\/qld\/se-qld\/parklands-con-park\/coobong-circuit"/);
	assert.match(html, /rel="noopener noreferrer"/);

	const hostile = abwPopupHtml({ Id: 1, Name: "<img src=x onerror=alert(1)>", Description: "<script>x</script>" + "y".repeat(600), Url: "javascript:alert(1)" });
	assert.ok(!/<img|<script/.test(hostile), "markup from the tile is shown as text");
	assert.ok(!/href=/.test(hostile), "no link when the address isn't a site path");
	assert.ok(hostile.includes("…") && hostile.length < 900, "long descriptions are cut short");
	assert.match(abwPopupHtml({ Id: 2 }), /<b>Walk<\/b>/);
});

test("difficulty colours follow the site, with a neutral fallback", () => {
	assert.equal(abwDifficultyColor("Easy"), "#ac1c64");
	assert.equal(abwDifficultyColor("Very Hard"), "#231f20");
	assert.equal(abwDifficultyColor("Unrated"), "#6b7280");
	assert.equal(abwDifficultyColor(undefined), "#6b7280");
});
