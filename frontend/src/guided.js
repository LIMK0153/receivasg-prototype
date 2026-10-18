// Presenter checklist: the press-release example as a sequence of things YOU click.
// Nothing here performs an action. Each step says which account to use and what to
// click, highlights that control on the page, and ticks itself off when the chain
// state shows it happened.
import { DAY } from "../../shared/constants.mjs";

export const MAIN_REF = "INV-2026-0412";

export function mainInvoice(snap) {
  return snap.invoices.filter((i) => i.ref === MAIN_REF && i.status !== 7).sort((a, b) => b.id - a.id)[0];
}

export function buildSteps({ snap, flags, canTimeTravel = true }) {
  const m = mainInvoice(snap);
  const hasCommit = (k) => m && (m.status >= 4 || m.commitments.some((c) => c.investor === k));
  const cListing = m && snap.listings.filter((l) => l.invoiceId === m.id && l.seller === "investorC").sort((a, b) => b.id - a.id)[0];
  const id = m?.id;
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
      id: "accept", actor: "sme", view: ["sme"],
      title: "Meridian accepts and sells the invoice to the SPV",
      how: "Under Financing, review the offer and click Accept and sell for S$98,000.",
      why: "True sale: Invoice NFT minted to the SPV, notice of assignment to the buyer, note series created.",
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
      title: "Harbourfront Capital invests S$30,000",
      how: "Type 30000 in the INV-2026-0412 card and click Commit.",
      why: "S$80,000 of S$98,000 is then committed.",
      cue: id ? `#amt-${id}` : null,
      done: hasCommit("investorB"),
    },
    {
      id: "commitC", actor: "investorC", view: ["investor", "market"],
      title: "Jasmine Koh invests the last S$18,000",
      how: "Click Fill remaining on the INV-2026-0412 card, then Commit.",
      why: "This fills the invoice: everyone's cash moves, notes are minted and Meridian is paid, all in one transaction.",
      cue: id ? `#fill-${id}` : null,
      done: m && m.status >= 4,
    },
    {
      id: "ff30", actor: null, view: null,
      title: `30 days pass${ffNote}`,
      how: "Open Demo tools in the header and choose +30 days.",
      why: "The notes accrue value as the due date approaches.",
      cue: "#btn-demo-tools",
      done: m && m.status >= 4 && (!canTimeTravel || snap.time >= m.fundedAt + 29 * DAY || !!cListing || m.status >= 5),
    },
    {
      id: "list", actor: "investorC", view: ["investor", "ddex"],
      title: "Jasmine lists her notes on DDEx",
      how: "Open DDEx secondary market. Under List your notes, keep RSN holding and price as suggested and click List.",
      why: "She wants her cash before maturity.",
      cue: "#btn-list",
      done: !!cListing || (m && m.status >= 5),
    },
    {
      id: "blocked", actor: "unverified", view: ["investor", "ddex"],
      title: "A wallet without KYC tries to buy them",
      how: "Switch to the Unverified wallet and click Buy on Jasmine's listing. It should be refused.",
      why: "It has S$50,000 of tSGD, but the note contract only delivers to KYC-verified investors.",
      cue: cListing ? `#btn-buy-${cListing.id}` : null,
      done: flags.unverifiedBlocked || (cListing && !cListing.active) || (m && m.status >= 5),
    },
    {
      id: "buyB", actor: "investorB", view: ["investor", "ddex"],
      title: "Harbourfront buys Jasmine's notes",
      how: "Switch to Harbourfront and click Buy on the same listing.",
      why: "Cash and notes swap in one transaction.",
      cue: cListing ? `#btn-buy-${cListing.id}` : null,
      done: (cListing && !cListing.active && !!cListing.buyer) || (m && m.status >= 5),
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
      why: "The contract keeps the 0.10% fee and pays every current note holder pro rata, then retires the notes.",
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
