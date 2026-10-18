import React, { useState } from "react";
import { ACTORS, GRADES, MIN_FINANCING_PCT, TRADITIONAL } from "../../../shared/constants.mjs";
import { sgd, date, pct, days } from "../format.js";
import { GradeChip, StatusPill, Hash, Progress, Button, Lifecycle, KV, Empty } from "../ui.jsx";
import { actorName } from "../model.js";

export default function SmeView({ persona, snap, inbox, actions, run, busy, ledger }) {
  const mine = snap.invoices.filter((i) => i.supplier === persona).sort((a, b) => b.id - a.id);
  const myInbox = inbox.filter((e) => e.supplierKey === persona);
  const received = mine.filter((i) => i.status >= 4 && i.status !== 7).reduce((s, i) => s + i.price, 0);

  return (
    <div className="view">
      <header className="view-head">
        <div>
          <h1>{ACTORS[persona].name}</h1>
          <p className="sub">SME supplier · UEN {ACTORS[persona].uen} · GST-registered, connected to InvoiceNow</p>
        </div>
        <div className="stat-row">
          <div className="stat"><span>Wallet (tSGD)</span><strong>{sgd(snap.balances[persona])}</strong></div>
          <div className="stat"><span>Paid by ReceivaSG</span><strong>{sgd(received)}</strong></div>
        </div>
      </header>

      <section className="panel">
        <div className="panel-head">
          <h2>InvoiceNow inbox</h2>
          <p>E-invoices synced from your accounting system over the Peppol network, with your buyers' responses.</p>
        </div>
        {myInbox.length === 0 ? <Empty>No e-invoices synced for this company in the demo.</Empty> : (
          <div className="inbox">
            {myInbox.map((e) => (
              <InboxRow key={e.doc.id} entry={e} snap={snap} persona={persona} actions={actions} run={run} busy={busy} />
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Financing</h2>
          <p>Invoices you have submitted to ReceivaSG, from verification to the buyer's payment.</p>
        </div>
        {mine.length === 0 ? <Empty>Nothing submitted yet. Choose an approved invoice above and request financing.</Empty> : (
          <div className="stack">
            {mine.map((inv) => (
              <FinancingCard key={inv.id} inv={inv} snap={snap} persona={persona} actions={actions} run={run} busy={busy} ledger={ledger} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function InboxRow({ entry, snap, persona, actions, run, busy }) {
  const [open, setOpen] = useState(false);
  const { doc } = entry;
  const onChain = snap.invoices.find((i) => i.docHash === entry.hash && i.status !== 7);
  const approved = doc.buyerResponse.code === "AP";
  const key = `submit-${doc.id}`;
  return (
    <article className={`inbox-row${open ? " open" : ""}`}>
      <div className="inbox-main">
        <div className="inbox-id">
          <strong>{doc.id}</strong>
          <span>{doc.buyer.name}</span>
        </div>
        <div className="num">{sgd(doc.totals.payable * 100)}</div>
        <div className="inbox-terms">
          <span>{doc.paymentTerms}</span>
          <span>due {date(entry.dueTs)}</span>
        </div>
        <div>
          <span className={`pill ${approved ? "good" : "warn"}`}>{approved ? "Buyer approved" : "Buyer query open"}</span>
        </div>
        <div className="inbox-actions">
          <button type="button" className="link" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? "Hide e-invoice" : "View e-invoice"}
          </button>
          {onChain ? (
            <>
              <span className="muted-s">Submitted as #{onChain.id}</span>
              <Button
                kind="ghost"
                small
                busy={busy[`dup-${doc.id}`]}
                title="Try to finance the same receivable twice"
                onClick={() => run(`dup-${doc.id}`, () => actions.submitInvoice(persona, entry, "again (double-pledge test)"))}
              >
                Submit again
              </Button>
            </>
          ) : (
            <Button
              id={`btn-${key}`}
              small
              busy={busy[key]}
              disabled={!approved}
              title={approved ? "" : "The buyer has not approved this invoice on InvoiceNow"}
              onClick={() => run(key, () => actions.submitInvoice(persona, entry), `${doc.id} submitted. ReceivaSG will verify it next.`)}
            >
              Request financing
            </Button>
          )}
        </div>
      </div>
      {!approved ? <p className="inbox-why">{doc.buyer.name} queried this invoice on InvoiceNow. Only buyer-approved invoices can be financed.</p> : null}
      {open ? <EInvoice entry={entry} /> : null}
    </article>
  );
}

export function EInvoice({ entry }) {
  const { doc } = entry;
  const l = doc.lines[0];
  return (
    <div className="einv">
      <div className="einv-head">
        <div>
          <span className="einv-kicker">Tax invoice · Peppol BIS Billing 3.0 (SG)</span>
          <strong>{doc.id}</strong>
        </div>
        <div className="einv-dates">
          <span>Issued {doc.issueDate}</span>
          <span>Due {doc.dueDate}</span>
        </div>
      </div>
      <div className="einv-parties">
        <div><span>From</span><strong>{doc.supplier.name}</strong><code>{doc.supplier.peppolId}</code></div>
        <div><span>To</span><strong>{doc.buyer.name}</strong><code>{doc.buyer.peppolId}</code></div>
      </div>
      <table className="einv-lines">
        <thead><tr><th>Description</th><th className="r">Net</th><th className="r">GST {l.gstRate}%</th></tr></thead>
        <tbody><tr><td>{l.description}</td><td className="r">{sgd(l.net * 100, { dp: 2 })}</td><td className="r">{sgd(l.gst * 100, { dp: 2 })}</td></tr></tbody>
        <tfoot><tr><td>Total payable ({doc.currency})</td><td colSpan={2} className="r"><strong>{sgd(doc.totals.payable * 100, { dp: 2 })}</strong></td></tr></tfoot>
      </table>
      <div className="einv-foot">
        <span>Buyer response: <strong>{doc.buyerResponse.code}</strong> ({doc.buyerResponse.meaning})</span>
        <span>Document hash recorded on-chain: <Hash value={entry.hash} a={10} b={8} /></span>
      </div>
    </div>
  );
}

function FinancingCard({ inv, snap, persona, actions, run, busy, ledger }) {
  const tenor = Math.max(1, Math.ceil((inv.dueDate - (inv.fundedAt || snap.time)) / 86400));
  const settleEntry = ledger.find((e) => e.events?.some((ev) => ev.name === "AtomicSettlement" && Number(ev.args.id) === inv.id));
  const paidEntry = ledger.find((e) => e.events?.some((ev) => ev.name === "BuyerPaid" && Number(ev.args.id) === inv.id));
  const cost = inv.face - inv.price;
  return (
    <article className="fin-card">
      <div className="fin-top">
        <div>
          <h3>{inv.ref} <span className="muted-s">#{inv.id}</span></h3>
          <p className="sub">{actorName(inv.buyer)} · {sgd(inv.face)} · due {date(inv.dueDate)}</p>
        </div>
        <StatusPill status={inv.status} />
      </div>
      <Lifecycle inv={inv} />

      {inv.status === 1 ? (
        <p className="fin-msg">ReceivaSG is checking this invoice against the InvoiceNow record and grading {actorName(inv.buyer)}'s credit.</p>
      ) : null}

      {inv.status === 2 ? (
        <div className="offer">
          <div className="offer-main">
            <GradeChip grade={inv.grade} size="lg" />
            <div>
              <span className="offer-k">ReceivaSG offers</span>
              <strong className="offer-amt">{sgd(inv.price)}</strong>
              <span className="offer-sub">{pct((inv.price / inv.face) * 100, 1)} of face value, paid today · cost {sgd(cost)} for {days(tenor)}</span>
            </div>
          </div>
          <ul className="ticks">
            <li>An outright sale to the ReceivaSG SPV. It is not a loan, so there is no interest to repay.</li>
            <li>Nothing is held back: you receive the full {sgd(inv.price)} in one settlement.</li>
            <li>{inv.floorApplied ? `The ${MIN_FINANCING_PCT}% minimum financing percentage applied to this offer.` : `Every offer is at least ${MIN_FINANCING_PCT}% of face value, whatever the grade.`}</li>
          </ul>
          <div className="compare">
            <div>
              <span>ReceivaSG</span>
              <strong>{sgd(inv.price)} today</strong>
              <em>Outright sale, no reserve, no interest</em>
            </div>
            <div>
              <span>Conventional invoice financing</span>
              <strong>Up to {sgd(Math.round(inv.face * TRADITIONAL.advancePctHigh) / 100)} advanced</strong>
              <em>Borrowed against the invoice; interest and fees apply; the balance comes after the buyer pays</em>
            </div>
          </div>
          <div className="row-actions">
            <Button id="btn-accept" busy={busy[`accept-${inv.id}`]} onClick={() => run(`accept-${inv.id}`, () => actions.acceptOffer(persona, inv.id, inv.ref), `${inv.ref} sold to the SPV. Investors can now fund it.`)}>
              Accept and sell for {sgd(inv.price)}
            </Button>
            <Button kind="ghost" busy={busy[`decline-${inv.id}`]} onClick={() => run(`decline-${inv.id}`, () => actions.declineOffer(persona, inv.id, inv.ref), "Offer declined. The invoice stays with you.")}>
              Decline
            </Button>
          </div>
        </div>
      ) : null}

      {inv.status === 3 ? (
        <div className="fin-body">
          <p className="fin-msg">Sold to the SPV. Investors are funding it now; you are paid automatically the moment it is fully funded.</p>
          <Progress value={inv.committed} max={inv.price} />
          <p className="muted-s">{sgd(inv.committed)} of {sgd(inv.price)} committed by {inv.commitments.length} investor{inv.commitments.length === 1 ? "" : "s"}</p>
        </div>
      ) : null}

      {inv.status >= 4 && inv.status <= 6 ? (
        <KV
          items={[
            ["Received", <span className="good-t">{sgd(inv.price)} on {date(inv.fundedAt)}</span>],
            settleEntry ? ["Settlement", <span>block #{settleEntry.block}, one transaction <Hash value={settleEntry.hash} /></span>] : null,
            ["Buyer pays", <span>ReceivaSG SPV directly (notice of assignment sent to {actorName(inv.buyer)})</span>],
            inv.status === 5 ? ["Closed", <span>{actorName(inv.buyer)} paid {sgd(inv.face)} on {date(inv.closedAt)}{paidEntry ? ` (block #${paidEntry.block})` : ""}. Nothing more for you to do.</span>] : null,
            inv.status === 6 ? ["Closed", <span>The buyer defaulted. The sale was without recourse, so you owe nothing.</span>] : null,
          ]}
        />
      ) : null}

      {inv.status === 7 ? <p className="fin-msg">Cancelled. The invoice was not sold.</p> : null}
    </article>
  );
}

export { GRADES };
