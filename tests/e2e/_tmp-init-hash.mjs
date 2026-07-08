import { chromium } from "playwright";
import crypto from "node:crypto";
const USER = process.env.VEXCEL_USER, PASS = process.env.VEXCEL_PASS;
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
let initToken = null, initHash = null, initSession = null, signinToken = null;
ctx.on("requestfinished", async (req) => {
	const u = req.url();
	if (u.includes("auth/signin")) { const r = await req.response(); try { signinToken = (JSON.parse(await r.text()).data || {}).token; } catch (_) {} }
	if (u.includes("configuration/init")) {
		const m = u.match(/[?&]token=([^&]+)/); if (m) initToken = decodeURIComponent(m[1]);
		const pd = req.postData() || ""; const h = pd.match(/name="hash"\r?\n\r?\n([0-9a-f]+)/i); if (h) initHash = h[1];
		const r = await req.response(); try { initSession = (JSON.parse(await r.text()) || {}).session; } catch (_) {}
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
await page.waitForTimeout(10000);
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
console.log(`init token == signin token? ${initToken === signinToken}`);
console.log(`init hash:    ${initHash}`);
console.log(`init session: ${initSession ? initSession.slice(0, 24) + "…" : "(none)"}`);
console.log(`\ncandidate sha256 matches:`);
const cands = { "sha256(token)": initToken, "sha256(USER)": USER, "sha256(USER+PASS)": USER + PASS, "sha256(PASS)": PASS,
	"sha256(token.sig)": (initToken || "").split(".")[2], "sha256(sub+iat)": "" };
for (const [name, val] of Object.entries(cands)) { if (val != null) console.log(`  ${name}: ${sha(val) === initHash ? "✓✓ MATCH" : sha(val).slice(0, 16) + "…"}`); }
await browser.close();
