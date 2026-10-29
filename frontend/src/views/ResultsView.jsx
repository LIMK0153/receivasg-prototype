import React from "react";
import { ACTORS, TBILL, TRADITIONAL, DAY } from "../../../shared/constants.mjs";
import { sgd, pct, date } from "../format.js";
import { GradeChip, Hash, Empty } from "../ui.jsx";
import { actorShort } from "../model.js";
import { mainInvoice } from "../guided.js";

export default function ResultsView({ snap, ledger, client }) {
  const m = mainInvoice(snap);
  if (!m || m.status < 5) {
    return (
      <div className="view">
        <header className="view-head"><div><h1>Results</h1><p className="sub">The scorecard for INV-2026-0412</p></div></header>
        <section className="panel"><Empty>Results appear once Straits Marine has paid INV-2026-0412. Follow the guided demo, or run the steps yourself.</Empty></section>
      </div>
    );
  }
  const find = (name) => ledger.find((e) => e.events?.some((ev) => ev.name === name && Number(ev.args.id) === m.id));
  const settle = find("AtomicSettlement");
  const paid = find("BuyerPaid");
  const dists = paid ? paid.events.filter((ev) => ev.name === "Distribution") : [];
  const fee = paid ? Number(paid.events.find((ev) => ev.name === "BuyerPaid").args.servicingFee) : 0;
  const trades = snap.listings.filter((l) => l.invoiceId === m.id && l.buyer);
  // On a live network the clock can't be fast-forwarded, so the buyer pays early.
  // Returns are then measured over the scheduled tenor (to the due date).
  const early = m.closedAt < m.dueDate - DAY;
  const maturityTs = early ? m.dueDate : m.closedAt;
  const tenorDays = Math.round((maturityTs - m.fundedAt) / DAY);

  // Per-investor cash flows: [amount, time] with negative = paid out
  const flows = {};
  const add = (k, amt, t) => (flows[k] ||= []).push([amt, t]);
  for (const c of m.commitments) add(c.investor, -c.cash, m.fundedAt);
  for (const t of trades) { add(t.buyer, -t.price, t.filledAt); add(t.seller, t.price, t.filledAt); }
  for (const d of dists) add(client.actorOf(d.args.holder) || d.args.holder, Number(d.args.amount), maturityTs);

  const rows = Object.entries(flows).map(([k, fs]) => {
    const paidIn = -fs.filter(([a]) => a < 0).reduce((s, [a]) => s + a, 0);
    const back = fs.filter(([a]) => a > 0).reduce((s, [a]) => s + a, 0);
    const end = Math.max(...fs.map(([, t]) => t));
    // money-weighted: profit / Σ(cash × days outstanding)
    const cashDays = fs.filter(([a]) => a < 0).reduce((s, [a, t]) => s + -a * ((end - t) / DAY), 0);
    const ann = cashDays > 0 ? ((back - paidIn) / cashDays) * 365 * 100 : 0;
    const tbillEarn = (cashDays / 365) * (TBILL.rate / 100);
    const sold = trades.some((t) => t.seller === k);
    const heldDays = cashDays / Math.max(paidIn, 1);
    return { k, paidIn, back, profit: back - paidIn, ann: heldDays >= 1 ? ann : null, tbillEarn, days: Math.round(heldDays), sold };
  }).sort((a, b) => b.paidIn - a.paidIn);

  const smeCostPct = ((m.face - m.price) / m.face) * 100;

  return (
    <div className="view">
      <header className="view-head">
        <div>
          <h1>Results: INV-2026-0412</h1>
          <p className="sub">{sgd(m.face)} owed by Straits Marine · grade <GradeChip grade={m.grade} /> · funded {date(m.fundedAt)}, paid {date(m.closedAt)}{early ? `, ahead of the ${date(m.dueDate)} due date` : ` (${tenorDays} days)`}</p>
        </div>
      </header>

      <section className="panel results-sme">
        <div className="panel-head"><h2>Meridian Engineering (SME)</h2></div>
        <div className="cmp3">
          <div><span>Received from ReceivaSG</span><strong>{sgd(m.price)}</strong><em>on day 0, in one settlement</em></div>
          <div><span>Waiting for the buyer instead</span><strong>{sgd(m.face)}</strong><em>on day {tenorDays}, the due date</em></div>
          <div><span>Cost of being paid {tenorDays} days early</span><strong>{sgd(m.face - m.price)}</strong><em>{pct(smeCostPct, 1)} of face value. No interest, no reserve, no recourse</em></div>
        </div>
        <p className="muted-s">Conventional invoice financing would typically advance {TRADITIONAL.advanceRange} of the invoice as a loan, with interest and fees, and release the balance only after the buyer pays.</p>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Investors</h2>
          <p>Returns are annualised on the cash each investor had outstanding, and compared with putting the same cash in the {TBILL.label} at {pct(TBILL.rate)} p.a. ({TBILL.source}).{early ? " The buyer paid before the due date (a live network's clock can't be fast-forwarded), so held-to-maturity returns are measured over the scheduled tenor. Positions held for under a day show no annualised figure." : ""}</p>
        </div>
        <div className="table-wrap">
          <table className="grid">
            <thead><tr><th>Investor</th><th>Route</th><th className="r">Paid in</th><th className="r">Received</th><th className="r">Profit</th><th className="r">Annualised</th><th className="r">Same cash in T-bills</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.k}>
                  <td><strong>{ACTORS[r.k]?.name || r.k}</strong></td>
                  <td>{r.sold ? (r.days >= 1 ? `Sold on DDEx after ~${r.days} days` : "Sold on DDEx before maturity") : trades.some((t) => t.buyer === r.k) ? "Primary + bought on DDEx, held to maturity" : "Held to maturity"}</td>
                  <td className="r">{sgd(r.paidIn)}</td>
                  <td className="r">{sgd(r.back)}</td>
                  <td className="r good-t">{sgd(r.profit, { sign: true })}</td>
                  <td className="r"><strong>{r.ann === null ? "—" : pct(r.ann, 2)}</strong></td>
                  <td className="r">{sgd(Math.round(r.tbillEarn), { sign: true })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>What the contracts did</h2></div>
        <ul className="proof">
          <li>
            <strong>One transaction to fund the SME.</strong> Both investors' cash, their token mints and the {sgd(m.price)} payment to Meridian all happened in block #{settle?.block}. <Hash value={settle?.hash} />
          </li>
          <li>
            <strong>One transaction to pay everyone at maturity.</strong> Straits Marine's {sgd(m.face)} {dists.length === 1 ? `went to the token holder on the due date, ${actorShort(client.actorOf(dists[0].args.holder))},` : `was split pro rata across ${dists.length} token holders`} and {sgd(fee)} went to ReceivaSG as the servicing fee, in block #{paid?.block}. <Hash value={paid?.hash} />
          </li>
          {trades.length ? (
            <li>
              <strong>Paid to whoever held the tokens on the due date.</strong> Lion Gate sold on DDEx, so its share went to Lim & Pang. No one had to update a register by hand.
            </li>
          ) : null}
          <li>
            <strong>No cash parked in between.</strong> The SPV's tSGD balance is {sgd(snap.spvCash)}: investors' cash stayed in their own wallets until settlement, and nothing sat in escrow.
          </li>
          <li>
            <strong>Capital back in half the time.</strong> These tokens matured {Math.round((m.dueDate - m.fundedAt) / DAY)} days after funding; a {TBILL.label} ties cash up for about {TBILL.tenorDays} days.
          </li>
          <li>
            <strong>Compliance enforced by the token itself.</strong> The unverified wallet's purchase reverted inside the token contract, so no ERC-3643 token ever reached a wallet without KYC.
          </li>
        </ul>
      </section>
    </div>
  );
}

