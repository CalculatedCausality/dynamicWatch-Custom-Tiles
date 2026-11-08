import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkVersionBump, compareSemver, extractReleaseNotes, parseVersion, readBundleVersion } from "../scripts/check-version-bump.mjs";

const checkScript = fileURLToPath(new URL("../scripts/check-version-bump.mjs", import.meta.url));
const notesScript = fileURLToPath(new URL("../scripts/release-notes.mjs", import.meta.url));
const bundle = (version, body = "// original") => `// ==UserScript==\n// @version      ${version}\n// ==/UserScript==\n${body}\n`;
const notes = version => `# Test\n\n### Release notes — ${version}\n- Updated the userscript.\n`;

function repository(t) {
	const cwd = mkdtempSync(join(tmpdir(), "release-scripts-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	git("init");
	const commit = (version, readme = notes(version), body) => {
		writeFileSync(join(cwd, "dynamicwatch-custom-tiles.user.js"), bundle(version, body));
		writeFileSync(join(cwd, "README.md"), readme);
		git("add", ".");
		git("-c", "user.email=t@example.invalid", "-c", "user.name=test", "commit", "-m", `Test ${version}`);
		return git("rev-parse", "HEAD");
	};
	const baseRef = commit("1.0.0");
	return { cwd, baseRef, commit };
}

test("unchanged committed bundle passes, ignoring working-tree edits", t => {
	const { cwd, baseRef } = repository(t);
	writeFileSync(join(cwd, "dynamicwatch-custom-tiles.user.js"), bundle("0.1.0"));
	assert.match(checkVersionBump({ cwd, baseRef }).message, /unchanged/);
});

test("changed bundle without version bump fails with actionable guidance", t => {
	const { cwd, baseRef, commit } = repository(t);
	commit("1.0.0", notes("1.0.0"), "// changed");
	assert.throws(() => checkVersionBump({ cwd, baseRef }), /Bump src\/userscript-header.txt/);
	const result = spawnSync(process.execPath, [checkScript, "--base", baseRef], { cwd, encoding: "utf8" });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Version check failed/);
});

test("version bump without matching notes fails, even with uncommitted notes", t => {
	const { cwd, baseRef, commit } = repository(t);
	commit("1.1.0", notes("1.0.0"));
	writeFileSync(join(cwd, "README.md"), notes("1.1.0"));
	assert.throws(() => checkVersionBump({ cwd, baseRef }), /Release notes — 1\.1\.0/);
});

test("version bump with an empty release-notes section fails", t => {
	const { cwd, baseRef, commit } = repository(t);
	commit("1.1.0", "### Release notes — 1.1.0\nSome prose, but no bullets.\n");
	assert.throws(() => checkVersionBump({ cwd, baseRef }), /at least one bullet/);
});

test("version bump with notes passes", t => {
	const { cwd, baseRef, commit } = repository(t);
	commit("1.1.0");
	assert.match(checkVersionBump({ cwd, baseRef }).message, /1\.0\.0 → 1\.1\.0, with release notes/);
	const result = spawnSync(process.execPath, [checkScript, "--base", baseRef], { cwd, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Version check passed/);
});

test("lower version fails", t => {
	const { cwd, baseRef, commit } = repository(t);
	commit("0.9.0");
	assert.throws(() => checkVersionBump({ cwd, baseRef }), /not higher than 1\.0\.0/);
});

test("unresolvable bases skip, including all-zero SHAs and missing origin/main", t => {
	const { cwd } = repository(t);
	for (const baseRef of ["missing-ref", "0".repeat(40), "origin/main"]) {
		const result = checkVersionBump({ cwd, baseRef });
		assert.equal(result.skipped, true);
		assert.match(result.message, /Skipping version check/);
	}
	const cli = spawnSync(process.execPath, [checkScript], { cwd, encoding: "utf8" });
	assert.equal(cli.status, 0, cli.stderr);
	assert.match(cli.stdout, /Skipping version check/);
});

test("extractReleaseNotes selects an exact version and stops at the next heading", () => {
	const readme = `### Release notes — 1.2.30\n- Not this version.\n### Release notes — 1.2.3\nIntroductory prose.\n\n- First change.\n  Wrapped detail.\n* Second change.\n\n#### Other heading\n- Excluded.\n### Release notes — 1.0.0\n- Older.\n`;
	assert.equal(extractReleaseNotes(readme, "1.2.3"), "- First change.\n  Wrapped detail.\n* Second change.");
	assert.equal(extractReleaseNotes(readme, "1.2.4"), "");
	assert.equal(extractReleaseNotes("### Release notes — 1.2.3\n\n- \n", "1.2.3"), "");
	assert.equal(extractReleaseNotes(readme.replaceAll("\n", "\r\n"), "1.0.0"), "- Older.");
});

test("release-notes CLI prints only bullets and rejects missing, empty or invalid versions", t => {
	const { cwd } = repository(t);
	const run = (...args) => spawnSync(process.execPath, [notesScript, ...args], { cwd, encoding: "utf8" });
	const success = run("1.0.0");
	assert.equal(success.status, 0, success.stderr);
	assert.equal(success.stdout, "- Updated the userscript.\n");
	for (const args of [["2.0.0"], [], ["invalid"], ["1.0.0", "extra"]]) {
		const failure = run(...args);
		assert.equal(failure.status, 1);
		assert.equal(failure.stdout, "");
		assert.match(failure.stderr, /Release notes failed/);
	}
	writeFileSync(join(cwd, "README.md"), "### Release notes — 1.0.0\nNo bullets.\n");
	assert.equal(run("1.0.0").status, 1);
});

test("semver comparison handles numeric components, prereleases and build metadata", () => {
	const ordered = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.2.0", "1.10.0", "2.0.0"];
	for (let i = 1; i < ordered.length; i++) {
		assert.equal(compareSemver(ordered[i - 1], ordered[i]), -1);
		assert.equal(compareSemver(ordered[i], ordered[i - 1]), 1);
	}
	assert.equal(compareSemver("1.0.0+one", "1.0.0+two"), 0);
	for (const invalid of ["1.2", "01.2.3", "1.2.3-01", "v1.2.3", "1.2.3-"]) {
		assert.throws(() => parseVersion(invalid), /Invalid semver/);
	}
	assert.equal(readBundleVersion(bundle("7.14.0")), "7.14.0");
	assert.throws(() => readBundleVersion("// @version 1.2.3"), /Missing @version/);
});
