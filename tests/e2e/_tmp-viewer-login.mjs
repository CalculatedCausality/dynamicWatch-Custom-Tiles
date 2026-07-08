// Log into the REAL anz-viewer.vexcelgroup.com with the account and see
// whether ITS OWN imagery requests succeed (200) or 403. If the official
// viewer 403s too → account entitlement. If it 200s → the viewer does
// something our flow doesn't, and we capture the winning request.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const USER = process.env.VEXCEL_USER, PASS = process.env.VEXCEL_PASS;
const OUT = process.env.OUT || ".";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();

const api = [];
ctx.on("response", (r) => {
	const u = r.url();
	if (/api\.vexcelgroup\.com\/v2\/(ortho|oriented)/.test(u)) api.push({ status: r.status(), url: u });
	if (/admin\.vexcelgroup\.com\/api\/auth/.test(u)) api.push({ status: r.status(), url: u });
});

console.log("opening viewer…");
await page.goto("https://anz-viewer.vexcelgroup.com/", { waitUntil: "networkidle", timeout: 60000 }).catch(() => {});
await page.waitForTimeout(3000);
// accept cookie banner if present
for (const sel of ['button:has-text("Accept")', 'button:has-text("Got it")', ".cc-allow", "#cc-accept"]) {
	const b = await page.$(sel); if (b) { await b.click().catch(() => {}); break; }
}
await page.screenshot({ path: `${OUT}/01-landing.png` });

// Find email + password inputs.
const emailSel = 'input[type="email"], input[name*="user" i], input[name*="email" i], input[formcontrolname*="user" i], input[formcontrolname*="email" i]';
const passSel = 'input[type="password"]';
console.log("looking for login form…");
await page.waitForSelector(emailSel, { timeout: 15000 }).catch(() => console.log("  no email field found on landing"));
const emailEl = await page.$(emailSel);
if (emailEl) {
	await emailEl.fill(USER);
	// password may appear after clicking "next"
	let passEl = await page.$(passSel);
	if (!passEl) {
		for (const sel of ['button:has-text("Next")', 'button:has-text("Continue")', 'button[type="submit"]']) {
			const b = await page.$(sel); if (b) { await b.click().catch(() => {}); break; }
		}
		await page.waitForSelector(passSel, { timeout: 10000 }).catch(() => {});
		passEl = await page.$(passSel);
	}
	if (passEl) {
		await passEl.fill(PASS);
		await page.screenshot({ path: `${OUT}/02-filled.png` });
		for (const sel of ['button:has-text("Log in")', 'button:has-text("Login")', 'button:has-text("Sign in")', 'button[type="submit"]']) {
			const b = await page.$(sel); if (b) { await b.click().catch(() => {}); break; }
		}
		console.log("submitted login, waiting for map…");
		await page.waitForTimeout(12000);
	} else console.log("  no password field appeared");
} else console.log("  could not locate email field");

await page.screenshot({ path: `${OUT}/03-after-login.png`, fullPage: false });

const ortho = api.filter((a) => /ortho|oriented/.test(a.url));
const ok = ortho.filter((a) => a.status < 300).length;
const forbidden = ortho.filter((a) => a.status === 403).length;
console.log("\n=== official viewer imagery requests ===");
console.log(`  imagery 200: ${ok}   403: ${forbidden}   (total imagery reqs: ${ortho.length})`);
for (const a of ortho.slice(0, 6)) console.log(`  ${a.status}  ${a.url.slice(0, 90)}`);
if (ok > 0) console.log("\n>>> VIEWER WORKS — account IS authorized; our flow is missing something.");
else if (forbidden > 0) console.log("\n>>> VIEWER ALSO 403 — account entitlement is the problem, confirmed.");
else console.log("\n>>> viewer made no imagery requests (login may have failed — see screenshots).");
await browser.close();
