#!/usr/bin/env node
// Waze Traffic layer verification — proves the reCAPTCHA token broker AND
// the render path actually work in a real browser (the one thing no
// terminal probe can confirm).
//
// WHY THIS IS SHAPED IN TWO PHASES:
//   Waze gates /live-map/api/georss behind a reCAPTCHA Enterprise token
//   that must be minted in a *.waze.com origin (see src/providers/
//   waze-token.js). Two things can independently break: (a) minting a
//   token the endpoint accepts, and (b) parsing + rendering the response.
//   The Playwright GM shim can't replicate Tampermonkey's cross-origin
//   shared GM storage (it's localStorage, per-origin), so we test the two
//   halves directly instead of faking the shared-storage bridge:
//
//   Phase 1 (no auth) — load https://embed.waze.com/iframe, let the
//     userscript's broker run there, and confirm BOTH that it publishes a
//     token to GM storage AND that a freshly-minted token actually returns
//     200 + data from georss (validated server-side via node:https, which
//     — unlike browser fetch — can set Referer).
//
//   Phase 2 (needs dynamic.watch auth) — seed that real token as the
//     manual override, enable the Waze overlay on a real plan, and assert
//     alerts/jams/wazers render into dwWazePane with sane tooltips.
//
// reCAPTCHA scores automated browsers low, so a headless run MAY get a
// token that georss rejects. If Phase 1 can't get a 200, re-run headed:
//     HEADED=1 node tests/e2e/verify-waze.mjs
//
// Run:
//     node tests/e2e/verify-waze.mjs
//     HEADED=1 node tests/e2e/verify-waze.mjs   # watch it
import { chromium } from "playwright";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import https from "node:https";

const __dirname  = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = resolve(__dirname, "..", "..");
const SCRIPT_SRC = resolve(REPO_ROOT, "dynamicwatch-custom-tiles.user.js");
const BOOTSTRAP  = resolve(__dirname, "lib", "bootstrap.js");
const STATE_PATH = resolve(REPO_ROOT, ".auth", "storage.json");
const REPORT_DIR = resolve(REPO_ROOT, "test-results");

const HEADED = !!process.env.HEADED;
const SITE_KEY = "6Lf4WdUqAAAAAEUYUvzyLYIkO3PoFAqi8ZHGiDLW";
const ACTION   = "api";
const EMBED_URL = "https://embed.waze.com/iframe?zoom=13&lat=-36.785&lon=174.728";
const PLAN = process.env.PLAN || "/plan";
const DW_URL = "https://dynamic.watch" + PLAN;

// A bbox we know carries alerts + a jam + wazers (the user's original
// Auckland curl). env=row for the rest-of-world shard.
const BBOX = { top: -36.7533, bottom: -36.8169, left: 174.6793, right: 174.7781, env: "row" };
const georssUrl = (b) =>
	"https://www.waze.com/live-map/api/georss" +
	`?top=${b.top}&bottom=${b.bottom}&left=${b.left}&right=${b.right}` +
	`&env=${b.env}&types=alerts,traffic,users`;

// Validate a token server-side. node:https can set Referer (browser fetch
// can't), so this mirrors exactly what real Tampermonkey GM_xmlhttpRequest
// sends. Resolves { status, keys, counts } or { status, error }.
function georssWithToken(token) {
	return new Promise((res) => {
		const req = https.get(georssUrl(BBOX), {
			headers: {
				"Accept": "application/json, text/plain, */*",
				"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0",
				"Referer": "https://www.waze.com/live-map",
				"X-Recaptcha-Token": token,
			},
		}, (r) => {
			let buf = "";
			r.on("data", (d) => (buf += d));
			r.on("end", () => {
				if (r.statusCode !== 200) { res({ status: r.statusCode }); return; }
				try {
					const j = JSON.parse(buf);
					res({
						status: 200,
						counts: {
							alerts: (j.alerts || []).length,
							jams:   (j.jams   || []).length,
							users:  (j.users  || []).length,
						},
					});
				} catch (e) { res({ status: 200, error: "parse: " + e.message }); }
			});
		});
		req.on("error", (e) => res({ status: 0, error: e.message }));
		req.setTimeout(20000, () => { req.destroy(); res({ status: 0, error: "timeout" }); });
	});
}

const bootstrap  = readFileSync(BOOTSTRAP, "utf8");
const userscript = readFileSync(SCRIPT_SRC, "utf8");
if (!existsSync(REPORT_DIR)) mkdirSync(REPORT_DIR, { recursive: true });

let phase1 = { ok: false };
let phase2 = { skipped: true };

// ====================================================================
// PHASE 1 — broker mints a georss-valid token on embed.waze.com
// ====================================================================
{
	console.log(`\n=== Phase 1: token broker @ embed.waze.com ${HEADED ? "(headed)" : ""} ===`);
	const browser = await chromium.launch({
		headless: !HEADED,
		args: ["--disable-web-security", "--disable-features=IsolateOrigins,site-per-process"],
	});
	const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
	await context.addInitScript({ content: bootstrap });
	await context.addInitScript({ content: userscript });

	const page = await context.newPage();
	const errors = [];
	page.on("pageerror", (e) => errors.push(e.message));

	try {
		console.log(`→ ${EMBED_URL}`);
		await page.goto(EMBED_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });

		// (a) does the page's grecaptcha load at all?
		const hasGre = await page.waitForFunction(
			() => !!(window.grecaptcha && window.grecaptcha.enterprise &&
				typeof window.grecaptcha.enterprise.execute === "function"),
			{ timeout: 30_000 },
		).then(() => true).catch(() => false);
		console.log(`  grecaptcha.enterprise present: ${hasGre ? "✓" : "✗"}`);

		// (b) did OUR broker publish a shared token to GM storage?
		//     (GM shim → localStorage under "GM:" prefix)
		const brokerToken = await page.waitForFunction(() => {
			const raw = localStorage.getItem("GM:dw_waze_token_shared");
			if (!raw) return null;
			try { const o = JSON.parse(JSON.parse(raw)); return o && o.token ? o.token : null; }
			catch (_) { return null; }
		}, { timeout: 30_000 }).then((h) => h.jsonValue()).catch(() => null);
		console.log(`  broker published shared token: ${brokerToken ? "✓ (" + brokerToken.slice(0, 16) + "…)" : "✗"}`);

		// (c) directly mint one too, as the token we validate (belt +
		//     braces — if the broker timing flaked we still get to test
		//     georss acceptance).
		const directToken = await page.evaluate(({ key, action }) =>
			new Promise((res) => {
				const g = window.grecaptcha && window.grecaptcha.enterprise;
				if (!g) return res(null);
				g.ready(() => g.execute(key, { action }).then((t) => res(t || null), () => res(null)));
			}), { key: SITE_KEY, action: ACTION }).catch(() => null);
		console.log(`  direct mint on embed origin:   ${directToken ? "✓" : "✗"}`);

		// (d) THE assertion that matters: does a minted token get 200+data?
		const token = brokerToken || directToken;
		let georss = { status: null };
		if (token) {
			georss = await georssWithToken(token);
			console.log(`  georss with token → HTTP ${georss.status}` +
				(georss.counts ? `  alerts=${georss.counts.alerts} jams=${georss.counts.jams} users=${georss.counts.users}` : "") +
				(georss.error ? `  (${georss.error})` : ""));
		}

		// Two independent things are being checked here:
		//   codeOk   — OUR broker minted a correct-origin token and
		//              published it to GM storage. This is what can
		//              regress in the code; it works headless or headed.
		//   accepted — georss returned 200 for that token. reCAPTCHA
		//              scores automated browsers low, so this only
		//              reliably passes HEADED (a real, non-bot browser);
		//              a 403 here headless is expected, not a bug.
		const codeOk   = !!(hasGre && brokerToken);
		const accepted = georss.status === 200 && !georss.error;
		phase1 = {
			ok: codeOk && (accepted || (!HEADED && georss.status === 403)),
			codeOk, accepted,
			hasGre, brokerToken: !!brokerToken, directToken: !!directToken,
			georssStatus: georss.status, counts: georss.counts,
			token: accepted ? token : null, // only seed phase 2 with a real one
		};
	} catch (e) {
		phase1 = { ok: false, error: e.message };
		console.log(`  phase 1 error: ${e.message}`);
	}
	if (errors.length) {
		console.log("  page errors:");
		for (const e of errors.slice(-5)) console.log(`    ${e}`);
	}
	await browser.close();
}

// ====================================================================
// PHASE 2 — render path on dynamic.watch (needs auth + a real token)
// ====================================================================
if (!existsSync(STATE_PATH)) {
	console.log("\n=== Phase 2: SKIPPED — no .auth/storage.json (run `npm run e2e:auth`) ===");
} else if (!phase1.token) {
	// No georss-accepted token to seed — headless reCAPTCHA gave a
	// low-score token georss rejects. The render path can't be exercised
	// without a valid token, so skip rather than assert on an empty layer.
	console.log("\n=== Phase 2: SKIPPED — no georss-accepted token (re-run with HEADED=1) ===");
} else {
	console.log(`\n=== Phase 2: render @ dynamic.watch ${HEADED ? "(headed)" : ""} ===`);
	const browser = await chromium.launch({
		headless: !HEADED,
		args: ["--disable-web-security", "--disable-features=IsolateOrigins,site-per-process"],
	});
	const context = await browser.newContext({
		storageState: STATE_PATH, viewport: { width: 1600, height: 1000 },
	});

	// The GM-shim fetch drops Referer; re-add it on georss at the network
	// layer (same trick as verify-geocaches). Also lets us confirm the
	// request actually fired and with our token header.
	let georssReqs = 0, georss200 = 0;
	await context.route(/www\.waze\.com\/live-map\/api\/georss/, async (route) => {
		georssReqs++;
		const req = route.request();
		const headers = { ...req.headers(), referer: "https://www.waze.com/live-map" };
		try {
			const resp = await route.fetch({ headers });
			if (resp.status() === 200) georss200++;
			await route.fulfill({ response: resp });
		} catch (_) { try { await route.abort(); } catch (_) {} }
	});

	await context.addInitScript({ content: bootstrap });
	await context.addInitScript({ content: userscript });

	const page = await context.newPage();
	const errors = [];
	page.on("pageerror", (e) => errors.push(e.message));

	try {
		await page.goto(DW_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
		if (page.url().includes("/users/sign_in")) {
			console.log("  redirected to sign_in — auth expired. Run `npm run e2e:auth`.");
			phase2 = { skipped: true, reason: "auth expired" };
		} else {
			await page.waitForSelector(".leaflet-planner-controls", { timeout: 30_000 });
			await page.evaluate(() => {
				document.querySelectorAll(".modal,.modal-backdrop").forEach((el) => el.remove());
				document.body.classList.remove("modal-open");
				document.body.style.overflow = "";
			});
			await page.waitForFunction(
				() => !!(window._dwLayerCtrl && window._dwLayerCtrl._map), { timeout: 15_000 });

			// Seed the real token as the manual override BEFORE the layer
			// fetches, so getWazeToken() short-circuits to it (no iframe
			// broker needed — that half is covered by phase 1). GM_setValue
			// stores JSON.stringify(value), so wrap the string.
			await page.evaluate((tok) => {
				localStorage.setItem("GM:dw_waze_token_manual", JSON.stringify(tok));
			}, phase1.token);

			// Move to the data-rich Auckland bbox at z13 (layer minZoom 9).
			await page.evaluate(() => {
				const map = window._dwLayerCtrl._map;
				map.setView([-36.785, 174.728], 13);
			});
			await page.waitForTimeout(500);

			const enabled = await page.evaluate(() => {
				const ctrl = window._dwLayerCtrl;
				const entry = ctrl._layers.find((l) => l.name === "Waze Traffic" && l.overlay);
				if (!entry) {
					const all = ctrl._layers.filter((l) => l.overlay).map((l) => l.name);
					return { ok: false, reason: `not in registry; have: ${all.join(", ")}` };
				}
				if (!ctrl._map.hasLayer(entry.layer)) ctrl._map.addLayer(entry.layer);
				return { ok: true };
			});
			if (!enabled.ok) {
				phase2 = { ok: false, reason: enabled.reason };
				console.log(`  ✗ could not enable Waze Traffic: ${enabled.reason}`);
			} else {
				console.log("  ✓ Waze Traffic overlay enabled");
				// debounced fetch (400ms) + token read + georss + render.
				await page.waitForTimeout(6000);

				const result = await page.evaluate(() => {
					const map = window._dwLayerCtrl._map;
					let markers = 0, lines = 0, circles = 0, sampleTip = null;
					map.eachLayer(function visit(lyr) {
						if (lyr.eachLayer && !(lyr instanceof L.Marker) &&
							!(lyr instanceof L.Path)) { lyr.eachLayer(visit); return; }
						if (lyr.options?.pane !== "dwWazePane") return;
						if (lyr instanceof L.Marker) markers++;
						else if (lyr instanceof L.Polyline && !(lyr instanceof L.Polygon)) lines++;
						else if (lyr instanceof L.CircleMarker) circles++;
						if (!sampleTip) {
							const tt = lyr.getTooltip?.();
							if (tt) sampleTip = tt.getContent();
						}
					});
					const pane = map.getPane("dwWazePane");
					const domNodes = pane ? pane.childElementCount : -1;
					return { markers, lines, circles, sampleTip, domNodes };
				});

				const stamp = new Date().toISOString().replace(/[:.]/g, "-");
				const shot = resolve(REPORT_DIR, `verify-waze-${stamp}.png`);
				await page.evaluate(() => {
					document.querySelectorAll(".modal,.modal-backdrop").forEach((el) => el.remove());
				});
				await page.screenshot({ path: shot });

				const total = result.markers + result.lines + result.circles;
				phase2 = {
					ok: georss200 > 0 && total > 0,
					georssReqs, georss200, ...result, screenshot: shot, skipped: false,
				};
				console.log(`  georss requests / 200s:  ${georssReqs} / ${georss200}`);
				console.log(`  dwWazePane markers:       ${result.markers} (alerts)`);
				console.log(`  dwWazePane polylines:     ${result.lines} (jams)`);
				console.log(`  dwWazePane circles:       ${result.circles} (wazers)`);
				console.log(`  sample tooltip:           ${result.sampleTip}`);
				console.log(`  screenshot:               ${shot}`);
			}
		}
	} catch (e) {
		phase2 = { ok: false, error: e.message, skipped: false };
		console.log(`  phase 2 error: ${e.message}`);
	}
	if (errors.length) {
		console.log("  page errors:");
		for (const e of errors.slice(-5)) console.log(`    ${e}`);
	}
	await browser.close();
}

// ====================================================================
console.log("\n=== Waze verification summary ===");
console.log(`  broker mints correct-origin token:  ${phase1.codeOk ? "✓" : "✗"}`);
console.log(`  georss accepts it (needs real score): ${
	phase1.accepted ? "✓" : (phase1.georssStatus === 403 ? "✗ 403 (low reCAPTCHA score)" : "✗")}`);
console.log(`  Phase 1 gate: ${phase1.ok ? "✓ PASS" : "✗ FAIL"}`);
console.log(`  Phase 2 (render on dynamic.watch): ${
	phase2.skipped ? "— skipped" : (phase2.ok ? "✓ PASS" : "✗ FAIL")}`);

if (phase1.codeOk && !phase1.accepted && !HEADED) {
	console.log("\n  NOTE: headless reCAPTCHA scores this automated browser too low, so");
	console.log("  georss 403s the token — expected. The broker + minting are verified.");
	console.log("  Re-run `npm run e2e:waze:headed` to prove georss acceptance + render.");
}

// Phase 1 is the hard gate (it's the risk we set out to close). Phase 2 is
// gated only when it actually ran — a skip (no auth / low-score token)
// must not red the build.
const ok = phase1.ok && (phase2.skipped || phase2.ok);
console.log(`\n${ok ? "✓ PASS" : "✗ FAIL"} — Waze Traffic layer`);
process.exit(ok ? 0 : 1);
