// Reads the full on-chain state the UI needs into one plain snapshot (amounts in cents).
import { ACTORS, SERVICING_FEE_BPS, TBILL, DAY } from "../../shared/constants.mjs";

const N = (x) => Number(x);

export async function loadSnapshot(client) {
  const { read, actors } = client;
  const keys = Object.keys(actors);
  const [{ block, time }, count, gt, feeBps, listingsRaw, spvCash] = await Promise.all([
    client.now(),
    read.spv.invoiceCount(),
    read.spv.gradeTable(),
    read.spv.servicingFeeBps(),
    read.market.allListings(),
    read.tsgd.balanceOf(client.addresses.spv),
  ]);

  const balances = {};
  const identities = {};
  const outstanding = {};
  await Promise.all(
    keys.map(async (k) => {
      const [bal, id, out] = await Promise.all([
        read.tsgd.balanceOf(actors[k]),
        read.registry.identityOf(actors[k]),
        read.spv.outstandingCommitted(actors[k]),
      ]);
      balances[k] = N(bal);
      outstanding[k] = N(out);
      identities[k] = {
        category: N(id.category),
        expiry: N(id.kycExpiry),
        hash: id.kycRecordHash,
        verified: N(id.category) !== 0 && N(id.kycExpiry) >= time,
      };
    })
  );

  const invoices = [];
  for (let id = 1; id <= N(count); id++) {
    const [inv, commits] = await Promise.all([read.spv.getInvoice(id), read.spv.getCommitments(id)]);
    const x = {
      id,
      ref: inv.invoiceRef,
      docHash: inv.docHash,
      supplier: client.actorOf(inv.supplier) || inv.supplier,
      buyer: client.actorOf(inv.buyer) || inv.buyer,
      face: N(inv.faceValue),
      price: N(inv.price),
      submittedAt: N(inv.submittedAt),
      dueDate: N(inv.dueDate),
      fundedAt: N(inv.fundedAt),
      closedAt: N(inv.closedAt),
      grade: N(inv.grade),
      floorApplied: inv.floorApplied,
      status: N(inv.status),
      note: inv.note,
      committed: N(inv.committed),
      notesAllocated: N(inv.notesAllocated),
      distributed: N(inv.distributed),
      commitments: commits.map((c) => ({ investor: client.actorOf(c.investor) || c.investor, cash: N(c.cash), notes: N(c.notes) })),
      holders: [],
      noteSupply: 0,
      noteSymbol: "",
    };
    x.counterPrice = 0;
    if (x.status === 2) {
      const [cp, range] = await Promise.all([read.spv.counterPrice(id), read.spv.counterOfferRange(id)]);
      x.counterPrice = N(cp);
      x.counterMin = N(range[0]);
      x.counterMax = N(range[1]);
    }
    if (x.note && x.note !== "0x0000000000000000000000000000000000000000") {
      const n = client.note(x.note);
      const [holders, supply, symbol, paused] = await Promise.all([n.holders(), n.totalSupply(), n.symbol(), n.paused()]);
      x.noteSupply = N(supply);
      x.noteSymbol = symbol;
      x.paused = paused;
      x.holders = await Promise.all(holders.map(async (h) => ({ who: client.actorOf(h) || h, bal: N(await n.balanceOf(h)) })));
    }
    invoices.push(x);
  }

  const listings = listingsRaw.map((l) => ({
    id: N(l.id),
    invoiceId: N(l.invoiceId),
    note: l.note,
    seller: client.actorOf(l.seller) || l.seller,
    amount: N(l.amount),
    price: N(l.price),
    active: l.active,
    buyer: l.buyer === "0x0000000000000000000000000000000000000000" ? null : client.actorOf(l.buyer) || l.buyer,
    listedAt: N(l.listedAt),
    filledAt: N(l.filledAt),
  }));

  return {
    block,
    time,
    balances,
    outstanding,
    identities,
    invoices,
    listings,
    grades: { rates: gt[0].map(N), tickets: gt[1].map(N) },
    feeBps: N(feeBps),
    spvCash: N(spvCash),
  };
}

// ── derived numbers ───────────────────────────────────────────────────

export const tenorDays = (inv, from) => Math.max(0, Math.ceil((inv.dueDate - from) / DAY));

/** Investor return if a note bought at `price` (per face) is held to maturity. */
export function annualised(costCents, payoutCents, days) {
  if (!costCents || days <= 0) return 0;
  return ((payoutCents - costCents) / costCents) * (365 / days) * 100;
}

/** Expected investor yield for a primary subscription (net of the servicing fee). */
export function primaryYield(inv, nowTs, feeBps = SERVICING_FEE_BPS) {
  const days = Math.max(1, Math.ceil((inv.dueDate - (inv.status >= 3 ? nowTs : nowTs)) / DAY));
  const payout = inv.face * (1 - feeBps / 10000);
  return annualised(inv.price, payout, days);
}

/** Linear accretion from purchase price to face value over the tenor. */
export function fairValue(inv, notes, nowTs) {
  const start = inv.fundedAt || nowTs;
  const total = Math.max(1, inv.dueDate - start);
  const elapsed = Math.min(Math.max(0, nowTs - start), total);
  const p = inv.price / inv.face;
  return Math.round(notes * (p + (1 - p) * (elapsed / total)));
}

/** What `who` paid for the tokens it holds now: primary subscription plus DDEx purchases,
 *  at their average cost per token. Returns null when there is no purchase record (e.g. a transfer). */
export function costBasis(snap, inv, who) {
  const bal = inv.holders.find((h) => h.who === who)?.bal || 0;
  if (!bal) return 0;
  let cash = 0;
  let tokens = 0;
  const c = inv.status >= 4 ? inv.commitments.find((x) => x.investor === who) : null;
  if (c) { cash += c.cash; tokens += c.notes; }
  for (const l of snap.listings) {
    if (l.invoiceId === inv.id && l.buyer === who) { cash += l.price; tokens += l.amount; }
  }
  if (!tokens) return null;
  return Math.round((cash / tokens) * bal);
}

/** Token count for display: 1 token = S$1 of face value, 2 decimals. */
export const tokens = (units) => `${(units / 100).toLocaleString("en-SG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} tokens`;

export function payoutFor(notes, feeBps = SERVICING_FEE_BPS) {
  return Math.floor(notes * (1 - feeBps / 10000));
}

/**
 * Per-investor results for one invoice, from its actual cash flows.
 *   commitments: [{ investor, cash, notes }]      primary subscription (day 0 = fundedAt)
 *   trades:      [{ seller, buyer, amount, price, filledAt }]   filled DDEx trades
 *   dists:       [{ holder, amount, notes }]      maturity payouts (at maturityTs)
 * Annualised return uses capital-days: each payment in counts from when it was paid until
 * the investor's last cash flow, and money received back early (a DDEx sale) stops counting
 * from the day it came back.
 */
export function investorResults({ commitments, trades, dists, fundedAt, maturityTs, tbillRate = TBILL.rate }) {
  const rows = {};
  const row = (k) => (rows[k] ||= { k, invested: 0, primaryTokens: 0, boughtCost: 0, boughtTokens: 0, soldProceeds: 0, soldTokens: 0, maturityPayout: 0, maturityTokens: 0, flows: [], sales: [], buys: [] });
  for (const c of commitments) {
    const r = row(c.investor);
    r.invested += c.cash; r.primaryTokens += c.notes;
    r.flows.push([-c.cash, fundedAt]);
  }
  for (const t of trades) {
    const b = row(t.buyer), s = row(t.seller);
    b.boughtCost += t.price; b.boughtTokens += t.amount; b.flows.push([-t.price, t.filledAt]); b.buys.push(t);
    s.soldProceeds += t.price; s.soldTokens += t.amount; s.flows.push([t.price, t.filledAt]); s.sales.push(t);
  }
  for (const d of dists) {
    const r = row(d.holder);
    r.maturityPayout += d.amount; r.maturityTokens += d.notes;
    r.flows.push([d.amount, maturityTs]);
  }
  return Object.values(rows).map((r) => {
    const paidIn = r.invested + r.boughtCost;
    const received = r.soldProceeds + r.maturityPayout;
    const end = Math.max(...r.flows.map(([, t]) => t));
    // payments in count until `end`; money back before `end` stops counting when it arrives
    const capitalDays = r.flows.reduce((s, [a, t]) => s - a * ((end - t) / DAY), 0);
    const avgDays = paidIn ? capitalDays / paidIn : 0;
    const profit = received - paidIn;
    const ann = capitalDays > 0 && avgDays >= 1 ? (profit / capitalDays) * 365 * 100 : null;
    const tbillEarn = capitalDays > 0 ? (capitalDays / 365) * (tbillRate / 100) : 0;
    const firstSaleDays = r.sales.length ? Math.round((Math.min(...r.sales.map((t) => t.filledAt)) - fundedAt) / DAY) : null;
    const soldAll = r.soldTokens > 0 && r.maturityTokens === 0;
    return { ...r, paidIn, received, profit, capitalDays, ann, tbillEarn, firstSaleDays, soldAll };
  }).sort((a, b) => b.paidIn - a.paidIn);
}

export const tbill = TBILL;
export const actorName = (k) => ACTORS[k]?.name || (typeof k === "string" ? `${k.slice(0, 6)}…${k.slice(-4)}` : "");
export const actorShort = (k) => ACTORS[k]?.short || actorName(k);
