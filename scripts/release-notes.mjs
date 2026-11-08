#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { extractReleaseNotes, parseVersion } from "./check-version-bump.mjs";

try {
	if (process.argv.length !== 3) throw new Error("Usage: node scripts/release-notes.mjs <version>");
	const version = process.argv[2];
	parseVersion(version);
	const notes = extractReleaseNotes(readFileSync("README.md", "utf8"), version);
	if (!notes) throw new Error(`README.md has no release-notes bullets under "### Release notes — ${version}".`);
	console.log(notes);
} catch (error) {
	console.error(`Release notes failed: ${error.message}`);
	process.exitCode = 1;
}
