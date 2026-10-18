import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ethers } from "ethers";
import { ACTORS, DAY } from "../../shared/constants.mjs";
import { makeEInvoice, hashEInvoice } from "../../shared/einvoice.mjs";
import { bootSandbox, connectWallet } from "./chainClient.js";
import { loadSnapshot } from "./model.js";
import { makeActions } from "./actions.js";
import { buildSteps, mainInvoice } from "./guided.js";
import { sgd, date, shortHex } from "./format.js";
import { Button, Notice } from "./ui.jsx";
import { Activity } from "./activity.jsx";
import SmeView from "./views/SmeView.jsx";
import OpsView from "./views/OpsView.jsx";
import InvestorView from "./views/InvestorView.jsx";
import BuyerView from "./views/BuyerView.jsx";
import ExplorerView from "./views/ExplorerView.jsx";
import ResultsView from "./views/ResultsView.jsx";

const PERSONA_GROUPS = [
  ["Supply chain", ["sme", "buyer"]],
  ["Platform", ["admin"]],
  ["Investors", ["investorA", "investorB", "investorC"]],
  ["Outside the network", ["unverified"]],
];
const ROLE_LINE = {
  sme: "SME supplier",
  buyer: "Corporate buyer",
  admin: "Verification, grading, KYC",
  investorA: "Accredited investor",
  investorB: "Institutional investor",
  investorC: "Accredited individual",
  unverified: "No KYC record",
};
const defaultView = (p) => (p === "sme" ? "sme" : p === "buyer" ? "buyer" : p === "admin" ? "ops" : "investor");

function makeInbox(now) {
  const mk = (ref, buyerKey, amount, days, description, approved = true) => {
    const doc = makeEInvoice({ ref, supplier: ACTORS.sme, buyer: ACTORS[buyerKey], faceValueSgd: amount, issueDate: now, dueDate: now + days * DAY, description, buyerApproved: approved });
    return { doc, hash: hashEInvoice(ethers, doc), buyerKey, supplierKey: "sme", dueTs: now + days * DAY };
  };
  return [
    mk("INV-2026-0412", "buyer", 100_000, 90, "Marine pump overhaul, 3 vessels"),
    mk("INV-2026-0415", "bgBuyer1", 62_000, 60, "Heat-exchanger retubing, Jurong Island plant"),
    mk("INV-2026-0419", "buyer", 36_500, 30, "Spare impellers and seals", false),
  ];
}

const NAV = {
  sme: [["sme", null, "Invoices & financing"]],
  buyer: [["buyer", null, "Payables"]],
  admin: [["ops", "queue", "Verification"], ["ops", "pricing", "Grades & pricing"], ["ops", "kyc", "Identity registry"], ["ops", "book", "Platform book"]],
  investor: [["investor", "market", "Marketplace"], ["investor", "portfolio", "Portfolio"], ["investor", "ddex", "DDEx market"]],
};
const navFor = (p) => (p === "sme" || p === "buyer" || p === "admin" ? NAV[p] : NAV.investor);

function App() {
  const [phase, setPhase] = useState("boot");
  const [bootLog, setBootLog] = useState([]);
  const [bootErr, setBootErr] = useState(null);
  const [client, setClient] = useState(null);
  const [snap, setSnap] = useState(null);
  const [inbox, setInbox] = useState([]);
  const [persona, setPersona] = useState(null);
  const [view, setView] = useState("sme");
  const [tabs, setTabs] = useState({ ops: "queue", investor: "market", explorer: "tx" });
  const [busy, setBusy] = useState({});
  const [toasts, setToasts] = useState([]);
  const [flags, setFlags] = useState({});
  const [, setVer] = useState(0);
  const [checklist, setChecklist] = useState(true);
  const [stepsOpen, setStepsOpen] = useState(false);
  const [menu, setMenu] = useState(null); // "account" | "tools" | null
  const [activityOpen, setActivityOpen] = useState(true);
  const toastId = useRef(0);

  const toast = useCallback((tone, title, body) => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-1), { id, tone, title, body }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "good" ? 4000 : 9000);
  }, []);

  const refresh = useCallback(async (c = client) => {
    if (!c) return;
    setSnap(await loadSnapshot(c));
  }, [client]);

  const boot = useCallback(async () => {
    setPhase("boot");
    setBootLog([]);
    setBootErr(null);
    setFlags({});
    setMenu(null);
    try {
      const c = await bootSandbox((entry) => setBootLog((l) => [...l, entry]));
      c.subscribe(() => setVer((v) => v + 1));
      const s = await loadSnapshot(c);
      setInbox(makeInbox(s.time));
      setClient(c);
      setSnap(s);
      setPersona(null);
      setPhase("ready");
    } catch (e) {
      console.error(e);
      setBootErr(e.message || String(e));
    }
  }, []);

  useEffect(() => { boot(); }, [boot]);

  // close menus on outside click / Escape
  useEffect(() => {
    if (!menu) return;
    const close = (e) => { if (e.type === "keydown" ? e.key === "Escape" : !e.target.closest(".menu-wrap")) setMenu(null); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", close); };
  }, [menu]);

  const actions = useMemo(() => (client ? makeActions(client) : null), [client]);

  const run = useCallback(async (key, fn, success, opts = {}) => {
    setBusy((b) => ({ ...b, [key]: true }));
    try {
      const r = await fn();
      if (success) toast("good", success);
      return r;
    } catch (e) {
      const compliance = /TransferNotCompliant|NotEligibleInvestor|DuplicateInvoice/.test(e.name);
      if (opts.expectFail || compliance) toast("warn", "Blocked by the contract, as designed", e.message);
      else toast("bad", e.name === "Error" || !e.name ? "Transaction failed" : "Transaction reverted", e.message);
    } finally {
      setBusy((b) => ({ ...b, [key]: false }));
      await refresh();
    }
  }, [refresh, toast]);

  const setFlag = useCallback((k, v) => setFlags((f) => ({ ...f, [k]: v })), []);
  const setTab = (v) => (t) => setTabs((x) => ({ ...x, [v]: t }));
  const goto = (v, t) => { setView(v); if (t) setTabs((x) => ({ ...x, [v]: t })); setMenu(null); };

  const signIn = (p) => {
    setPersona(p);
    setView(defaultView(p));
    setMenu(null);
  };

  const steps = phase === "ready" && snap ? buildSteps({ snap, flags, canTimeTravel: client.mode === "sandbox" }) : [];
  const curIdx = steps.findIndex((s) => !s.done);
  const cur = steps[curIdx];

  // Highlight the control the presenter should click next (never clicks it).
  useEffect(() => {
    document.querySelectorAll(".cue-pulse").forEach((el) => el.classList.remove("cue-pulse"));
    if (!checklist || !cur?.cue || !persona) return;
    if (cur.actor && cur.actor !== persona) return;
    const el = document.querySelector(cur.cue);
    if (el) el.classList.add("cue-pulse");
  });

  const connect = async (json) => {
    try {
      const deployment = JSON.parse(json);
      const c = await connectWallet(deployment);
      c.subscribe(() => setVer((v) => v + 1));
      const s = await loadSnapshot(c);
      setInbox(makeInbox(s.time));
      setClient(c);
      setSnap(s);
      const who = await c.connectedActor();
      if (who && who !== "observer") signIn(who);
      window.ethereum?.on?.("accountsChanged", async () => {
        const w = await c.connectedActor();
        if (w && w !== "observer") signIn(w);
        setSnap(await loadSnapshot(c));
      });
      toast("good", `Connected to ${deployment.network}`, who === "observer" ? "Your wallet isn't one of the demo accounts, so you can view but not act." : `Signed in as ${ACTORS[who]?.name}.`);
    } catch (e) {
      toast("bad", "Could not connect", e.message);
    }
  };

  if (phase === "boot") return <BootScreen log={bootLog} error={bootErr} onRetry={boot} />;
  if (!persona) return <SignIn snap={snap} onSignIn={signIn} />;

  const goStep = (st) => {
    if (st.actor && st.actor !== persona) signIn(st.actor);
    if (st.view) goto(st.view[0], st.view[1]);
    if (!st.view && st.cue === "#btn-demo-tools") setMenu("tools");
  };

  const main = mainInvoice(snap);
  const fastForward = async (d) => {
    setMenu(null);
    await run("ff", () => actions.fastForward(d), `Chain clock moved forward ${d} days, to ${date(snap.time + d * DAY)}.`);
  };
  const toDueSecs = main && main.status === 4 && main.dueDate > snap.time ? main.dueDate - snap.time : null;
  const fastForwardToDue = async () => {
    setMenu(null);
    await run("ff", () => actions.fastForwardSeconds(toDueSecs), `Chain clock moved to the due date, ${date(main.dueDate)}.`);
  };

  const viewProps = { persona, snap, inbox, actions, run, busy, ledger: client.ledger, client, flags, setFlag };
  const nav = navFor(persona);
  const navOn = (v, t) => view === v && (!t || tabs[v] === t);
  const needSwitch = cur && cur.actor && cur.actor !== persona;

  return (
    <div className="shell">
      <header className="top">
        <div className="top-row">
          <button type="button" className="wordmark-btn" onClick={() => goto(defaultView(persona))} aria-label="ReceivaSG home"><span className="wordmark">ReceivaSG</span></button>
          <nav className="topnav" aria-label="Pages">
            {nav.map(([v, t, label]) => (
              <button key={label} type="button" className={navOn(v, t) ? "on" : ""} onClick={() => goto(v, t)}>{label}</button>
            ))}
            <span className="topnav-sep" aria-hidden="true" />
            <button id="nav-explorer" type="button" className={view === "explorer" ? "on" : ""} onClick={() => goto("explorer")}>Explorer</button>
            <button id="nav-results" type="button" className={view === "results" ? "on" : ""} onClick={() => goto("results")}>Results</button>
          </nav>
          <div className="top-right">
            <div className="chainchip" title={client.mode === "sandbox" ? "All contracts run on an EVM inside this page" : client.network}>
              <span className="live" aria-hidden="true" />
              <span>{client.mode === "sandbox" ? "Sandbox chain" : client.network}</span>
              <span className="mono">#{snap.block}</span>
              <span>{date(snap.time)}</span>
            </div>
            <div className="menu-wrap">
              <button id="btn-demo-tools" type="button" className="hbtn" aria-haspopup="menu" aria-expanded={menu === "tools"} onClick={() => setMenu(menu === "tools" ? null : "tools")}>
                {busy.ff ? <span className="spin" aria-hidden="true" /> : null}Demo tools
              </button>
              {menu === "tools" ? (
                <div className="menu" role="menu">
                  <span className="menu-k">Move the chain clock</span>
                  {client.mode === "sandbox" ? (
                    <>
                      {[7, 30].map((d) => <button key={d} type="button" role="menuitem" onClick={() => fastForward(d)}>+{d} days</button>)}
                      {toDueSecs ? <button type="button" role="menuitem" onClick={fastForwardToDue}>To INV-2026-0412 due date ({Math.round(toDueSecs / DAY)} days)</button> : null}
                    </>
                  ) : <span className="menu-note">Not possible on a public network.</span>}
                  <span className="menu-k">View</span>
                  <button type="button" role="menuitem" onClick={() => { setChecklist(!checklist); setMenu(null); }}>{checklist ? "Hide" : "Show"} presenter checklist</button>
                  <button type="button" role="menuitem" onClick={() => { setActivityOpen(!activityOpen); setMenu(null); }}>{activityOpen ? "Hide" : "Show"} blockchain activity</button>
                  {client.mode === "sandbox" ? <button type="button" role="menuitem" className="danger" onClick={boot}>Reset demo (new chain)</button> : null}
                </div>
              ) : null}
            </div>
            <div className="menu-wrap">
              <button id="btn-account" type="button" className="hbtn acct" aria-haspopup="menu" aria-expanded={menu === "account"} onClick={() => setMenu(menu === "account" ? null : "account")}>
                <span className="avatar" aria-hidden="true">{ACTORS[persona].short.slice(0, 1)}</span>
                <span className="acct-text"><strong>{ACTORS[persona].short}</strong><span>{roleLine(persona, snap)}</span></span>
              </button>
              {menu === "account" ? (
                <div className="menu acct-menu" role="menu">
                  <span className="menu-k">Switch demo account</span>
                  {PERSONA_GROUPS.map(([g, keys]) => (
                    <div key={g} className="menu-group">
                      <span className="menu-g">{g}</span>
                      {keys.map((k) => (
                        <button key={k} type="button" role="menuitem" className={`acct-item${k === persona ? " on" : ""}${checklist && cur?.actor === k && k !== persona ? " cue-soft" : ""}`} onClick={() => signIn(k)}>
                          <span><strong>{ACTORS[k].short}</strong><em>{roleLine(k, snap)}</em></span>
                          <span className="mono">{sgd(snap.balances[k])}</span>
                        </button>
                      ))}
                    </div>
                  ))}
                  {client.mode === "wallet" ? <span className="menu-note">Wallet mode: switch accounts in your wallet.</span> : null}
                  <button type="button" role="menuitem" onClick={() => { setPersona(null); setMenu(null); }}>Sign out</button>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </header>

      {checklist && cur ? (
        <section className="guide" aria-label="Presenter checklist">
          <div className="guide-inner">
            <div className="guide-progress" aria-hidden="true">
              {steps.map((s, i) => <span key={s.id} className={s.done ? "d" : i === curIdx ? "c" : ""} />)}
            </div>
            <div className="guide-main">
              <div className="guide-text">
                <span className="guide-k">Presenter checklist · step {curIdx + 1} of {steps.length}{cur.actor ? ` · as ${ACTORS[cur.actor].short}` : ""}</span>
                <strong>{cur.title}</strong>
                <p><span className="how">{cur.how}</span> {cur.why}</p>
              </div>
              <div className="guide-actions">
                {needSwitch ? <Button kind="ghost" onClick={() => goStep(cur)}>Switch to {ACTORS[cur.actor].short}</Button>
                  : cur.view && !navOn(cur.view[0], cur.view[1]) ? <Button kind="ghost" onClick={() => goStep(cur)}>Go to page</Button> : null}
                <button type="button" className="link" onClick={() => setStepsOpen(!stepsOpen)} aria-expanded={stepsOpen}>{stepsOpen ? "Hide steps" : "All steps"}</button>
                <button type="button" className="link" onClick={() => setChecklist(false)}>Hide</button>
              </div>
            </div>
            {stepsOpen ? (
              <ol className="steps">
                {steps.map((s, i) => (
                  <li key={s.id} className={s.done ? "d" : i === curIdx ? "c" : ""}>
                    <button type="button" onClick={() => goStep(s)}><span className="n">{s.done ? "✓" : i + 1}</span>{s.title}</button>
                  </li>
                ))}
              </ol>
            ) : null}
          </div>
        </section>
      ) : null}

      <div className={`body${activityOpen ? "" : " no-activity"}`}>
        <main className="main" id="main">
          {view === "sme" ? <SmeView {...viewProps} /> : null}
          {view === "ops" ? <OpsView {...viewProps} tab={tabs.ops} setTab={setTab("ops")} hideTabs /> : null}
          {view === "investor" ? <InvestorView {...viewProps} tab={tabs.investor} setTab={setTab("investor")} hideTabs /> : null}
          {view === "buyer" ? <BuyerView {...viewProps} /> : null}
          {view === "explorer" ? <ExplorerView {...viewProps} tab={tabs.explorer} setTab={setTab("explorer")} walletPanel={<WalletPanel client={client} onConnect={connect} onSandbox={boot} />} /> : null}
          {view === "results" ? <ResultsView {...viewProps} /> : null}
        </main>
        {activityOpen ? <Activity ledger={client.ledger} client={client} onOpenExplorer={() => goto("explorer", "tx")} onClose={() => setActivityOpen(false)} /> : null}
      </div>

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <Notice key={t.id} tone={t.tone} title={t.title} onClose={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>{t.body}</Notice>
        ))}
      </div>
    </div>
  );
}

const roleLine = (k, snap) => (k === "unverified" && snap.identities.unverified?.verified ? "KYC completed" : ROLE_LINE[k]);

function SignIn({ snap, onSignIn }) {
  return (
    <div className="signin">
      <div className="signin-card">
        <span className="wordmark">ReceivaSG</span>
        <h1>Sign in</h1>
        <p>Tokenised receivables financing for Singapore SMEs. This prototype runs on its own blockchain with demo accounts. Choose one to sign in; you can switch accounts from the top-right menu at any time.</p>
        <p className="signin-tip">To follow the press-release example, start as <strong>Meridian Engineering</strong>.</p>
        {PERSONA_GROUPS.map(([g, keys]) => (
          <div key={g} className="signin-group">
            <span className="menu-g">{g}</span>
            <div className="signin-grid">
              {keys.map((k) => (
                <button key={k} id={`signin-${k}`} type="button" className="signin-acct" onClick={() => onSignIn(k)}>
                  <span className="avatar" aria-hidden="true">{ACTORS[k].short.slice(0, 1)}</span>
                  <span className="signin-who"><strong>{ACTORS[k].name}</strong><em>{roleLine(k, snap)}</em></span>
                  <span className="mono">{sgd(snap.balances[k])}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function BootScreen({ log, error, onRetry }) {
  const deployed = log.filter((e) => e.kind === "deploy");
  const txs = log.filter((e) => e.kind === "tx").length;
  return (
    <div className="boot">
      <div className="boot-card">
        <span className="wordmark">ReceivaSG</span>
        <h1>Starting the sandbox chain</h1>
        <p>An Ethereum virtual machine is running inside this page. The six ReceivaSG contracts are being deployed to it, then demo identities, tokenised SGD balances and three background invoices are created with real transactions.</p>
        <ul className="boot-list">
          {["TokenisedSGD", "IdentityRegistry", "InvoiceNFT", "ReceivableNote", "ReceivaSPV", "DDExMarket"].map((n) => {
            const d = deployed.find((x) => x.name === n);
            return <li key={n} className={d ? "ok" : ""}><span>{n}</span><code>{d ? shortHex(d.address, 10, 6) : "deploying…"}</code></li>;
          })}
        </ul>
        <p className="muted-s">{txs} setup transactions mined</p>
        {error ? (
          <Notice tone="bad" title="The sandbox chain didn't start">{error} <Button small onClick={onRetry}>Try again</Button></Notice>
        ) : null}
      </div>
    </div>
  );
}

function WalletPanel({ client, onConnect, onSandbox }) {
  const [json, setJson] = useState("");
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Network</h2>
        <p>
          {client.mode === "sandbox"
            ? "You are on the sandbox chain: the contracts run in an EthereumJS VM inside this page, with one block per transaction and adjustable time."
            : `Connected through your wallet to ${client.network}.`}
        </p>
      </div>
      <div className="kv-wrap">
        <dl className="kv">
          <div><dt>Mode</dt><dd>{client.mode === "sandbox" ? "Sandbox chain (chain id 1337)" : "Browser wallet"}</dd></div>
          <div><dt>SPV contract</dt><dd><code>{client.addresses.spv}</code></dd></div>
        </dl>
      </div>
      <h3>Use contracts deployed to Sepolia or a Hardhat node</h3>
      <p className="muted-s">Run <code>npm run deploy:sepolia</code> (or <code>deploy:local</code>) from the project, then paste the contents of the deployment file it writes. This needs the standalone HTML file opened in a browser with MetaMask; it doesn't work inside an embedded preview.</p>
      <label className="sr" htmlFor="deploy-json">Deployment JSON</label>
      <textarea id="deploy-json" className="input mono" rows={5} placeholder='{"network":"sepolia","chainId":11155111,"contracts":{…},"actors":{…}}' value={json} onChange={(e) => setJson(e.target.value)} />
      <div className="row-actions">
        <Button disabled={!json.trim()} onClick={() => onConnect(json)}>Connect wallet</Button>
        {client.mode !== "sandbox" ? <Button kind="ghost" onClick={onSandbox}>Back to sandbox chain</Button> : null}
      </div>
    </section>
  );
}

createRoot(document.getElementById("root")).render(<App />);
