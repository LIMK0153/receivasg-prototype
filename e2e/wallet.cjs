// Wallet-mode check: the built prototype drives contracts deployed to a Hardhat node
// through an injected EIP-1193 wallet (stand-in for MetaMask), switching accounts per step.
// Prereqs: `npx hardhat node` running and `npm run deploy:local` done.
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const http = require("http");

const RPC = process.env.RPC_URL || "http://127.0.0.1:8545";
const deployment = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "localhost.json"), "utf8"));
const html = fs.readFileSync(path.join(__dirname, "..", "dist", "receivasg-prototype.html"), "utf8");
const server = http.createServer((q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end(html); }).listen(0);
const OUT = process.argv[2] || path.join(__dirname, "..", "e2e-shots");
fs.mkdirSync(OUT, { recursive: true });

let id = 1;
async function rpc(method, params) {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }) });
  const j = await res.json();
  if (j.error) return { error: j.error };
  return { result: j.result };
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.exposeFunction("__rpc", rpc);
  await page.addInitScript((first) => {
    let account = first;
    const listeners = {};
    window.__setAccount = (a) => { account = a; (listeners.accountsChanged || []).forEach((f) => f([a])); };
    window.ethereum = {
      isMetaMask: true,
      on: (e, f) => (listeners[e] ||= []).push(f),
      removeListener: () => {},
      async request({ method, params = [] }) {
        if (method === "eth_accounts" || method === "eth_requestAccounts") return [account];
        if (method === "eth_sendTransaction") params = [{ ...params[0], from: account }];
        const r = await window.__rpc(method, params);
        if (r.error) { const e = new Error(r.error.message); e.code = r.error.code; e.data = r.error.data; throw e; }
        return r.result;
      },
    };
  }, deployment.actors.sme);

  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForSelector(".signin", { timeout: 60000 });
  await page.click("#signin-sme");
  await page.click("#nav-explorer");
  await page.locator(".tabs button", { hasText: "Network" }).click();
  await page.fill("#deploy-json", JSON.stringify(deployment));
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await page.waitForFunction(() => /localhost/.test(document.querySelector(".chainchip")?.innerText || ""), null, { timeout: 20000 });
  console.log("connected:", (await page.locator(".chainchip").innerText()).replace(/\s+/g, " "));

  // Switching accounts happens in the wallet (as in MetaMask); the page follows.
  const wallet = async (k) => { await page.evaluate((a) => window.__setAccount(a), deployment.actors[k]); await page.waitForFunction((n) => document.querySelector("#btn-account")?.innerText.includes(n), { sme: "Meridian", admin: "ReceivaSG", investorA: "Lion Gate", investorB: "Lim & Pang", unverified: "Unverified", buyer: "Straits" }[k]); };
  const nav = (label) => page.locator(".topnav button", { hasText: label }).click();
  const toast = async (label) => {
    await page.waitForSelector(".toasts .notice", { timeout: 30000 });
    await page.waitForTimeout(200);
    console.log(`✓ ${label} → ${(await page.locator(".toasts .notice").last().innerText()).replace(/\s+/g, " ").replace(" ×", "")}`);
    await page.evaluate(() => document.querySelectorAll(".toasts .x").forEach((x) => x.click()));
  };
  const card = () => page.locator(".offer-card", { hasText: "INV-2026-0412" });
  await wallet("sme"); await page.click("#btn-submit-INV-2026-0412"); await toast("submit (wallet: sme)");
  await wallet("admin"); await page.click("#btn-verify"); await toast("verify (wallet: admin)");
  await wallet("sme"); await page.click("#btn-accept"); await toast("accept (wallet: sme)");
  await wallet("investorA"); await card().locator("input").fill("50000"); await card().locator("button.btn").click(); await toast("commit (wallet: investorA)");
  await wallet("investorB"); await card().locator("button.chip", { hasText: "Fill remaining" }).click(); await card().locator("button.btn").click(); await toast("fill (wallet: investorB)");
  await wallet("investorA"); await nav("DDEx market"); await page.click("#btn-list"); await toast("list (wallet: investorA)");
  await wallet("unverified"); await nav("DDEx market"); await page.locator("tr", { hasText: "RSN-4" }).locator("button", { hasText: "Buy" }).click(); await toast("buy (wallet: unverified)");
  await wallet("investorB"); await nav("DDEx market"); await page.locator("tr", { hasText: "RSN-4" }).locator("button", { hasText: "Buy" }).click(); await toast("buy (wallet: investorB)");
  await wallet("buyer"); await page.locator("button", { hasText: "to the SPV" }).first().click(); await toast("repay (wallet: buyer)");
  await page.click("#nav-results");
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, "20-wallet-results.png"), fullPage: true });
  const lines = (await page.locator(".main").innerText()).split("\n").filter((l) => /Held to maturity|Sold on DDEx|bought on DDEx|block #/.test(l));
  console.log(lines.join("\n"));
  console.log(errors.length ? "ERRORS: " + errors.join(" | ") : "no page errors");
  await browser.close();
  server.close();
})().catch((e) => { console.error(e); server.close(); process.exit(1); });
