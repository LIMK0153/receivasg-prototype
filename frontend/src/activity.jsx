import React, { useState } from "react";
import { GRADES } from "../../shared/constants.mjs";
import { sgd } from "./format.js";
import { actorShort } from "./model.js";

const ZERO = "0x0000000000000000000000000000000000000000";

function who(client, addr) {
  if (!addr) return "";
  if (addr.toLowerCase() === ZERO) return "∅";
  const k = client.actorOf(addr);
  if (k) return actorShort(k);
  const lower = addr.toLowerCase();
  for (const [name, a] of Object.entries(client.addresses)) if (a.toLowerCase() === lower) return { spv: "SPV", market: "DDEx", tsgd: "tSGD", nft: "Invoice NFT", registry: "Registry", noteImpl: "Note template" }[name];
  return `${addr.slice(0, 6)}…`;
}

export function describe(ev, client) {
  const a = ev.args;
  const c = client.contractName(ev.address);
  const n = (x) => Number(x);
  switch (ev.name) {
    case "Transfer":
      if (c === "InvoiceNFT") return `Invoice NFT #${n(a.tokenId ?? a[2])} minted to ${who(client, a.to)}`;
      if (c === "TokenisedSGD") return `tSGD ${sgd(n(a.value))}: ${who(client, a.from)} → ${who(client, a.to)}`;
      if (a.from === ZERO) return `Notes minted: ${sgd(n(a.value))} face to ${who(client, a.to)}`;
      if (a.to === ZERO) return `Notes retired: ${sgd(n(a.value))} from ${who(client, a.from)}`;
      return `Notes ${sgd(n(a.value))}: ${who(client, a.from)} → ${who(client, a.to)}`;
    case "Approval": return `${who(client, a.owner)} approved ${who(client, a.spender)} for ${sgd(n(a.value))}`;
    case "InvoiceSubmitted": return `Invoice #${n(a.id)} submitted: ${sgd(n(a.faceValue))} owed by ${who(client, a.buyer)}`;
    case "InvoiceVerified": return `Invoice #${n(a.id)} graded ${GRADES[n(a.grade)]}, priced at ${sgd(n(a.price))}${a.floorApplied ? " (85% floor)" : ""}`;
    case "InvoiceAssigned": return `True sale: invoice #${n(a.id)} assigned to the SPV, note series created`;
    case "NoticeOfAssignment": return `Notice of assignment to ${who(client, a.buyer)}: pay the SPV`;
    case "FundingCommitted": return `${who(client, a.investor)} committed ${sgd(n(a.cash))} (total ${sgd(n(a.totalCommitted))})`;
    case "CommitmentWithdrawn": return `${who(client, a.investor)} withdrew ${sgd(n(a.cash))}`;
    case "AtomicSettlement": return `Atomic settlement: ${who(client, a.supplier)} paid ${sgd(n(a.paidToSupplier))}, ${n(a.investors)} investors received notes`;
    case "BuyerPaid": return `${who(client, a.payer)} paid ${sgd(n(a.amount))}; servicing fee ${sgd(n(a.servicingFee))}`;
    case "Distribution": return `Paid ${sgd(n(a.amount))} to ${who(client, a.holder)} for ${sgd(n(a.notes))} of notes`;
    case "InvoiceDefaulted": return `Invoice #${n(a.id)} defaulted; ${sgd(n(a.recovered))} recovered and distributed`;
    case "CounterOffered": return `SME counter-offered ${sgd(n(a.counterPrice))} against the ${sgd(n(a.offeredPrice))} offer on invoice #${n(a.id)}`;
    case "CounterReviewed": return a.approved ? `ReceivaSG approved the counter-offer: invoice #${n(a.id)} now priced at ${sgd(n(a.price))}` : `ReceivaSG rejected the counter-offer: invoice #${n(a.id)} stays at ${sgd(n(a.price))}`;
    case "OfferDeclined": return `SME declined the offer on invoice #${n(a.id)}`;
    case "InvoiceRejected": return `Invoice #${n(a.id)} rejected: ${a.reason}`;
    case "StatusUpdated": return `Invoice NFT #${n(a.tokenId)} status → ${["", "Submitted", "Offered", "Listed", "Funded", "Repaid", "Defaulted", "Cancelled"][n(a.status)]}`;
    case "Retired": return `Note series for invoice #${n(a.invoiceId)} retired`;
    case "Paused": return a.paused ? "Note transfers paused by the agent" : "Note transfers resumed";
    case "Listed": return `DDEx listing #${n(a.listingId)}: ${sgd(n(a.amount))} of notes at ${sgd(n(a.price))}`;
    case "Trade": return `DDEx trade: ${who(client, a.buyer)} bought ${sgd(n(a.amount))} of notes from ${who(client, a.seller)} for ${sgd(n(a.price))}`;
    case "Cancelled": return `DDEx listing #${n(a.listingId)} cancelled`;
    case "IdentityRegistered": return `Identity registered: ${who(client, a.wallet)}`;
    case "IdentityRemoved": return `Identity removed: ${who(client, a.wallet)}`;
    case "RoleGranted": return "Role granted";
    default: return ev.name;
  }
}

export function EventList({ events, client }) {
  if (!events || !events.length) return <p className="muted-s">No events emitted.</p>;
  return (
    <ul className="events">
      {events.map((ev, i) => (
        <li key={i}>
          <code>{ev.name}</code>
          <span>{describe(ev, client)}</span>
        </li>
      ))}
    </ul>
  );
}

export function Activity({ ledger, client, onOpenExplorer, onClose }) {
  const live = ledger.filter((e) => !e.setup);
  const setupCount = ledger.length - live.length;
  const [open, setOpen] = useState(null);
  return (
    <aside className="activity" aria-label="Chain activity">
      <div className="act-head">
        <h2>Blockchain activity</h2>
        <span className="act-links">
          <button type="button" className="link" onClick={onOpenExplorer}>View all</button>
          {onClose ? <button type="button" className="x" onClick={onClose} aria-label="Hide blockchain activity">×</button> : null}
        </span>
      </div>
      {live.length === 0 ? <p className="muted-s">Contracts deployed and demo data seeded in {setupCount} transactions. Your actions will appear here.</p> : null}
      <ol className="act-list">
        {live.slice(0, 18).map((e) => {
          const settle = e.events?.some((ev) => ev.name === "AtomicSettlement");
          const payout = e.events?.some((ev) => ev.name === "Distribution");
          const isOpen = open === e.id || (open === null && (settle || payout) && e === live[0]);
          return (
            <li key={e.id} className={`act ${e.status}${settle || payout ? " key" : ""}`}>
              <button type="button" className="act-btn" onClick={() => setOpen(isOpen ? -1 : e.id)} aria-expanded={isOpen}>
                <span className="act-block">{e.status === "time" ? "⏱" : e.block != null ? `#${e.block}` : "…"}</span>
                <span className="act-label">{e.label}</span>
                {e.status === "reverted" ? <span className="pill bad">reverted</span> : settle ? <span className="pill good">atomic settlement</span> : payout ? <span className="pill good">pro-rata payout</span> : null}
              </button>
              {isOpen ? (
                <div className="act-detail">
                  {e.error ? <p className="field-err">{e.error}</p> : null}
                  {e.status !== "time" ? <EventList events={e.events} client={client} /> : <p className="muted-s">Chain clock moved forward.</p>}
                  {e.gasUsed ? <p className="muted-s">Gas used {e.gasUsed.toLocaleString("en-SG")} · one transaction</p> : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
      {setupCount ? <p className="muted-s act-foot">Plus {setupCount} setup transactions (deployment, KYC records, tSGD balances, three background invoices).</p> : null}
    </aside>
  );
}
