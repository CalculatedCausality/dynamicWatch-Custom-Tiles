import { chromium } from "playwright";
import crypto from "node:crypto";
const USER = process.env.VEXCEL_USER, PASS = process.env.VEXCEL_PASS;
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
let full = null, token = null;
ctx.on("request", (req) => {
	if (req.url().includes("configuration/init")) {
		full = req.postData();
		const m = req.url().match(/[?&]token=([^&]+)/); if (m) token = decodeURIComponent(m[1]);
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
await page.waitForTimeout(8000);
console.log("=== FULL configuration/init POST body ===");
console.log(full || "(none)");
// parse fields
if (full) {
	const fields = {};
	const re = /name="([^"]+)"\r?\n\r?\n([\s\S]*?)\r?\n------/g; let m;
	while ((m = re.exec(full)) !== null) fields[m[1]] = m[2];
	console.log("\n=== fields ===");
	for (const [k, v] of Object.entries(fields)) console.log(`  ${k} = ${v.slice(0, 80)}${v.length > 80 ? "…(" + v.length + ")" : ""}`);
	const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
	const hash = fields.hash;
	console.log(`\nhash = ${hash}`);
	for (const [k, v] of Object.entries(fields)) if (k !== "hash") console.log(`  sha256(${k}) match: ${sha(v) === hash}`);
	if (token) console.log(`  sha256(token) match: ${sha(token) === hash}`);
}
await browser.close();
