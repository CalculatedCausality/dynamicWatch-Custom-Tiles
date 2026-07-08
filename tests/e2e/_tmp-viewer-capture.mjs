// Capture the EXACT winning /v2/ortho/tile request the official viewer
// makes: full URL (incl token), request headers, and decode its token —
// so we can see what our authenticate-token flow is missing.
import { chromium } from "playwright";

const USER = process.env.VEXCEL_USER, PASS = process.env.VEXCEL_PASS;
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();

let winning = null;
const authTokens = [];
ctx.on("request", (req) => {
	const u = req.url();
	if (/api\.vexcelgroup\.com\/v2\/ortho\/tile/.test(u) && !winning) {
		winning = { url: u, headers: req.headers() };
	}
});
ctx.on("response", async (r) => {
	const u = r.url();
	if (/admin\.vexcelgroup\.com\/api\/auth\/(authenticate|check)/.test(u)) {
		try { authTokens.push({ url: u, status: r.status(), body: (await r.text()).slice(0, 500) }); } catch (_) {}
	}
});

await page.goto("https://anz-viewer.vexcelgroup.com/", { waitUntil: "networkidle", timeout: 60000 }).catch(() => {});
await page.waitForTimeout(2500);
for (const sel of ['button:has-text("Accept")', ".cc-allow"]) { const b = await page.$(sel); if (b) { await b.click().catch(() => {}); break; } }
const emailSel = 'input[type="email"], input[formcontrolname*="user" i], input[name*="user" i]';
await page.waitForSelector(emailSel, { timeout: 15000 }).catch(() => {});
const em = await page.$(emailSel);
if (em) {
	await em.fill(USER);
	let pw = await page.$('input[type="password"]');
	if (!pw) { for (const s of ['button:has-text("Next")', 'button[type="submit"]']) { const b = await page.$(s); if (b) { await b.click().catch(() => {}); break; } } await page.waitForSelector('input[type="password"]', { timeout: 10000 }).catch(() => {}); pw = await page.$('input[type="password"]'); }
	if (pw) { await pw.fill(PASS); for (const s of ['button:has-text("Log in")', 'button:has-text("Sign in")', 'button[type="submit"]']) { const b = await page.$(s); if (b) { await b.click().catch(() => {}); break; } } }
}
await page.waitForTimeout(12000);

const dec = (t) => { try { return JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString()); } catch { return null; } };
console.log("\n=== AUTH RESPONSES the viewer got ===");
for (const a of authTokens) {
	console.log(`  ${a.status} ${a.url.split("?")[0]}`);
	const m = a.body.match(/"token"\s*:\s*"([^"]+)"/);
	if (m) console.log(`    token claims: ${JSON.stringify(dec(m[1]))}`);
	else console.log(`    body: ${a.body.slice(0, 200)}`);
}
console.log("\n=== WINNING /v2/ortho/tile REQUEST ===");
if (winning) {
	const url = new URL(winning.url);
	const wtok = url.searchParams.get("token");
	console.log(`  path: ${url.origin}${url.pathname}`);
	console.log(`  params: ${[...url.searchParams.keys()].map((k) => k === "token" ? "token=<jwt>" : `${k}=${url.searchParams.get(k)}`).join("  ")}`);
	console.log(`  token claims: ${JSON.stringify(dec(wtok || ""))}`);
	console.log(`  request headers:`);
	for (const [k, v] of Object.entries(winning.headers)) console.log(`    ${k}: ${k.includes("token") || k === "authorization" ? "<redacted>" : v}`);
	// Print the token itself so we can replay it in curl.
	console.log(`\n  WINNING_TOKEN=${wtok}`);
} else console.log("  (no ortho/tile request captured)");
await browser.close();
