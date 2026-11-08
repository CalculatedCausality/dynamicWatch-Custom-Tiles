#!/usr/bin/env node
// Rebuild the userscript and fail if the committed bundle or meta file differ
// from source. Run before pushing; CI runs it on every push and pull request.
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FILES = ["dynamicwatch-custom-tiles.user.js", "dynamicwatch-custom-tiles.meta.js"];

execFileSync(process.execPath, [join(ROOT, "scripts", "build-userscript.mjs")], { cwd: ROOT, stdio: "inherit" });
// `git status` also reports a generated file that was never committed.
const changed = execFileSync("git", ["status", "--porcelain", "--", ...FILES], { cwd: ROOT, encoding: "utf8" }).trim();
if (changed) {
	console.error(changed);
	console.error("The committed userscript is out of date with src/. Commit the rebuilt files above.");
	process.exit(1);
}
console.log("Committed userscript matches a fresh build.");
