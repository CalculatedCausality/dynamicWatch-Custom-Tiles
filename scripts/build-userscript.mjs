#!/usr/bin/env node

import * as esbuild from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HEADER_PATH = join(ROOT, "src", "userscript-header.txt");
const ENTRY_PATH = join(ROOT, "src", "main.js");
const OUT_PATH = join(ROOT, "dynamicwatch-custom-tiles.user.js");
// Tampermonkey polls @updateURL for a newer @version; serving just the header
// keeps that check tiny, and it only downloads @downloadURL when needed.
const META_PATH = join(ROOT, "dynamicwatch-custom-tiles.meta.js");

const header = readFileSync(HEADER_PATH, "utf8").trimEnd();

await esbuild.build({
	entryPoints: [ENTRY_PATH],
	bundle: true,
	outfile: OUT_PATH,
	format: "iife",
	target: "es2020",
	charset: "utf8",
	legalComments: "none",
	banner: { js: header },
	logLevel: "silent",
});

writeFileSync(META_PATH, header + "\n");

console.log("Built ESM bundle -> dynamicwatch-custom-tiles.user.js (+ .meta.js)");
