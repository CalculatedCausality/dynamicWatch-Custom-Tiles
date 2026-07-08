import { chromium } from "playwright";
const USER = process.env.VEXCEL_USER, PASS = process.env.VEXCEL_PASS;
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();

let session = null;
const log = []; // ordered {method,url,status,reqBody,respHeaders,body}
ctx.on("requestfinished", async (req) => {
	const u = req.url();
	if (!/vexcelgroup\.com/.test(u)) return;
	if (/\.(js|css|woff2?|png|webp|ico)(\?|$)/.test(u)) return;
	const resp = await req.response();
	let body = "", headers = {};
	try { headers = resp ? resp.headers() : {}; } catch (_) {}
	try { const ct = headers["content-type"] || ""; if (/json|text/.test(ct)) body = (await resp.text()).slice(0, 400); } catch (_) {}
	const m = u.match(/[?&]session=([^&]+)/);
	if (m && !session) session = decodeURIComponent(m[1]);
	log.push({ method: req.method(), url: u, status: resp ? resp.status() : "?", reqBody: (req.postData() || "").slice(0, 200), headers, body });
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

const key = session ? session.slice(0, 24) : null;
console.log(`\nsession prefix: ${key || "(none captured)"}`);
console.log(`\n=== WHERE THE SESSION FIRST APPEARS (body or header) ===`);
for (const e of log) {
	const inBody = key && e.body && e.body.includes(key);
	const inHdr = key && Object.values(e.headers).some((v) => String(v).includes(key));
	if (inBody || inHdr) {
		console.log(`  >>> ${e.method} ${e.status} ${e.url.split("?")[0]}  [${inBody ? "in BODY" : ""}${inHdr ? " in HEADER" : ""}]`);
		if (inBody) console.log(`      body: ${e.body}`);
		break;
	}
}
console.log(`\n=== ordered admin/api calls (method status path ? shortparams) ===`);
for (const e of log) {
	if (/\/(ortho|oriented|osm)\/tile/.test(e.url)) continue;
	const q = e.url.includes("?") ? "?" + e.url.split("?")[1].replace(/(token|session)=[^&]+/g, "$1=…").slice(0, 70) : "";
	console.log(`  ${e.method.padEnd(4)} ${e.status}  ${e.url.split("?")[0].replace("https://", "")}${q}`);
	if (e.method === "POST" && e.reqBody) console.log(`        req: ${e.reqBody.replace(/"password":"[^"]*"/, '"password":"***"')}`);
}
await browser.close();
