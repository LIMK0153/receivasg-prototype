// Replays each scenario with the contract's arithmetic, then checks investorResults().
// Run: npm run test:results
import { investorResults } from "../frontend/src/model.js";
const DAY = 86400, T0 = 1_800_000_000, FACE = 10_000_000, FEE_BPS = 10;
const S = (c) => `S$${(c / 100).toLocaleString("en-SG", { minimumFractionDigits: 2 })}`;

function scenario(name, { price, commits, trades }) {
  // primary: notes = cash*face/price, last committer gets the remainder (as in commit())
  let allocated = 0; const commitments = [];
  commits.forEach(([who, cash], i) => {
    const notes = i === commits.length - 1 ? FACE - allocated : Math.floor((cash * FACE) / price);
    allocated += notes; commitments.push({ investor: who, cash, notes });
  });
  const bal = {}; const order = [];
  const credit = (w, n) => { if (!bal[w]) order.push(w); bal[w] = (bal[w] || 0) + n; };
  for (const c of commitments) credit(c.investor, c.notes);
  const filled = trades.map(([seller, buyer, amount, priceT, day]) => {
    bal[seller] -= amount; credit(buyer, amount);
    if (bal[seller] === 0) order.splice(order.indexOf(seller), 1);
    return { seller, buyer, amount, price: priceT, filledAt: T0 + day * DAY };
  });
  // maturity: 0.10% fee, pro rata, last holder in the holder list gets the remainder (as in _distribute())
  const pool = FACE - (FACE * FEE_BPS) / 10000; let paid = 0;
  const holders = order.filter((w) => bal[w] > 0);
  const dists = holders.map((w, i) => {
    const amt = i === holders.length - 1 ? pool - paid : Math.floor((pool * bal[w]) / FACE);
    paid += amt; return { holder: w, amount: amt, notes: bal[w] };
  });
  const rows = investorResults({ commitments, trades: filled, dists, fundedAt: T0, maturityTs: T0 + 90 * DAY });
  const totalProfit = rows.reduce((s, r) => s + r.profit, 0);
  console.log(`\n── ${name}`);
  for (const r of rows) {
    console.log(`  ${r.k.padEnd(9)} paid in ${S(r.paidIn).padStart(13)}  sold ${S(r.soldProceeds).padStart(12)} for ${(r.soldTokens/100).toFixed(2).padStart(9)} tok  at maturity ${S(r.maturityPayout).padStart(12)} for ${(r.maturityTokens/100).toFixed(2).padStart(10)} tok  profit ${S(r.profit).padStart(10)}  ann ${r.ann === null ? "   —  " : r.ann.toFixed(2) + "%"}  T-bill ${S(Math.round(r.tbillEarn))}  firstSale d${r.firstSaleDays ?? "-"} soldAll=${r.soldAll}`);
  }
  const expected = pool - price;
  console.log(`  check: total profit ${S(totalProfit)} = buyer's payment after fee − price ${S(expected)} → ${totalProfit === expected ? "OK" : "MISMATCH"}`);
  return rows;
}

const A = (rows, k) => rows.find((r) => r.k === k);
const assert = (ok, msg) => console.log(`  ${ok ? "PASS" : "FAIL"}: ${msg}`);

let r = scenario("A. no DDEx trade, both hold to maturity", { price: 9_800_000, commits: [["NgToh", 5_000_000], ["LimPang", 4_800_000]], trades: [] });
assert(Math.abs(A(r, "NgToh").ann - 7.86) < 0.01 && Math.abs(A(r, "LimPang").ann - 7.86) < 0.01, "both earn the grade-A 7.86% p.a.");

r = scenario("B. Ng & Toh sells ALL its tokens on day 30 at the suggested S$50,340", { price: 9_800_000, commits: [["NgToh", 5_000_000], ["LimPang", 4_800_000]], trades: [["NgToh", "LimPang", 5_102_040, 5_034_000, 30]] });
assert(A(r, "NgToh").received === 5_034_000 && A(r, "NgToh").maturityPayout === 0, "Ng & Toh gets only the sale proceeds, nothing at maturity");
assert(Math.abs(A(r, "NgToh").ann - 8.27) < 0.01, "Ng & Toh 8.27% p.a. over 30 days");

r = scenario("C. YOUR CASE: Ng & Toh sells 25,000 tokens on day 30 for S$24,670", { price: 9_800_000, commits: [["NgToh", 5_000_000], ["LimPang", 4_800_000]], trades: [["NgToh", "LimPang", 2_500_000, 2_467_000, 30]] });
const c = A(r, "NgToh");
assert(c.soldProceeds === 2_467_000, "sale proceeds S$24,670");
assert(c.maturityTokens === 2_602_040, "keeps 26,020.40 tokens");
assert(Math.abs(c.maturityPayout - 2_599_437) <= 1, "maturity payout on kept tokens ≈ S$25,994.37");
assert(c.ann > 7.9 && c.ann < 8.2, `annualised ≈ 8.0% (got ${c.ann.toFixed(2)}%), not the 5.39% shown before`);
assert(!c.soldAll && c.firstSaleDays === 30, "labelled as a partial sale on day 30");

r = scenario("D. counter-offer at S$98,200, then Ng & Toh sells 25,000 tokens on day 30 for S$24,700", { price: 9_820_000, commits: [["NgToh", 5_000_000], ["LimPang", 4_820_000]], trades: [["NgToh", "LimPang", 2_500_000, 2_470_000, 30]] });

r = scenario("E. Ng & Toh sells the same day it invested (day 0)", { price: 9_800_000, commits: [["NgToh", 5_000_000], ["LimPang", 4_800_000]], trades: [["NgToh", "LimPang", 5_102_040, 5_000_000, 0]] });
assert(A(r, "NgToh").ann === null, "no annualised figure for a same-day round trip");

r = scenario("F. two trades: Ng & Toh sells 10,000 tokens on day 30, Lim & Pang sells 5,000 back on day 60", { price: 9_800_000, commits: [["NgToh", 5_000_000], ["LimPang", 4_800_000]], trades: [["NgToh", "LimPang", 1_000_000, 986_700, 30], ["LimPang", "NgToh", 500_000, 496_700, 60]] });

r = scenario("G. Ng & Toh sells everything at a loss on day 30 (S$49,000)", { price: 9_800_000, commits: [["NgToh", 5_000_000], ["LimPang", 4_800_000]], trades: [["NgToh", "LimPang", 5_102_040, 4_900_000, 30]] });
assert(A(r, "NgToh").profit === -100_000 && A(r, "NgToh").ann < 0, "loss shows as a negative return");
