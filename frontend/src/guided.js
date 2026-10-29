// Presenter checklist: the press-release example as a sequence of things YOU click.
// Nothing here performs an action. Each step says which account to use and what to
// click, highlights that control on the page, and ticks itself off when the chain
// state shows it happened.
import { DAY } from "../../shared/constants.mjs";
import { sgd } from "./format.js";

export const MAIN_REF = "INV-2026-0412";
export const LION_GATE_COMMIT = 5_000_000; // S$50,000 in cents

export function mainInvoice(snap) {
  return snap.invoices.filter((i) => i.ref === MAIN_REF && i.status !== 7).sort((a, b) => b.id - a.id)[0];
}

export function buildSteps({ snap, flags, ledger = [], canTimeTravel = true }) {
  const m = mainInvoice(snap);
  const id = m?.id;
  const price = m?.price || 9_800_000;
  const hasCommit = (k) => m && (m.status >= 4 || m.commitments.some((c) => c.investor === k));
  const aListing = m && snap.listings.filter((l) => l.invoiceId === m.id && l.seller === "investorA").sort((a, b) => b.id - a.id)[0];
  const countered = m && ledger.some((e) => e.events?.some((ev) => ev.name === "CounterOffered" && Number(ev.args.id) === m.id));
  const ffNote = canTimeTravel ? "" : " (skipped on a live network: the buyer can pay early)";

  return [
    {
      id: "submit", actor: "sme", view: ["sme"],
      title: "Meridian requests financing for INV-2026-0412",
      how: "In the InvoiceNow inbox, click Request financing on INV-2026-0412.",
      why: "S$100,000 owed by Straits Marine, due in 90 days, already approved by the buyer on InvoiceNow.",
      cue: "#btn-submit-INV-2026-0412",
      done: !!m,
    },
    {
      id: "verify", actor: "admin", view: ["ops", "queue"],
      title: "ReceivaSG verifies the invoice and grades the buyer",
      how: "Check the InvoiceNow results and the credit score, then click Verify and grade A.",
      why: "The contract prices a grade-A, 90-day invoice at S$98,000.",
      cue: "#btn-verify",
      done: m && m.status >= 2,
    },
    {
      id: "counter", actor: "sme", view: ["sme"], optional: true, skipFlag: "skipCounter",
      title: "Optional: Meridian counter-offers",
      how: m && m.counterMax ? `Click Counter-offer, enter a price up to ${sgd(m.counterMax)} and click Send counter-offer.` : "Click Counter-offer, enter a higher price and click Send counter-offer.",
      why: "Instead of accepting or declining, the SME can ask for more, up to what the next-better grade would pay. Skip this to keep the press-release numbers.",
      cue: "#btn-counter",
      done: flags.skipCounter || countered || (m && m.status >= 3),
    },
    {
      id: "review", actor: "admin", view: ["ops", "queue"],
      title: "ReceivaSG reviews the counter-offer",
      how: "Compare investors' return at the counter price with the original offer, then click Approve or Reject.",
      why: "Approving makes the counter the new price; rejecting keeps the original offer.",
      cue: "#btn-approve-counter",
      done: !m || m.status >= 3 || !(m.counterPrice > 0),
    },
    {
      id: "accept", actor: "sme", view: ["sme"],
      title: "Meridian accepts and sells the invoice to the SPV",
      how: `Under Financing, review the offer and click Accept and sell for ${sgd(price)}.`,
      why: "True sale: Invoice NFT minted to the SPV, notice of assignment to the buyer, token series created.",
      cue: "#btn-accept",
      done: m && m.status >= 3,
    },
    {
      id: "commitA", actor: "investorA", view: ["investor", "market"],
      title: "Lion Gate Family Office invests S$50,000",
      how: "In the Marketplace, type 50000 in the INV-2026-0412 card and click Commit.",
      why: "The cash stays in Lion Gate's wallet until the invoice is fully funded.",
      cue: id ? `#amt-${id}` : null,
      done: hasCommit("investorA"),
    },
    {
      id: "commitB", actor: "investorB", view: ["investor", "market"],
      title: `Lim & Pang Capital invests the remaining ${sgd(price - LION_GATE_COMMIT)}`,
      how: "Click Fill remaining on the INV-2026-0412 card, then Commit.",
      why: "This fills the invoice: both investors' cash moves, tokens are minted and Meridian is paid, all in one transaction.",
      cue: id ? `#fill-${id}` : null,
      done: m && m.status >= 4,
    },
    {
      id: "ff30", actor: null, view: null,
      title: `30 days pass${ffNote}`,
      how: "Open Demo tools in the header and choose +30 days.",
      why: "The tokens move closer to paying out as the due date approaches.",
      cue: "#btn-demo-tools",
      done: m && m.status >= 4 && (!canTimeTravel || snap.time >= m.fundedAt + 29 * DAY || !!aListing || m.status >= 5),
    },
    {
      id: "list", actor: "investorA", view: ["investor", "ddex"],
      title: "Lion Gate sells its tokens on DDEx",
      how: "Open DDEx market. Under Sell your tokens, keep the suggested holding, amount and price, and click List.",
      why: "Lion Gate doesn't hold to maturity: DBS's Digital Exchange lets it exit early.",
      cue: "#btn-list",
      done: !!aListing || (m && m.status >= 5),
    },
    {
      id: "blocked", actor: "unverified", view: ["investor", "ddex"],
      title: "A wallet without KYC tries to buy them",
      how: "Switch to the Unverified wallet and click Buy on Lion Gate's listing. It should be refused.",
      why: "It has S$50,000 of tSGD, but the token contract only delivers to KYC-verified investors.",
      cue: aListing ? `#btn-buy-${aListing.id}` : null,
      done: flags.unverifiedBlocked || (aListing && !aListing.active) || (m && m.status >= 5),
    },
    {
      id: "buyB", actor: "investorB", view: ["investor", "ddex"],
      title: "Lim & Pang buys Lion Gate's tokens",
      how: "Switch to Lim & Pang and click Buy on the same listing.",
      why: "Cash and tokens swap in one transaction. Lim & Pang now holds the whole invoice.",
      cue: aListing ? `#btn-buy-${aListing.id}` : null,
      done: (aListing && !aListing.active && !!aListing.buyer) || (m && m.status >= 5),
    },
    {
      id: "ffDue", actor: null, view: null,
      title: `Move to the due date${ffNote}`,
      how: "Open Demo tools and choose To INV-2026-0412 due date.",
      why: "60 more days pass.",
      cue: "#btn-demo-tools",
      done: m && (!canTimeTravel || snap.time >= m.dueDate - 60 || m.status >= 5),
    },
    {
      id: "repay", actor: "buyer", view: ["buyer"],
      title: "Straits Marine pays S$100,000",
      how: "Under Payables, click Pay S$100,000 to the SPV.",
      why: "The contract keeps the 0.10% fee, pays whoever holds the tokens now (Lim & Pang), then retires the tokens.",
      cue: id ? `#btn-repay-${id}` : null,
      done: m && m.status >= 5,
    },
    {
      id: "results", actor: null, view: ["results"],
      title: "Review the results",
      how: "Open Results in the header.",
      why: "What each party received, and the investors' returns against the 6-month T-bill.",
      cue: "#nav-results",
      done: false,
      final: true,
    },
  ];
}
