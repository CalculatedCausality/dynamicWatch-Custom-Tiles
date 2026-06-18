#!/usr/bin/env node

import * as esbuild from "esbuild";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HEADER_PATH = join(ROOT, "src", "userscript-header.txt");
const ENTRY_PATH = join(ROOT, "src", "main.js");
const OUT_PATH = join(ROOT, "dynamicwatch-custom-tiles.user.js");

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

console.log("Built ESM bundle -> dynamicwatch-custom-tiles.user.js");
