import React from "react";
import { ACTORS, DAY } from "../../../shared/constants.mjs";
import { sgd, date } from "../format.js";
import { StatusPill, Button, Empty, Hash, KV } from "../ui.jsx";
import { actorName, actorShort } from "../model.js";

export default function BuyerView({ persona, snap, actions, run, busy, ledger, client }) {
  const payables = snap.invoices.filter((i) => i.buyer === persona && i.status !== 7).sort((a, b) => b.id - a.id);
  const owed = payables.filter((i) => i.status === 4).reduce((s, i) => s + i.face, 0);
  return (
    <div className="view">
      <header className="view-head">
        <div>
          <h1>{ACTORS[persona].name}</h1>
          <p className="sub">Corporate buyer · UEN {ACTORS[persona].uen} · pays its suppliers through InvoiceNow</p>
        </div>
        <div className="stat-row">
          <div className="stat"><span>Wallet (tSGD)</span><strong>{sgd(snap.balances[persona])}</strong></div>
          <div className="stat"><span>Owed to the ReceivaSG SPV</span><strong>{sgd(owed)}</strong></div>
        </div>
      </header>
      <section className="panel">
        <div className="panel-head">
          <h2>Payables</h2>
          <p>Supplier invoices you approved on InvoiceNow. When a supplier sells one to ReceivaSG, you receive a notice of assignment and pay the SPV instead of the supplier. The amount and due date don't change.</p>
        </div>
        {payables.length === 0 ? <Empty>No payables involving ReceivaSG yet.</Empty> : (
          <div className="stack">
            {payables.map((inv) => {
              const dist = ledger.find((e) => e.events?.some((ev) => ev.name === "BuyerPaid" && Number(ev.args.id) === inv.id));
              const daysLeft = Math.ceil((inv.dueDate - snap.time) / DAY);
              return (
                <article key={inv.id} className="fin-card">
                  <div className="fin-top">
                    <div>
                      <h3>{inv.ref} <span className="muted-s">from {actorName(inv.supplier)}</span></h3>
                      <p className="sub">{sgd(inv.face)} · due {date(inv.dueDate)}{inv.status === 4 ? ` · ${daysLeft >= 0 ? `${daysLeft} days left` : `${-daysLeft} days overdue`}` : ""}</p>
                    </div>
                    <StatusPill status={inv.status} />
                  </div>
                  {inv.status >= 3 ? (
                    <div className="assign">
                      <strong>Notice of assignment</strong>
                      <p>{actorName(inv.supplier)} has sold this receivable to the ReceivaSG SPV. Pay {sgd(inv.face)} to the SPV on or before {date(inv.dueDate)}.</p>
                      <KV items={[["Pay to", <span>ReceivaSG SPV <Hash value={client.addresses.spv} /></span>], ["Invoice NFT", `RSG-INV #${inv.id}, held by the SPV`]]} />
                    </div>
                  ) : <p className="fin-msg">Your supplier has asked ReceivaSG to finance this invoice. Nothing changes for you until it is sold.</p>}
                  {inv.status === 4 ? (
                    <div className="row-actions">
                      <Button id={`btn-repay-${inv.id}`} busy={busy[`repay-${inv.id}`]} onClick={() => run(`repay-${inv.id}`, () => actions.repay(persona, inv), `Paid ${sgd(inv.face)}. The contract paid every note holder in the same transaction.`)}>
                        Pay {sgd(inv.face)} to the SPV
                      </Button>
                    </div>
                  ) : null}
                  {inv.status === 5 && dist ? (
                    <div className="dist">
                      <strong>Paid on {date(inv.closedAt)}, block #{dist.block}</strong>
                      <ul>
                        {dist.events.filter((ev) => ev.name === "Distribution").map((ev, i) => (
                          <li key={i}><span>{actorShort(client.actorOf(ev.args.holder))}</span><span className="num">{sgd(Number(ev.args.amount))}</span></li>
                        ))}
                        {dist.events.filter((ev) => ev.name === "BuyerPaid").map((ev, i) => (
                          <li key={`f${i}`} className="muted-s"><span>ReceivaSG servicing fee</span><span className="num">{sgd(Number(ev.args.servicingFee))}</span></li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
