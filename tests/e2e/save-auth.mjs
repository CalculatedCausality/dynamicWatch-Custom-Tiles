#!/usr/bin/env node
// Interactive auth state capture.
//
// dynamic.watch's planner is gated behind a login — without a session
// cookie, /plan redirects to /users/sign_in and there's no Leaflet map
// for the userscript to hook. This script opens a real Chromium window,
// waits for the user to log in by hand, then dumps the cookies + storage
// to `.auth/storage.json` for headless runs to reuse.
//
// Run once:
//     npm run e2e:auth
// Then every `npm run e2e:check` will reuse the same logged-in state
// until the session expires (typically several days). Re-run when the
// runner reports "redirected to sign_in".
import { chromium } from "playwright";
import { mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const AUTH_DIR  = resolve(REPO_ROOT, ".auth");
const STATE_PATH = resolve(AUTH_DIR, "storage.json");

if (!existsSync(AUTH_DIR)) mkdirSync(AUTH_DIR, { recursive: true });

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page    = await context.newPage();
await page.goto("https://dynamic.watch/users/sign_in", { waitUntil: "domcontentloaded" });

console.log("");
console.log("==============================================================");
console.log("  Log in to dynamic.watch in the opened browser window.");
console.log("  Once you're back on the planner (/plan), press ENTER here.");
console.log("==============================================================");
console.log("");

// Wait for user to hit ENTER in this terminal
process.stdin.setRawMode?.(true);
await new Promise((resolve) => {
	const onData = (chunk) => {
		const ch = chunk[0];
		// CR (13) or LF (10) or Ctrl-C (3)
		if (ch === 3) { console.log("Aborted."); process.exit(1); }
		if (ch === 13 || ch === 10) {
			process.stdin.off("data", onData);
			process.stdin.setRawMode?.(false);
			resolve();
		}
	};
	process.stdin.on("data", onData);
});

await context.storageState({ path: STATE_PATH });
console.log(`Saved auth state to ${STATE_PATH}`);
await browser.close();
process.exit(0);
