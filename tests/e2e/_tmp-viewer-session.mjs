// Find where the viewer MINTS the `session=` token used on /ortho/tile.
import { chromium } from "playwright";

const USER = process.env.VEXCEL_USER, PASS = process.env.VEXCEL_PASS;
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();

let sessionVal = null;
const responses = []; // {method,url,status,body}
ctx.on("response", async (r) => {
	const u = r.url();
	if (!/vexcelgroup\.com/.test(u)) return;
	if (/\/v2\/(ortho|oriented)\/tile/.test(u)) return; // skip image tiles
	let body = "";
	try { const ct = r.headers()["content-type"] || ""; if (/json|text/.test(ct)) body = (await r.text()).slice(0, 800); } catch (_) {}
	responses.push({ url: u, status: r.status(), body });
});
ctx.on("request", (req) => {
	const u = req.url();
	if (/\/ortho\/tile/.test(u) && !sessionVal) {
		const m = u.match(/[?&]session=([^&]+)/);
		if (m) sessionVal = decodeURIComponent(m[1]);
	}
});

await page.goto("https://anz-viewer.vexcelgroup.com/", { waitUntil: "networkidle", timeout: 60000 }).catch(() => {});
await page.waitForTimeout(2500);
for (const sel of ['button:has-text("Accept")', ".cc-allow"]) { const b = await page.$(sel); if (b) { await b.click().catch(() => {}); break; } }
const em = await page.$('input[type="email"], input[formcontrolname*="user" i], input[name*="user" i]');
if (em) {
	await em.fill(USER);
	let pw = await page.$('input[type="password"]');
	if (!pw) { for (const s of ['button:has-text("Next")', 'button[type="submit"]']) { const b = await page.$(s); if (b) { await b.click().catch(() => {}); break; } } await page.waitForSelector('input[type="password"]', { timeout: 10000 }).catch(() => {}); pw = await page.$('input[type="password"]'); }
	if (pw) { await pw.fill(PASS); for (const s of ['button:has-text("Log in")', 'button:has-text("Sign in")', 'button[type="submit"]']) { const b = await page.$(s); if (b) { await b.click().catch(() => {}); break; } } }
}
await page.waitForTimeout(12000);

console.log(`\n=== session value used on /ortho/tile ===\n  ${sessionVal ? sessionVal.slice(0, 40) + "…" : "(not captured)"}`);
console.log(`\n=== which response minted it? (searching bodies) ===`);
let found = false;
for (const r of responses) {
	if (sessionVal && r.body && r.body.includes(sessionVal.slice(0, 24))) {
		console.log(`  >>> MINTED BY: ${r.status} ${r.url}`);
		console.log(`      body: ${r.body}`);
		found = true;
	}
}
if (!found) console.log("  (session not found verbatim in any response body — may be assembled client-side or via header)");
console.log(`\n=== all non-tile vexcel API calls (in order) ===`);
for (const r of responses) console.log(`  ${r.status}  ${r.url.split("?")[0]}${/\?/.test(r.url) ? "?" + r.url.split("?")[1].slice(0, 60) : ""}`);
await browser.close();
