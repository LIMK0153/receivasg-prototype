# ReceivaSG prototype

A working prototype of **ReceivaSG**, the tokenised invoice financing platform described in our submitted press release (BF3214 Digital Assets, group project). A Singapore SME sells a buyer-approved InvoiceNow invoice to a bankruptcy-remote SPV. The SPV issues permissioned ERC-3643-style tokens to accredited and institutional investors, who fund it in fractions; each token pays S$1 when the buyer pays. The SME is paid in one atomic settlement, and when the buyer pays at maturity a smart contract distributes the proceeds pro rata to whoever holds the tokens.

**Live demo:** https://limk0153.github.io/receivasg-prototype/

**Quick start:** open `dist/receivasg-prototype.html` in Chrome or Edge. No install, no wallet, no internet needed (internet only loads the fonts). Sign in as one of the demo accounts and use it like a website. Switch accounts from the top-right menu. The yellow presenter checklist tells you what to click next and highlights that button; it never clicks anything for you.

---

## The three layers the brief asks for

| Layer | What we built |
|---|---|
| **1. Smart contracts** (on-chain logic) | Six Solidity contracts in `contracts/`, 15 passing unit tests in `test/ReceivaSG.test.js` |
| **2. Interactive frontend** (user-facing app) | Role-based web app in `frontend/src/`: SME, ReceivaSG Ops, two investors (Ng & Toh Capital and Lim & Pang Capital), the corporate buyer, an unverified wallet, an on-chain explorer and a results page |
| **3. Deployed on a blockchain environment** | (a) **Sandbox chain**: a real EVM (EthereumJS VM, the engine behind Remix VM) running inside the page; the contracts are deployed to it on load. (b) **Local Hardhat node**, tested. (c) **Ethereum Sepolia public testnet**: one command, with Etherscan verification. The same frontend drives (b) and (c) through MetaMask. |

### The contracts

| Contract | Role in the press release |
|---|---|
| `ReceivaSPV.sol` | The Singapore-domiciled SPV. Accepts InvoiceNow-approved invoices, records one of nine grades AAA–C, prices them (never below the **85% minimum financing percentage**), handles SME counter-offers, takes the true sale, runs pooled funding, settles atomically, distributes at maturity, handles defaults |
| `InvoiceNFT.sol` (ERC-721) | The unique on-chain reference to each validated receivable. Minted to the SPV and non-transferable. Stores only the e-invoice hash and status; documents stay off-chain |
| `ReceivableNote.sol` (ERC-3643-style) | Fractional receivables-backed tokens issued by the SPV, one series per invoice (EIP-1167 clones). Every transfer checks the identity registry; non-compliant transfers fail inside the contract. Agent controls: pause, freeze, forced recovery transfer |
| `IdentityRegistry.sol` | KYC/AML registry. Stores category and expiry plus a hash of the KYC file, never personal data |
| `TokenisedSGD.sol` | Simulated tokenised commercial bank deposit used for every cash leg |
| `DDExMarket.sol` | Simulated stand-in for the DBS Digital Exchange: secondary trading with atomic delivery-versus-payment |

### Key mechanics, as stated in the submitted press release

| Press release | Where it happens |
|---|---|
| Buyer approval arrives via InvoiceNow (Peppol); ReceivaSG verifies supplier, buyer, amount, due date | Ops → Verification queue: the InvoiceNow checks, plus the e-invoice hash recorded on-chain |
| Sold outright to the SPV, which records the assignment and gives notice to the buyer | `acceptOffer()` mints the Invoice NFT to the SPV and emits `NoticeOfAssignment`; the buyer's Payables screen shows the notice |
| ERC-721 Invoice NFT + fractional ERC-3643 tokens issued by the SPV | `InvoiceNFT` + `ReceivableNote` clone per invoice |
| Grading AAA, AA, A, BBB, BB, B, CCC, CC, C: higher grades need a bigger minimum investment and pay less | `discountBpsPer90d` and `minTicket` per grade in `ReceivaSPV`; Ops → Grades and pricing. A S$100,000, 90-day invoice prices at S$98,750 / 98,400 / 98,000 / 97,000 / 95,500 / 93,500 / 90,000 / 87,500 / 85,000 from AAA down to C, with the biggest step between B and CCC |
| SME can counter-offer instead of only accepting or declining | `counterOffer()` / `reviewCounter()`: the SME may ask for up to the price one grade better would earn; ReceivaSG approves (the counter becomes the price) or rejects (the original offer stands). AAA has no room to counter |
| S$100,000 invoice, 90 days → financed at S$98,000 → investors collectively provide S$98,000 → buyer pays S$100,000 → smart contract distributes pro rata | The presenter checklist walks through exactly this. Grade A = 2.00% per 90 days |
| 85% minimum financing percentage | `MIN_FINANCING_BPS = 8500`; shaded cells in the pricing grid; the seeded CC 240-day invoice is floored at S$34,000 on S$40,000 |
| Atomic settlement (T+0 DvP) with tokenised deposits, no settlement window, no escrow float | Investors' cash stays in their wallets; the commitment that fills the invoice pulls every investor's cash, mints every token and pays the SME **in one transaction**. If any leg fails, everything reverts |
| Double-pledging detected within the network | `DuplicateInvoice` revert on a reused e-invoice hash ("Submit again" button) |
| DDEx listing for price discovery and exit before maturity | DDEx secondary market tab |
| Returns vs the 1.92% 6-month T-bill (MAS, 29 Sep 2026); capital back in half the time | Results page: held to maturity a grade-A token earns **7.86% p.a.** net of the 0.10% servicing fee; Ng & Toh earns about 8.3% p.a. selling after 30 days |
| SME: outright sale, no financing interest to repay | SME offer card and Results |
| ReceivaSG earns fees, not token speculation | 0.10% servicing fee to the treasury at maturity |

---

## Demo script for the presentation (about 6 minutes)

You click every step yourself. Switch accounts with the account menu (top right); the checklist's **Switch to …** button does the same thing. The button to press next has a pulsing yellow outline. **Demo tools** (header) moves the chain clock forward, hides the checklist or activity panel, and resets the demo.

1. **Meridian requests financing.** InvoiceNow inbox: three e-invoices synced from accounting, each labelled with its buyer. One shows a buyer query and can't be submitted. *Only buyer-approved invoices qualify.*
2. **ReceivaSG verifies and grades.** Six InvoiceNow checks plus the credit scorecard for Straits Marine (score 82.5 → A). The contract sets the price: S$98,000. *Grading is off-chain; pricing is on-chain and auditable.* (Click C on the grade picker to show the lowest grade would price at S$85,000, then back to A.)
3. **Optional: Meridian counter-offers.** Click Counter-offer and ask for more, up to the AA price (S$98,400). Switch to ReceivaSG Ops: the review card shows investors' return at the counter vs the original offer and the T-bill. Approve or reject. Click **Skip this step** in the checklist to keep the press-release numbers.
4. **Meridian accepts.** True sale to the SPV: the Invoice NFT is minted, notice of assignment goes to the buyer, token series RSN-4 is created. Point at the blockchain activity panel.
5. **Ng & Toh commits S$50,000.** Show that its wallet balance does not drop. *No escrow.*
6. **Lim & Pang Capital commits the remaining S$48,000** (Fill remaining). The highlighted "atomic settlement" entry: both cash legs, both token mints and S$98,000 to Meridian, all in one block.
7. **30 days pass:** Demo tools → +30 days.
8. **Ng & Toh sells all its tokens on DDEx** (DBS Digital Exchange) at the suggested S$50,340: it doesn't hold to maturity. The sell form shows what Ng & Toh paid (S$50,000), what the tokens pay at maturity (S$50,969.37), and how the suggested price is worked out: tokens issued at S$0.98 rise evenly to S$1.00 over 90 days, so after 30 days each is priced at S$0.9867. The seller can ask more or less; DDEx buyers decide.
9. **An unverified wallet tries to buy.** It holds S$50,000, but the token contract blocks it. *Compliance lives in the token, not in a back office.*
10. **Lim & Pang buys** Ng & Toh's tokens in one DvP transaction and now holds the whole invoice.
11. **Move to the due date:** Demo tools → To INV-2026-0412 due date.
12. **Straits Marine pays S$100,000.** One transaction pays the 0.10% fee and the current holder (Lim & Pang), then retires the tokens.
13. **Results:** the SME was paid 90 days early for 2%. Ng & Toh earned about 8.3% p.a. over 30 days and Lim & Pang about 7.8% p.a., vs 1.92% for T-bills. The SPV holds S$0: nothing sat in escrow.

**For Q&A:** Ops → Identity registry → *Complete KYC* on the unverified wallet, then show it can now buy. Ops → Grades and pricing shows where the 85% floor bites. Explorer → Invoice NFTs shows the on-chain metadata. **Demo tools → Reset demo** starts a fresh chain.

---

## Run, test and deploy

Requires Node.js 18 or newer.

```bash
npm install          # an .npmrc sets legacy-peer-deps
npm test             # 15 contract tests on Hardhat
npm run build        # compile contracts → shared/artifacts.json → dist/*.html
```

### Local blockchain (Hardhat node)

```bash
npm run node                 # terminal 1: local chain at http://127.0.0.1:8545
npm run deploy:local         # terminal 2: deploys + seeds, writes deployments/localhost.json
npm run serve                # serves the prototype at http://localhost:5173
```

In MetaMask, add the network (RPC `http://127.0.0.1:8545`, chain id 31337) and import Hardhat's test accounts #0 (ReceivaSG Ops), #3 (Meridian), #4 (Straits Marine), #5 (Ng & Toh), #6 (Lim & Pang), #7 (unverified). Then in the prototype open **Explorer → Network**, paste `deployments/localhost.json` and click **Connect wallet**. Switch MetaMask accounts to act as each party. The checklist skips the clock steps on a live network, so the buyer pays early.

### Ethereum Sepolia (public testnet)

1. Create a **testnet-only** MetaMask account and get Sepolia ETH from a faucet. Deploying and seeding uses about 15.1M gas plus 0.01 ETH of gas money per demo wallet, so **0.3 Sepolia ETH** is comfortable.
2. `cp .env.example .env` and set `DEPLOYER_PRIVATE_KEY` (and optionally `SEPOLIA_RPC_URL`, `ETHERSCAN_API_KEY` to publish verified source code).
3. `npm run deploy:sepolia`. This prints every contract address and an Etherscan link, writes `deployments/sepolia.json`, and writes `deployments/sepolia.demo-wallets.json` with the generated demo wallets' private keys (gitignored).
4. Import those demo wallets into MetaMask, run `npm run serve`, and connect as above with `deployments/sepolia.json`.

`npm run deploy:amoy` (Polygon Amoy) works the same way, and so does the `custom` network with any `CUSTOM_RPC_URL`.

### Browser tests

`npm run e2e` (the whole press-release story completed by clicking the real UI under a strict content-security policy, then KYC, transfers and withdrawals) and `npm run e2e:wallet` (wallet mode against a running Hardhat node after `deploy:local`) need Playwright: `npm i -D playwright && npx playwright install chromium`.

---

## What is simulated, and why

- **Tokenised SGD** is a simple ERC-20 standing in for a bank's tokenised deposit.
- **DDEx** is a contract that behaves like a listing venue. The real DBS Digital Exchange integration is the partnership described in the press release.
- **InvoiceNow/Peppol** is represented by structured e-invoices (Peppol BIS Billing 3.0 fields, 9% GST) whose hash goes on-chain. The verifier role stands in for ReceivaSG's Access Point.
- **Credit scorecard** weights and grade bands are illustrative. The grade itself and all pricing are on-chain.
- **ERC-3643** is implemented in simplified form (identity registry plus compliance checks plus agent controls) rather than the full ONCHAINID claim system.
- **The sandbox chain** is a single in-page node. The BN254 precompiles (0x06–0x08) are disabled because they need `eval`, and no ReceivaSG contract uses them.
- All companies, people and the partnership are fictional, as in the press release.

## Updating the prototype

The live demo (GitHub Pages) is served from `docs/index.html`, which `npm run build` regenerates along with `dist/receivasg-prototype.html`. After changing any source code:

```bash
npm run build                 # rebuilds dist/ and docs/
npm test                      # optional: contract tests
git add -A && git commit -m "Describe the change" && git push
```

GitHub Pages picks up the new `docs/index.html` about a minute after the push; the link stays the same. Text-only edits to this README need no rebuild.

## Project layout

```
contracts/          Solidity sources
test/               Hardhat unit tests
e2e/                Browser end-to-end scripts (Playwright)
shared/             Deploy/seed suite, constants, e-invoice builder, compiled ABIs (used by tests, deploy script and frontend)
scripts/            deploy.js, export-artifacts.js
frontend/src/       React app, in-browser chain (sandboxChain.js), chain client, views
frontend/build.mjs  Bundles everything into dist/receivasg-prototype.html
deployments/        Addresses written by the deploy script
dist/               The built prototype (receivasg-prototype.html)
docs/               Copy of the built prototype served by GitHub Pages (index.html)
```
