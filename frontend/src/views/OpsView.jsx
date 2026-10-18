import React, { useState } from "react";
import { ethers } from "ethers";
import { ACTORS, BUYER_CREDIT, CATEGORY, GRADES, MIN_FINANCING_PCT, creditScore, gradeFromScore, DAY } from "../../../shared/constants.mjs";
import { hashEInvoice } from "../../../shared/einvoice.mjs";
import { sgd, date, pct } from "../format.js";
import { GradeChip, StatusPill, Hash, Button, Empty, Notice } from "../ui.jsx";
import { actorName, actorShort } from "../model.js";

const TABS = [
  ["queue", "Verification queue"],
  ["pricing", "Grades and pricing"],
  ["kyc", "Identity registry"],
  ["book", "Platform book"],
];

export function quoteLocal(face, grade, tenorSecs, rates) {
  const tenorDays = Math.ceil(tenorSecs / DAY);
  const discount = Math.floor((face * rates[grade] * tenorDays) / (90 * 10000));
  const floor = Math.floor((face * MIN_FINANCING_PCT) / 100);
  let price = face - discount;
  let floorApplied = false;
  if (price < floor) { price = floor; floorApplied = true; }
  return { price, floorApplied, tenorDays };
}

export default function OpsView({ snap, inbox, actions, run, busy, tab, setTab, client, hideTabs }) {
  const queue = snap.invoices.filter((i) => i.status === 1);
  return (
    <div className="view">
      <header className="view-head">
        <div>
          <h1>ReceivaSG Operations</h1>
          <p className="sub">Peppol Access Point, credit engine and ERC-3643 agent for the SPV</p>
        </div>
        <div className="stat-row">
          <div className="stat"><span>Awaiting verification</span><strong>{queue.length}</strong></div>
          <div className="stat"><span>Servicing fees earned</span><strong>{sgd(snap.balances.treasury)}</strong></div>
        </div>
      </header>
      {hideTabs ? null : <nav className="tabs" aria-label="Operations sections">
        {TABS.map(([k, l]) => (
          <button key={k} type="button" className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
            {l}{k === "queue" && queue.length ? <span className="count">{queue.length}</span> : null}
          </button>
        ))}
      </nav>}
      {tab === "queue" ? <Queue queue={queue} snap={snap} inbox={inbox} actions={actions} run={run} busy={busy} /> : null}
      {tab === "pricing" ? <Pricing snap={snap} /> : null}
      {tab === "kyc" ? <Kyc snap={snap} actions={actions} run={run} busy={busy} client={client} /> : null}
      {tab === "book" ? <Book snap={snap} actions={actions} run={run} busy={busy} /> : null}
    </div>
  );
}

function Queue({ queue, snap, inbox, actions, run, busy }) {
  if (!queue.length) {
    return (
      <section className="panel">
        <Empty>No invoices waiting. When an SME requests financing, it appears here for InvoiceNow verification and grading.</Empty>
      </section>
    );
  }
  return (
    <div className="stack">
      {queue.map((inv) => <Verify key={inv.id} inv={inv} snap={snap} inbox={inbox} actions={actions} run={run} busy={busy} />)}
    </div>
  );
}

function Verify({ inv, snap, inbox, actions, run, busy }) {
  const entry = inbox.find((e) => e.hash === inv.docHash);
  const credit = BUYER_CREDIT[inv.buyer];
  const cs = credit ? creditScore(credit) : null;
  const model = cs ? gradeFromScore(cs.score) : 3;
  const [grade, setGrade] = useState(model);
  const q = quoteLocal(inv.face, grade, inv.dueDate - snap.time, snap.grades.rates);
  const tenorDays = Math.ceil((inv.dueDate - snap.time) / DAY);
  const checks = [
    ["Supplier is a registered SME", snap.identities[inv.supplier]?.category === 1, `${actorName(inv.supplier)}, KYC on file`],
    ["Buyer is a registered corporate buyer", snap.identities[inv.buyer]?.category === 2, actorName(inv.buyer)],
    ["Buyer approved the invoice on InvoiceNow", entry ? entry.doc.buyerResponse.code === "AP" : false, entry ? `Peppol Invoice Response: ${entry.doc.buyerResponse.code}` : "No e-invoice on file"],
    ["Document hash matches the e-invoice received", entry ? hashEInvoice(ethers, entry.doc) === inv.docHash : false, <Hash value={inv.docHash} a={10} b={6} />],
    ["Not financed anywhere on ReceivaSG before", true, "Duplicate hashes are rejected by the SPV contract"],
    ["Tenor between 7 and 365 days", tenorDays >= 7 && tenorDays <= 365, `${tenorDays} days to ${date(inv.dueDate)}`],
  ];
  const allOk = checks.every((c) => c[1]);
  return (
    <section className="panel verify">
      <div className="verify-top">
        <div>
          <h2>{inv.ref} <span className="muted-s">#{inv.id}</span></h2>
          <p className="sub">{actorName(inv.supplier)} → {actorName(inv.buyer)} · {sgd(inv.face)} · due {date(inv.dueDate)}</p>
        </div>
        <StatusPill status={inv.status} />
      </div>
      <div className="verify-grid">
        <div>
          <h3>InvoiceNow checks</h3>
          <ul className="checks">
            {checks.map(([label, ok, detail], i) => (
              <li key={i} className={ok ? "ok" : "fail"}>
                <span className="mark" aria-hidden="true">{ok ? "✓" : "✕"}</span>
                <div><strong>{label}</strong><span>{detail}</span></div>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3>Credit grade for {actorShort(inv.buyer)}</h3>
          {cs ? (
            <>
              <table className="score">
                <tbody>
                  <tr><td>On-time payment rate</td><td className="r">{credit.onTimePct}%</td><td className="r w">40%</td><td className="r">{cs.parts.onTime}</td></tr>
                  <tr><td>Overdue share of invoices</td><td className="r">{credit.overduePct}%</td><td className="r w">20%</td><td className="r">{cs.parts.overdue}</td></tr>
                  <tr><td>Years trading</td><td className="r">{credit.yearsTrading}</td><td className="r w">15%</td><td className="r">{cs.parts.tenure}</td></tr>
                  <tr><td>Revenue (S$m)</td><td className="r">{credit.revenueSgdM.toLocaleString("en-SG")}</td><td className="r w">15%</td><td className="r">{cs.parts.scale}</td></tr>
                  <tr><td>InvoiceNow payment history</td><td className="r">{credit.invoiceNowHistory} invoices</td><td className="r w">10%</td><td className="r">{cs.parts.history}</td></tr>
                </tbody>
                <tfoot><tr><td colSpan={3}>Score (0–100)</td><td className="r"><strong>{cs.score}</strong></td></tr></tfoot>
              </table>
              <p className="muted-s">Model grade: <GradeChip grade={model} /> Bands: AAA ≥ 93, AA ≥ 88, A ≥ 82, BBB ≥ 74, BB ≥ 66, B ≥ 58, else CCC.</p>
            </>
          ) : <p className="muted-s">No credit data for this buyer.</p>}
          <div className="grade-pick" role="radiogroup" aria-label="Grade to assign">
            {GRADES.map((g, i) => (
              <button key={g} type="button" role="radio" aria-checked={grade === i} className={`grade g${i}${grade === i ? " picked" : ""}`} onClick={() => setGrade(i)}>{g}</button>
            ))}
          </div>
          <div className="quote">
            <div><span>Price set by the contract</span><strong>{sgd(q.price)}</strong></div>
            <div><span>Share of face value</span><strong>{pct((q.price / inv.face) * 100, 2)}</strong></div>
            <div><span>Minimum ticket</span><strong>{sgd(snap.grades.tickets[grade])}</strong></div>
          </div>
          {q.floorApplied ? <Notice tone="warn" title={`${MIN_FINANCING_PCT}% minimum financing percentage applies`}>The grade-based discount would price this below {MIN_FINANCING_PCT}% of face value, so the SME is paid the floor instead.</Notice> : null}
        </div>
      </div>
      <div className="row-actions">
        <Button id="btn-verify" disabled={!allOk} busy={busy[`verify-${inv.id}`]} onClick={() => run(`verify-${inv.id}`, () => actions.verifyAndGrade(inv.id, inv.ref, grade, GRADES[grade]), `${inv.ref} graded ${GRADES[grade]}. Offer of ${sgd(q.price)} sent to ${actorShort(inv.supplier)}.`)}>
          Verify and grade {GRADES[grade]}
        </Button>
        <Button kind="ghost" busy={busy[`reject-${inv.id}`]} onClick={() => run(`reject-${inv.id}`, () => actions.rejectInvoice(inv.id, inv.ref, "Failed InvoiceNow verification"), `${inv.ref} rejected.`)}>
          Reject
        </Button>
      </div>
    </section>
  );
}

function Pricing({ snap }) {
  const tenors = [30, 90, 180, 270];
  const face = 10_000_000;
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Grades and pricing</h2>
        <p>The SPV contract prices each invoice from its grade and days to maturity. These parameters are read live from the contract. Higher grades are safer, need a larger minimum investment and pay less.</p>
      </div>
      <div className="table-wrap">
        <table className="grid">
          <thead>
            <tr>
              <th>Grade</th><th className="r">Discount per 90 days</th><th className="r">≈ per year</th><th className="r">Minimum ticket</th>
              {tenors.map((t) => <th key={t} className="r">{t} days</th>)}
            </tr>
          </thead>
          <tbody>
            {GRADES.map((g, i) => (
              <tr key={g}>
                <td><GradeChip grade={i} /></td>
                <td className="r">{pct(snap.grades.rates[i] / 100, 2)}</td>
                <td className="r">{pct((snap.grades.rates[i] / 100) * (365 / 90), 1)}</td>
                <td className="r">{sgd(snap.grades.tickets[i])}</td>
                {tenors.map((t) => {
                  const q = quoteLocal(face, i, t * DAY, snap.grades.rates);
                  return <td key={t} className={`r${q.floorApplied ? " floor" : ""}`}>{pct((q.price / face) * 100, 1)}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted-s">Cells show what the SME receives as a share of face value. Shaded cells hit the {MIN_FINANCING_PCT}% minimum financing percentage. A 0.10% servicing fee is taken from the buyer's payment at maturity.</p>
    </section>
  );
}

function Kyc({ snap, actions, run, busy, client }) {
  const rows = Object.keys(ACTORS).filter((k) => !["bank", "treasury", "admin"].includes(k));
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Identity registry</h2>
        <p>Every note transfer checks this registry first. Only a hash of each KYC/AML file is stored on-chain; the personal data stays off-chain with ReceivaSG.</p>
      </div>
      <div className="table-wrap">
        <table className="grid">
          <thead><tr><th>Party</th><th>Wallet</th><th>Category</th><th>KYC valid until</th><th>Record hash</th><th></th></tr></thead>
          <tbody>
            {rows.map((k) => {
              const id = snap.identities[k];
              const cat = id?.verified ? CATEGORY[id.category] : "None";
              return (
                <tr key={k}>
                  <td>{ACTORS[k].name}</td>
                  <td><Hash value={client.actors[k]} /></td>
                  <td>{id?.verified ? <span className="pill neutral">{label(cat)}</span> : <span className="pill bad">Not verified</span>}</td>
                  <td>{id?.verified ? date(id.expiry) : "—"}</td>
                  <td>{id?.verified ? <Hash value={id.hash} /> : "—"}</td>
                  <td className="r">
                    {k === "unverified" && !id?.verified ? (
                      <Button small busy={busy["kyc-unverified"]} onClick={() => run("kyc-unverified", () => actions.registerInvestor("unverified", 3), "KYC complete. The wallet can now hold and trade notes.")}>Complete KYC</Button>
                    ) : k === "unverified" && id?.verified ? (
                      <Button small kind="ghost" busy={busy["kyc-revoke"]} onClick={() => run("kyc-revoke", () => actions.removeIdentity("unverified"), "KYC revoked.")}>Revoke</Button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const label = (cat) => ({ SME: "SME supplier", CorporateBuyer: "Corporate buyer", AccreditedInvestor: "Accredited investor", InstitutionalInvestor: "Institutional investor" }[cat] || cat);

function Book({ snap, actions, run, busy }) {
  const [recovery, setRecovery] = useState({});
  const rows = [...snap.invoices].sort((a, b) => b.id - a.id);
  const funded = rows.filter((i) => i.status === 4);
  const exposure = funded.reduce((s, i) => s + i.face, 0);
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Platform book</h2>
        <p>{funded.length} funded invoice{funded.length === 1 ? "" : "s"} outstanding, {sgd(exposure)} face value owed by buyers to the SPV.</p>
      </div>
      <div className="table-wrap">
        <table className="grid">
          <thead><tr><th>Invoice</th><th>SME → buyer</th><th>Grade</th><th className="r">Face</th><th className="r">Paid to SME</th><th>Due</th><th>Status</th><th>Controls</th></tr></thead>
          <tbody>
            {rows.map((inv) => {
              const graceOver = inv.status === 4 && snap.time > inv.dueDate + 30 * DAY;
              return (
                <tr key={inv.id}>
                  <td className="nw"><strong>{inv.ref}</strong><div className="muted-s">#{inv.id}</div></td>
                  <td>{actorShort(inv.supplier)}<div className="muted-s">→ {actorShort(inv.buyer)}</div></td>
                  <td>{inv.status >= 2 && inv.status !== 7 ? <GradeChip grade={inv.grade} /> : "—"}</td>
                  <td className="r">{sgd(inv.face)}</td>
                  <td className="r">{inv.status >= 4 && inv.status !== 7 ? sgd(inv.price) : "—"}</td>
                  <td className="nw">{date(inv.dueDate)}{inv.status === 4 && snap.time > inv.dueDate ? <div><span className="pill warn">past due</span></div> : null}</td>
                  <td><StatusPill status={inv.status} /></td>
                  <td>
                    {inv.status === 4 ? (
                      <div className="mini-actions">
                        <Button small kind="ghost" busy={busy[`pause-${inv.id}`]} onClick={() => run(`pause-${inv.id}`, () => actions.pauseNote(inv, !inv.paused), inv.paused ? "Transfers resumed." : "Transfers paused.")}>
                          {inv.paused ? "Resume" : "Pause"}
                        </Button>
                        {graceOver ? (
                          <>
                            <input className="input sm" id={`rec-${inv.id}`} aria-label="Amount recovered" placeholder="Recovered S$" value={recovery[inv.id] || ""} onChange={(e) => setRecovery({ ...recovery, [inv.id]: e.target.value })} />
                            <Button small kind="danger" busy={busy[`def-${inv.id}`]} onClick={() => run(`def-${inv.id}`, () => actions.settleDefault(inv, Math.round(Number(recovery[inv.id] || 0) * 100)), "Default recorded. Recoveries paid pro rata.")}>Record default</Button>
                          </>
                        ) : null}
                      </div>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
