// End-to-end: complete the press-release example purely by clicking the real UI
// (sign in, switch accounts, type amounts, press buttons), under a strict CSP.
// Usage: node e2e/sandbox.cjs [outDir]
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const http = require("http");

const OUT = process.argv[2] || path.join(__dirname, "..", "e2e-shots");
fs.mkdirSync(OUT, { recursive: true });
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:; connect-src 'none'";
const html = fs.readFileSync(path.join(__dirname, "..", "dist", "receivasg-prototype.html"), "utf8");
const server = http.createServer((q, r) => { r.writeHead(200, { "content-type": "text/html", "content-security-policy": CSP }); r.end(html); }).listen(0);

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("requestfailed", (r) => { if (!/fonts\./.test(r.url())) errors.push("request failed: " + r.url()); });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForSelector(".signin", { timeout: 60000 });
  await page.screenshot({ path: path.join(OUT, "00-signin.png") });

  const shot = (n) => page.screenshot({ path: path.join(OUT, `${n}.png`) });
  const toast = async (label) => {
    await page.waitForSelector(".toasts .notice", { timeout: 20000 });
    await page.waitForTimeout(200);
    const t = (await page.locator(".toasts .notice").last().innerText()).replace(/\s+/g, " ").replace(" ×", "");
    console.log(`✓ ${label}  →  ${t}`);
    await page.evaluate(() => document.querySelectorAll(".toasts .x").forEach((x) => x.click()));
  };
  const switchTo = async (name) => {
    await page.click("#btn-account");
    await page.locator(".acct-menu .acct-item", { hasText: name }).click();
  };
  const nav = (label) => page.locator(".topnav button", { hasText: label }).click();
  const cueIs = async (sel) => console.log(`   highlighted: ${await page.locator(".cue-pulse").evaluateAll((els) => els.map((e) => e.id || e.className.split(" ")[0]).join(",")) || "nothing"} (expected ${sel})`);
  const tools = async (label) => { await page.click("#btn-demo-tools"); await page.locator(".menu button", { hasText: label }).click(); };

  await page.click("#signin-sme");
  await cueIs("#btn-submit-INV-2026-0412");
  await shot("01-sme");
  await page.click("#btn-submit-INV-2026-0412"); await toast("Meridian requests financing");

  await switchTo("ReceivaSG Ops"); await cueIs("#btn-verify"); await shot("02-ops");
  await page.click("#btn-verify"); await toast("Ops verifies and grades A");

  await switchTo("Meridian"); await shot("03-offer");
  await page.click("#btn-accept"); await toast("Meridian accepts the offer");

  const card = () => page.locator(".offer-card", { hasText: "INV-2026-0412" });
  await switchTo("Lion Gate"); await cueIs("#amt-4");
  await card().locator("input").fill("50000"); await card().locator("button.btn").click(); await toast("Lion Gate commits 50,000");
  await switchTo("Harbourfront");
  await card().locator("input").fill("30000"); await card().locator("button.btn").click(); await toast("Harbourfront commits 30,000");
  await switchTo("Jasmine"); await cueIs("#fill-4"); await shot("04-market");
  await card().locator("button.chip", { hasText: "Fill remaining" }).click(); await card().locator("button.btn").click(); await toast("Jasmine fills the invoice");
  await shot("05-settled");

  await cueIs("#btn-demo-tools"); await tools("+30 days"); await toast("+30 days");
  await nav("DDEx market"); await cueIs("#btn-list"); await page.click("#btn-list"); await toast("Jasmine lists on DDEx");
  await switchTo("Unverified"); await nav("DDEx market"); await shot("06-ddex");
  await page.locator("tr", { hasText: "RSN-4" }).locator("button", { hasText: "Buy" }).click(); await toast("Unverified tries to buy");
  await switchTo("Harbourfront"); await nav("DDEx market");
  await page.locator("tr", { hasText: "RSN-4" }).locator("button", { hasText: "Buy" }).click(); await toast("Harbourfront buys");
  await tools("due date"); await toast("Fast-forward to due date");
  await switchTo("Straits Marine"); await cueIs("#btn-repay-4"); await shot("07-buyer");
  await page.click("#btn-repay-4"); await toast("Straits Marine pays");
  await page.click("#nav-results"); await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, "08-results.png"), fullPage: true });
  console.log((await page.locator(".main").innerText()).split("\n").filter((l) => /Held to maturity|Sold on DDEx|bought on DDEx/.test(l)).join("\n"));
  console.log("checklist:", (await page.locator(".guide-text strong").innerText().catch(() => "hidden")));

  // duplicate e-invoice
  await switchTo("Meridian"); await page.getByRole("button", { name: "Submit again" }).first().click(); await toast("Duplicate submit");

  const mob = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
  await mob.route(/fonts\./, (r) => r.abort());
  await mob.goto(`http://127.0.0.1:${server.address().port}/`);
  await mob.waitForSelector(".signin", { timeout: 60000 });
  await mob.screenshot({ path: path.join(OUT, "09-mobile-signin.png") });
  await mob.click("#signin-investorA");
  console.log("mobile overflow px:", await mob.evaluate(() => document.documentElement.scrollWidth - window.innerWidth));
  await mob.screenshot({ path: path.join(OUT, "10-mobile.png") });

  console.log(errors.length ? "ERRORS:\n" + errors.join("\n") : "no page errors");
  await browser.close();
  server.close();
})().catch((e) => { console.error(e); server.close(); process.exit(1); });
