import { chromium } from "playwright";
const USER = process.env.VEXCEL_USER, PASS = process.env.VEXCEL_PASS;
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
let initBody = null, session = null;
ctx.on("requestfinished", async (req) => {
	const u = req.url();
	if (u.includes("configuration/init")) { const r = await req.response(); try { initBody = await r.text(); } catch (_) {} }
	if (/\/(ortho|osm)\/tile/.test(u) || /oriented\/query/.test(u)) { const m = u.match(/[?&]session=([^&]+)/); if (m && !session) session = decodeURIComponent(m[1]); }
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
console.log(`session prefix: ${session ? session.slice(0, 24) : "(none)"}`);
console.log(`init body length: ${initBody ? initBody.length : 0}`);
if (initBody && session) {
	const idx = initBody.indexOf(session.slice(0, 24));
	console.log(`session found in init at index: ${idx}`);
	if (idx >= 0) console.log(`context: …${initBody.slice(Math.max(0, idx - 60), idx + 130)}…`);
}
// Also just show any "session" key regardless.
if (initBody) {
	let i = 0; const hits = [];
	while ((i = initBody.indexOf('"session"', i)) >= 0) { hits.push(initBody.slice(i, i + 60)); i += 9; }
	console.log(`"session" key occurrences: ${hits.length}`);
	hits.slice(0, 3).forEach((h) => console.log(`  ${h.replace(/(eyJ[\w-]+\.[\w-]+\.)[\w-]+/, "$1<sig>")}`));
	// find any long opaque token-ish field
	const m2 = initBody.match(/"(session|sessionId|sessionToken|mapSession)"\s*:\s*"([^"]{20,})"/);
	if (m2) console.log(`opaque session field: "${m2[1]}":"${m2[2].slice(0, 30)}…"`);
}
await browser.close();
