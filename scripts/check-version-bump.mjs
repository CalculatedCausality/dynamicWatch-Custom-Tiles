#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const BUNDLE = "dynamicwatch-custom-tiles.user.js";

export function parseVersion(version) {
	const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?$/.exec(version);
	if (!match || (match[4] && match[4].split(".").some(part => /^0\d+$/.test(part)))) {
		throw new Error(`Invalid semver: ${JSON.stringify(version)}. Use a version such as 7.14.1.`);
	}
	return { core: match.slice(1, 4).map(BigInt), prerelease: match[4]?.split(".") ?? [] };
}

export function compareSemver(left, right) {
	const a = parseVersion(left);
	const b = parseVersion(right);
	for (let i = 0; i < 3; i++) {
		if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1;
	}
	if (!a.prerelease.length || !b.prerelease.length) {
		return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1;
	}
	for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
		const x = a.prerelease[i];
		const y = b.prerelease[i];
		if (x === y) continue;
		if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
		const xn = /^\d+$/.test(x);
		const yn = /^\d+$/.test(y);
		if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1;
		if (xn !== yn) return xn ? -1 : 1;
		return x > y ? 1 : -1;
	}
	return 0;
}

export function readBundleVersion(text) {
	const header = text.match(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/);
	const version = header?.[0].match(/^\/\/\s*@version\s+(\S+)\s*$/m)?.[1];
	if (!version) throw new Error(`Missing @version in ${BUNDLE}'s userscript header.`);
	parseVersion(version);
	return version;
}

export function extractReleaseNotes(readmeText, version) {
	const lines = readmeText.split(/\r?\n/);
	const start = lines.findIndex(line => line.trimEnd() === `### Release notes — ${version}`);
	if (start === -1) return "";
	const bullets = [];
	let inBullet = false;
	for (const line of lines.slice(start + 1)) {
		if (/^\s{0,3}#{1,6}(?:\s|$)/.test(line)) break;
		if (/^\s*[-+*]\s+\S/.test(line)) {
			bullets.push(line);
			inBullet = true;
		} else if (inBullet && /^\s+\S/.test(line)) {
			bullets.push(line);
		} else {
			inBullet = false;
		}
	}
	return bullets.join("\n").trim();
}

export function checkVersionBump({ baseRef = "origin/main", cwd = process.cwd() } = {}) {
	const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	let base;
	try {
		base = git("rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`).trim();
	} catch {
		return { skipped: true, message: `Skipping version check: base ref ${JSON.stringify(baseRef)} cannot be resolved. Fetch it to enable the check.` };
	}
	if (!git("diff", "--name-only", base, "HEAD", "--", BUNDLE).trim()) {
		return { skipped: false, message: "Version check passed: committed userscript bundle is unchanged." };
	}
	const oldVersion = readBundleVersion(git("show", `${base}:${BUNDLE}`));
	const newVersion = readBundleVersion(git("show", `HEAD:${BUNDLE}`));
	if (compareSemver(newVersion, oldVersion) <= 0) {
		throw new Error(`Bundle changed, but @version ${newVersion} is not higher than ${oldVersion}. Bump src/userscript-header.txt, rebuild, and commit the generated files.`);
	}
	const notes = extractReleaseNotes(git("show", "HEAD:README.md"), newVersion);
	if (!notes) throw new Error(`Add a "### Release notes — ${newVersion}" section with at least one bullet to README.md and commit it.`);
	return { skipped: false, message: `Version check passed: ${oldVersion} → ${newVersion}, with release notes.` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try {
		const args = process.argv.slice(2);
		if (args.length && (args.length !== 2 || args[0] !== "--base" || !args[1])) {
			throw new Error("Usage: node scripts/check-version-bump.mjs [--base <git ref>]");
		}
		console.log(checkVersionBump({ baseRef: args[1] }).message);
	} catch (error) {
		console.error(`Version check failed: ${error.message}`);
		process.exitCode = 1;
	}
}
