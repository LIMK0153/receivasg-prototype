import React, { useState } from "react";
import { ACTORS, GRADES, TBILL, DAY } from "../../../shared/constants.mjs";
import { sgd, date, pct, parseSgd } from "../format.js";
import { GradeChip, StatusPill, Progress, Button, Empty, Notice, Hash } from "../ui.jsx";
import { actorName, actorShort, annualised, payoutFor, fairValue, costBasis, tokens } from "../model.js";

const TABS = [
  ["market", "Marketplace"],
  ["portfolio", "Portfolio"],
  ["ddex", "DDEx secondary market"],
];

export default function InvestorView({ persona, snap, actions, run, busy, tab, setTab, flags, setFlag, hideTabs }) {
  const verified = snap.identities[persona]?.verified;
  const holdings = snap.invoices.filter((i) => i.holders.some((h) => h.who === persona));
  const faceHeld = holdings.reduce((s, i) => s + i.holders.find((h) => h.who === persona).bal, 0);
  const atMaturity = holdings.reduce((s, i) => s + payoutFor(i.holders.find((h) => h.who === persona).bal, snap.feeBps), 0);
  return (
    <div className="view">
      <header className="view-head">
        <div>
          <h1>{ACTORS[persona].name}</h1>
          <p className="sub">
            {persona === "unverified"
              ? "Holds tokenised SGD but has no KYC record in the identity registry"
              : `${ACTORS[persona].type} · KYC verified`}
          </p>
        </div>
        <div className="stat-row">
          <div className="stat"><span>Wallet (tSGD)</span><strong>{sgd(snap.balances[persona])}</strong></div>
          <div className="stat"><span>Committed, not yet settled</span><strong>{sgd(snap.outstanding[persona])}</strong></div>
          <div className="stat"><span>Tokens held (face value)</span><strong>{sgd(faceHeld)}</strong></div>
          <div className="stat"><span>Pays at maturity</span><strong>{sgd(atMaturity)}</strong></div>
        </div>
      </header>
      {!verified ? (
        <Notice tone="warn" title="This wallet is not KYC-verified">
          It can browse, but the contracts will refuse any investment or token transfer to it. ReceivaSG Operations can complete KYC in the identity registry.
        </Notice>
      ) : null}
      {hideTabs ? null : (
        <nav className="tabs" aria-label="Investor sections">
          {TABS.map(([k, l]) => (
            <button key={k} type="button" className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>
          ))}
        </nav>
      )}
      {tab === "market" ? <Market persona={persona} snap={snap} actions={actions} run={run} busy={busy} /> : null}
      {tab === "portfolio" ? <Portfolio persona={persona} snap={snap} actions={actions} run={run} busy={busy} /> : null}
      {tab === "ddex" ? <Ddex persona={persona} snap={snap} actions={actions} run={run} busy={busy} setFlag={setFlag} /> : null}
    </div>
  );
}

function Market({ persona, snap, actions, run, busy }) {
  const open = snap.invoices.filter((i) => i.status === 3).sort((a, b) => a.grade - b.grade);
  const [grade, setGrade] = useState(-1);
  const shown = open.filter((i) => grade < 0 || i.grade === grade);
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Invoices open for funding</h2>
        <p>Each is a buyer-approved invoice the SPV has bought from an SME. You commit cash for a fraction of it; when it is fully funded, all investors receive tokens and the SME is paid in the same transaction. Each token pays S$1 when the buyer pays.</p>
      </div>
      <div className="filter" role="group" aria-label="Filter by grade">
        <button type="button" className={grade < 0 ? "on" : ""} onClick={() => setGrade(-1)}>All grades</button>
        {GRADES.map((g, i) => open.some((x) => x.grade === i) ? (
          <button key={g} type="button" className={grade === i ? "on" : ""} onClick={() => setGrade(i)}>{g}</button>
        ) : null)}
      </div>
      {shown.length === 0 ? <Empty>No invoices are open for funding right now.</Empty> : (
        <div className="market">
          {shown.map((inv) => <Offer key={inv.id} inv={inv} persona={persona} snap={snap} actions={actions} run={run} busy={busy} />)}
        </div>
      )}
    </section>
  );
}

function Offer({ inv, persona, snap, actions, run, busy }) {
  const remaining = inv.price - inv.committed;
  const min = snap.grades.tickets[inv.grade];
  const mine = inv.commitments.find((c) => c.investor === persona);
  const effMin = Math.max(0, min - (mine?.cash || 0));
  const [amt, setAmt] = useState("");
  const cents = parseSgd(amt);
  const tenor = Math.max(1, Math.ceil((inv.dueDate - snap.time) / DAY));
  const notes = cents >= remaining ? null : Math.floor((cents * inv.face) / inv.price);
  const notesShown = cents === remaining ? inv.face - inv.notesAllocated : notes;
  const payout = notesShown ? payoutFor(notesShown, snap.feeBps) : 0;
  const yld = annualised(inv.price, payoutFor(inv.face, snap.feeBps), tenor);
  const myYield = cents && notesShown ? annualised(cents, payout, tenor) : yld;
  const fills = cents === remaining;
  const problem =
    !cents ? null :
    cents > remaining ? `Only ${sgd(remaining)} is left to fund.` :
    cents < effMin && !fills ? `Minimum ticket for grade ${GRADES[inv.grade]} is ${sgd(min)}.` :
    cents + (snap.outstanding[persona] || 0) > snap.balances[persona] ? "Not enough tSGD to cover this and your other open commitments." : null;
  const key = `commit-${inv.id}`;
  return (
    <article className="offer-card">
      <div className="oc-head">
        <GradeChip grade={inv.grade} size="lg" />
        <div>
          <h3>{inv.ref}</h3>
          <p className="sub">Owed by <strong>{actorName(inv.buyer)}</strong> · sold by {actorShort(inv.supplier)}</p>
        </div>
      </div>
      <dl className="oc-facts">
        <div><dt>Face value</dt><dd>{sgd(inv.face)}</dd></div>
        <div><dt>Price</dt><dd>{sgd(inv.price)} <em>{pct((inv.price / inv.face) * 100, 1)}</em></dd></div>
        <div><dt>Matures</dt><dd>{date(inv.dueDate)} <em>{tenor} days</em></dd></div>
        <div><dt>Expected return</dt><dd className="yield">{pct(yld, 2)} p.a. <em>vs {pct(TBILL.rate)} T-bill</em></dd></div>
      </dl>
      <div className="oc-fund">
        <Progress value={inv.committed} max={inv.price} />
        <p className="muted-s">{sgd(inv.committed)} of {sgd(inv.price)} committed · {inv.commitments.length} investor{inv.commitments.length === 1 ? "" : "s"} · minimum ticket {sgd(min)}{inv.floorApplied ? " · 85% floor applied" : ""}</p>
      </div>
      {mine ? <p className="mine">You have committed {sgd(mine.cash)}. It stays in your wallet until the invoice is fully funded.</p> : null}
      <div className="oc-invest">
        <label htmlFor={`amt-${inv.id}`}>Amount to commit (S$)</label>
        <div className="amt-row">
          <input id={`amt-${inv.id}`} className="input" inputMode="decimal" placeholder={effMin > 0 ? `Minimum ${(effMin / 100).toLocaleString("en-SG")}` : "Amount"} value={amt} onChange={(e) => setAmt(e.target.value)} />
          {effMin > 0 && effMin < remaining ? <button type="button" className="chip" onClick={() => setAmt((effMin / 100).toFixed(0))}>Minimum</button> : null}
          <button id={`fill-${inv.id}`} type="button" className="chip" onClick={() => setAmt((remaining / 100).toFixed(2))}>Fill remaining {sgd(remaining)}</button>
        </div>
        {cents > 0 && !problem ? (
          <p className="preview">
            You get <strong>{tokens(notesShown)}</strong>, each paying S$1 at maturity. You receive <strong>{sgd(payout)}</strong> after the 0.10% servicing fee: <strong>{sgd(payout - cents, { sign: true })}</strong>, {pct(myYield, 2)} p.a.
            {fills ? " This fills the invoice, so settlement happens in this transaction." : ""}
          </p>
        ) : null}
        {problem ? <p className="field-err">{problem}</p> : null}
        <Button
          id={`btn-commit-${inv.id}`}
          busy={busy[key]}
          disabled={!cents || cents > remaining}
          onClick={() => run(key, async () => { const r = await actions.invest(persona, inv.id, cents, inv.ref); setAmt(""); return r; },
            fills ? `${inv.ref} fully funded. Settled atomically: ${actorShort(inv.supplier)} received ${sgd(inv.price)}.` : `Committed ${sgd(cents)} to ${inv.ref}.`)}
        >
          {cents ? `Commit ${sgd(cents)}` : "Commit"}
        </Button>
      </div>
    </article>
  );
}

function Portfolio({ persona, snap, actions, run, busy }) {
  const pending = snap.invoices.filter((i) => i.status === 3 && i.commitments.some((c) => c.investor === persona));
  const held = snap.invoices.filter((i) => i.holders.some((h) => h.who === persona));
  const [transfer, setTransfer] = useState(null);
  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h2>Tokens held</h2>
          <p>Each token is a claim on S$1 of the buyer's payment on the due date. "You paid" is what these tokens cost you; "Pays at maturity" is what you receive if you hold them until the buyer pays, after the 0.10% servicing fee.</p>
        </div>
        {held.length === 0 ? <Empty>You don't hold any tokens yet. Fund an invoice in the marketplace or buy on DDEx.</Empty> : (
          <div className="table-wrap">
            <table className="grid">
              <thead><tr><th>Token</th><th>Owed by</th><th className="r">Tokens held</th><th className="r">You paid</th><th className="r">Pays at maturity</th><th>Matures</th><th></th></tr></thead>
              <tbody>
                {held.map((inv) => {
                  const bal = inv.holders.find((h) => h.who === persona).bal;
                  const paid = costBasis(snap, inv, persona);
                  return (
                    <tr key={inv.id}>
                      <td className="nw"><GradeChip grade={inv.grade} /> <strong>{inv.noteSymbol}</strong><div className="muted-s">{inv.ref}</div></td>
                      <td>{actorShort(inv.buyer)}</td>
                      <td className="r nw">{tokens(bal)}</td>
                      <td className="r">{paid === null ? "—" : sgd(paid)}</td>
                      <td className="r">{sgd(payoutFor(bal, snap.feeBps))}</td>
                      <td className="nw">{date(inv.dueDate)}<div className="muted-s">{Math.max(0, Math.ceil((inv.dueDate - snap.time) / DAY))} days left</div></td>
                      <td className="r"><Button small kind="ghost" onClick={() => setTransfer(transfer === inv.id ? null : inv.id)}>Transfer</Button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {transfer ? <TransferBox inv={held.find((i) => i.id === transfer)} persona={persona} actions={actions} run={run} busy={busy} onDone={() => setTransfer(null)} /> : null}
      </section>
      <section className="panel">
        <div className="panel-head">
          <h2>Open commitments</h2>
          <p>Cash you have pledged to invoices that are still being funded. Nothing has left your wallet yet.</p>
        </div>
        {pending.length === 0 ? <Empty>No open commitments.</Empty> : (
          <div className="table-wrap">
            <table className="grid">
              <thead><tr><th>Invoice</th><th>Grade</th><th className="r">Committed</th><th className="r">Tokens reserved</th><th>Funding</th><th></th></tr></thead>
              <tbody>
                {pending.map((inv) => {
                  const c = inv.commitments.find((x) => x.investor === persona);
                  return (
                    <tr key={inv.id}>
                      <td>{inv.ref}</td>
                      <td><GradeChip grade={inv.grade} /></td>
                      <td className="r">{sgd(c.cash)}</td>
                      <td className="r nw">{tokens(c.notes)}</td>
                      <td style={{ minWidth: 140 }}><Progress value={inv.committed} max={inv.price} /></td>
                      <td className="r"><Button small kind="ghost" busy={busy[`wd-${inv.id}`]} onClick={() => run(`wd-${inv.id}`, () => actions.withdrawCommitment(persona, inv.id, inv.ref), "Commitment withdrawn.")}>Withdraw</Button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function TransferBox({ inv, persona, actions, run, busy, onDone }) {
  const options = Object.keys(ACTORS).filter((k) => !["admin", "bank", "treasury", persona].includes(k));
  const [to, setTo] = useState("unverified");
  const [amt, setAmt] = useState("1000");
  return (
    <div className="transfer">
      <p>Send {inv.noteSymbol} tokens directly to another wallet. The token contract checks the identity registry before the transfer executes. Try sending to the unverified wallet or to an SME.</p>
      <div className="amt-row">
        <label className="sr" htmlFor="xfer-to">Recipient</label>
        <select id="xfer-to" className="input" value={to} onChange={(e) => setTo(e.target.value)}>
          {options.map((k) => <option key={k} value={k}>{ACTORS[k].name}</option>)}
        </select>
        <label className="sr" htmlFor="xfer-amt">Number of tokens to send</label>
        <input id="xfer-amt" className="input" value={amt} onChange={(e) => setAmt(e.target.value)} />
        <Button small busy={busy.xfer} onClick={() => run("xfer", async () => { const r = await actions.transferNotes(persona, inv, to, parseSgd(amt)); onDone(); return r; }, "Transfer complete: the recipient passed the compliance check.")}>Send</Button>
      </div>
    </div>
  );
}

function Ddex({ persona, snap, actions, run, busy, setFlag }) {
  const listings = [...snap.listings].sort((a, b) => Number(b.active) - Number(a.active) || b.id - a.id);
  const held = snap.invoices.filter((i) => i.status === 4 && i.holders.some((h) => h.who === persona)).sort((a, b) => b.id - a.id);
  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h2>DDEx secondary market</h2>
          <p>ReceivaSG tokens list on the DBS Digital Exchange so investors can exit before maturity. This prototype simulates the venue with a contract: cash and tokens swap in one transaction, and the token contract still checks the buyer's eligibility.</p>
        </div>
        {listings.length === 0 ? <Empty>No tokens listed yet.</Empty> : (
          <div className="table-wrap">
            <table className="grid">
              <thead><tr><th>Token</th><th>Seller</th><th className="r">Tokens for sale</th><th className="r">Asking price</th><th className="r">Buyer's return to maturity</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {listings.map((l) => {
                  const inv = snap.invoices.find((i) => i.id === l.invoiceId);
                  const daysLeft = Math.max(1, Math.ceil((inv.dueDate - snap.time) / DAY));
                  const y = annualised(l.price, payoutFor(l.amount, snap.feeBps), daysLeft);
                  const tradable = l.active && inv.status === 4;
                  return (
                    <tr key={l.id} className={l.active ? "" : "dim"}>
                      <td className="nw"><GradeChip grade={inv.grade} /> <strong>{inv.noteSymbol}</strong><div className="muted-s">{inv.ref} · listing #{l.id}</div></td>
                      <td>{actorShort(l.seller)}</td>
                      <td className="r nw">{tokens(l.amount)}</td>
                      <td className="r">{sgd(l.price)}</td>
                      <td className="r">{l.active ? `${pct(y, 2)} p.a.` : "—"}</td>
                      <td>{l.active ? (inv.status === 4 ? <span className="pill accent">Open</span> : <span className="pill muted">Closed</span>) : l.buyer ? <span className="pill done">Sold to {actorShort(l.buyer)}</span> : <span className="pill muted">Cancelled</span>}</td>
                      <td className="r">
                        {tradable && l.seller === persona ? (
                          <Button small kind="ghost" busy={busy[`cancel-${l.id}`]} onClick={() => run(`cancel-${l.id}`, () => actions.cancelListing(persona, l), "Listing cancelled.")}>Cancel</Button>
                        ) : tradable ? (
                          <Button id={`btn-buy-${l.id}`} small busy={busy[`buy-${l.id}`]} onClick={() => run(`buy-${l.id}`, async () => {
                            try { return await actions.buyListing(persona, l, inv.noteSymbol); }
                            catch (e) { if (persona === "unverified") setFlag("unverifiedBlocked", true); throw e; }
                          }, `Bought ${tokens(l.amount)} of ${inv.noteSymbol} for ${sgd(l.price)}. Cash and tokens swapped in one transaction.`)}>Buy</Button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="panel">
        <div className="panel-head">
          <h2>Sell your tokens</h2>
          <p>Choose a holding and how many tokens to sell, then set your asking price. Another verified investor on DDEx decides whether to buy at that price.</p>
        </div>
        {held.length === 0 ? <Empty>You have no funded tokens to sell.</Empty> : <ListForm held={held} persona={persona} snap={snap} actions={actions} run={run} busy={busy} />}
      </section>
    </>
  );
}

function ListForm({ held, persona, snap, actions, run, busy }) {
  const [id, setId] = useState(held[0].id);
  const inv = held.find((i) => i.id === Number(id)) || held[0];
  const bal = inv.holders.find((h) => h.who === persona).bal;
  const [amt, setAmt] = useState("");
  const [ask, setAsk] = useState("");
  const units = amt ? Math.min(parseSgd(amt), bal) : bal;
  const paid = costBasis(snap, inv, persona);
  const suggested = Math.round(fairValue(inv, units, snap.time) / 1000) * 1000; // nearest S$10
  const askC = ask ? parseSgd(ask) : suggested;
  const payout = payoutFor(units, snap.feeBps);
  // straight-line price per token, from the issue price to S$1.00 on the due date
  const issue = inv.price / inv.face;
  const totalDays = Math.max(1, Math.round((inv.dueDate - inv.fundedAt) / DAY));
  const elapsedDays = Math.min(totalDays, Math.max(0, Math.round((snap.time - inv.fundedAt) / DAY)));
  const perToken = issue + (1 - issue) * (elapsedDays / totalDays);
  return (
    <div className="list-form">
      <div className="field">
        <label htmlFor="list-note">Holding</label>
        <select id="list-note" className="input" value={inv.id} onChange={(e) => { setId(e.target.value); setAmt(""); setAsk(""); }}>
          {held.map((i) => <option key={i.id} value={i.id}>{i.noteSymbol} ({i.ref}): {tokens(i.holders.find((h) => h.who === persona).bal)}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor="list-amt">Tokens to sell</label>
        <input id="list-amt" className="input" placeholder={`All ${(bal / 100).toFixed(2)}`} value={amt} onChange={(e) => setAmt(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="list-ask">Asking price (S$)</label>
        <input id="list-ask" className="input" placeholder={`Suggested ${(suggested / 100).toFixed(2)}`} value={ask} onChange={(e) => setAsk(e.target.value)} />
      </div>
      <dl className="holding">
        <div><dt>Tokens you hold</dt><dd>{tokens(bal)}</dd><em>1 token = S$1 paid by {actorName(inv.buyer)} on {date(inv.dueDate)}</em></div>
        <div><dt>You paid</dt><dd>{paid === null ? "—" : sgd(paid)}</dd><em>What these tokens cost you</em></div>
        <div><dt>If you hold to maturity</dt><dd>{sgd(payoutFor(bal, snap.feeBps))}</dd><em>{sgd(bal)} less the 0.10% servicing fee</em></div>
      </dl>
      <div className="howprice">
        <strong>How the suggested price is worked out</strong>
        <p>
          These tokens were issued at S${issue.toFixed(4)} each and pay S$1.00 each on the due date. The suggested price moves evenly between the two over the {totalDays}-day term.
          {" "}{elapsedDays} of {totalDays} days have passed, so each token is priced at S${perToken.toFixed(4)}: {tokens(units)} × S${perToken.toFixed(4)} = <strong>{sgd(suggested)}</strong> (to the nearest S$10).
        </p>
        <p>At this price you keep the return earned for the days you held, and the buyer earns the rest. You can ask more or less; a higher price is less likely to find a buyer.</p>
        {askC >= payout ? <p className="field-err">At {sgd(askC)} a buyer would pay more than the {sgd(payout)} these tokens return at maturity, so they are unlikely to sell.</p> : null}
      </div>
      <Button id="btn-list" busy={busy.list} onClick={() => run("list", async () => { const r = await actions.listNotes(persona, inv, units, askC); setAmt(""); setAsk(""); return r; }, `Listed ${tokens(units)} of ${inv.noteSymbol} at ${sgd(askC)}.`)}>
        List {tokens(units)} for {sgd(askC)}
      </Button>
    </div>
  );
}

export { Hash, StatusPill };
