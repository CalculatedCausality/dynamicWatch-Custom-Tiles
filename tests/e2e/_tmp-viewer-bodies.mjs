import { chromium } from "playwright";
const USER = process.env.VEXCEL_USER, PASS = process.env.VEXCEL_PASS;
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
const grab = {};
ctx.on("response", async (r) => {
	const u = r.url();
	for (const key of ["auth/signin", "auth/authenticate", "configuration/init", "maps/user"]) {
		if (u.includes(key) && !grab[key]) { try { grab[key] = { status: r.status(), body: await r.text() }; } catch (_) {} }
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
for (const [k, v] of Object.entries(grab)) {
	console.log(`\n========== ${k}  (HTTP ${v.status}) ==========`);
	// Redact JWTs but KEEP the session field visible.
	console.log(v.body.replace(/(eyJ[\w-]+\.[\w-]+\.)[\w-]+/g, "$1<sig>").slice(0, 1500));
}
await browser.close();
