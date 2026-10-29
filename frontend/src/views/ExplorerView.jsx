import React, { useEffect, useState } from "react";
import { STATUS, GRADES } from "../../../shared/constants.mjs";
import { sgd, date } from "../format.js";
import { Hash, Empty, StatusPill } from "../ui.jsx";
import { actorShort } from "../model.js";
import { EventList } from "../activity.jsx";

const CONTRACTS = [
  ["spv", "ReceivaSPV", "Bankruptcy-remote SPV: buys invoices, prices them by grade, runs funding, settlement and payouts."],
  ["nft", "InvoiceNFT (ERC-721)", "One non-transferable token per validated receivable, held by the SPV. Stores the e-invoice hash and status."],
  ["noteImpl", "ReceivableNote (ERC-3643 token)", "Template for the permissioned token series. One clone is deployed per invoice."],
  ["registry", "IdentityRegistry", "KYC/AML registry. Every token transfer checks it before executing."],
  ["tsgd", "TokenisedSGD", "Simulated tokenised SGD bank deposit used for every cash leg."],
  ["market", "DDExMarket", "Simulated DDEx venue for secondary trading, with atomic DvP."],
];

export default function ExplorerView({ snap, client, ledger, tab, setTab, walletPanel }) {
  return (
    <div className="view">
      <header className="view-head">
        <div>
          <h1>On-chain explorer</h1>
          <p className="sub">{client.mode === "sandbox" ? "ReceivaSG sandbox chain (EthereumJS VM in this page), chain id 1337" : client.network} · block #{snap.block}</p>
        </div>
      </header>
      <nav className="tabs" aria-label="Explorer sections">
        {[["tx", "Transactions"], ["contracts", "Contracts"], ["nfts", "Invoice NFTs"], ["network", "Network"]].map(([k, l]) => (
          <button key={k} type="button" className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>
        ))}
      </nav>
      {tab === "tx" ? <Txs ledger={ledger} client={client} /> : null}
      {tab === "contracts" ? (
        <section className="panel">
          <div className="table-wrap">
            <table className="grid">
              <thead><tr><th>Contract</th><th>Address</th><th>Role</th></tr></thead>
              <tbody>
                {CONTRACTS.map(([k, n, d]) => <tr key={k}><td><strong>{n}</strong></td><td><Hash value={client.addresses[k]} a={10} b={6} /></td><td>{d}</td></tr>)}
                {snap.invoices.filter((i) => i.noteSymbol).map((i) => (
                  <tr key={i.note}><td><strong>{i.noteSymbol}</strong></td><td><Hash value={i.note} a={10} b={6} /></td><td>Note series for {i.ref}: {sgd(i.noteSupply)} outstanding, {i.holders.length} holder{i.holders.length === 1 ? "" : "s"}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
      {tab === "nfts" ? <Nfts snap={snap} client={client} /> : null}
      {tab === "network" ? walletPanel : null}
    </div>
  );
}

function Txs({ ledger, client }) {
  const [open, setOpen] = useState(null);
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Transactions</h2>
        <p>{ledger.length} entries, newest first, including contract deployment and demo setup. Select one to see the events it emitted.</p>
      </div>
      <div className="table-wrap">
        <table className="grid txs">
          <thead><tr><th>Block</th><th>Action</th><th>Contract</th><th className="r">Gas</th><th>Tx hash</th><th>Result</th></tr></thead>
          <tbody>
            {ledger.map((e) => (
              <React.Fragment key={e.id}>
                <tr className={`click${open === e.id ? " sel" : ""}`} onClick={() => setOpen(open === e.id ? null : e.id)}>
                  <td>{e.block ?? "…"}</td>
                  <td>{e.label}{e.setup ? <span className="pill muted">setup</span> : null}</td>
                  <td>{e.contract || ""}</td>
                  <td className="r">{e.gasUsed ? e.gasUsed.toLocaleString("en-SG") : ""}</td>
                  <td>{e.hash ? <Hash value={e.hash} /> : ""}</td>
                  <td>{e.status === "ok" ? <span className="pill good">success</span> : e.status === "reverted" ? <span className="pill bad">reverted</span> : e.status === "time" ? <span className="pill neutral">time</span> : <span className="pill neutral">pending</span>}</td>
                </tr>
                {open === e.id ? (
                  <tr className="detail"><td colSpan={6}>{e.error ? <p className="field-err">{e.error}</p> : null}<EventList events={e.events} client={client} /></td></tr>
                ) : null}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Nfts({ snap, client }) {
  const minted = snap.invoices.filter((i) => i.note && i.status !== 7 && i.status >= 3);
  const [meta, setMeta] = useState({});
  useEffect(() => {
    let live = true;
    (async () => {
      const out = {};
      for (const i of minted) {
        try {
          const uri = await client.read.nft.tokenURI(i.id);
          out[i.id] = JSON.parse(atob(uri.split(",")[1]));
        } catch {}
      }
      if (live) setMeta(out);
    })();
    return () => { live = false; };
  }, [snap.block]);
  if (!minted.length) return <section className="panel"><Empty>No Invoice NFTs minted yet. One is minted when an SME accepts an offer.</Empty></section>;
  return (
    <div className="nft-grid">
      {minted.map((i) => (
        <article key={i.id} className="nft">
          <div className="nft-top"><strong>RSG-INV #{i.id}</strong><StatusPill status={i.status} /></div>
          <p className="sub">{i.ref} · {actorShort(i.supplier)} → {actorShort(i.buyer)}</p>
          <dl className="kv">
            <div><dt>Owner</dt><dd>ReceivaSG SPV (non-transferable)</dd></div>
            <div><dt>Face value</dt><dd>{sgd(i.face)}</dd></div>
            <div><dt>Grade</dt><dd>{GRADES[i.grade]}</dd></div>
            <div><dt>Due</dt><dd>{date(i.dueDate)}</dd></div>
            <div><dt>e-invoice hash</dt><dd><Hash value={i.docHash} a={10} b={6} /></dd></div>
            <div><dt>Note series</dt><dd>{i.noteSymbol}</dd></div>
          </dl>
          {meta[i.id] ? <details><summary>tokenURI metadata (on-chain)</summary><pre>{JSON.stringify(meta[i.id], null, 2)}</pre></details> : null}
        </article>
      ))}
    </div>
  );
}

export { STATUS };
