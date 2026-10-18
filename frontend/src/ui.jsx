import React, { useState } from "react";
import { GRADES, STATUS } from "../../shared/constants.mjs";
import { shortHex } from "./format.js";

export function GradeChip({ grade, size }) {
  return (
    <span className={`grade g${grade}${size === "lg" ? " lg" : ""}`} title={`ReceivaSG grade ${GRADES[grade]}`}>
      {GRADES[grade]}
    </span>
  );
}

const STATUS_LABEL = {
  1: "Submitted",
  2: "Offer ready",
  3: "Open for funding",
  4: "Funded",
  5: "Paid out",
  6: "Defaulted",
  7: "Cancelled",
};
const STATUS_TONE = { 1: "neutral", 2: "accent", 3: "accent", 4: "good", 5: "done", 6: "bad", 7: "muted" };

export function StatusPill({ status }) {
  return <span className={`pill ${STATUS_TONE[status]}`}>{STATUS_LABEL[status] || STATUS[status]}</span>;
}

export function Hash({ value, a = 6, b = 4, title }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  const copy = async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {}
  };
  return (
    <button type="button" className="hash" onClick={copy} title={title || value}>
      {copied ? "copied" : shortHex(value, a, b)}
    </button>
  );
}

export function Progress({ value, max, tone }) {
  const p = max ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className={`progress ${tone || ""}`} role="progressbar" aria-valuenow={Math.round(p)} aria-valuemin={0} aria-valuemax={100}>
      <span style={{ width: `${p}%` }} />
    </div>
  );
}

export function Button({ children, onClick, kind = "primary", busy, disabled, small, title, id }) {
  return (
    <button id={id} type="button" className={`btn ${kind}${small ? " sm" : ""}`} onClick={onClick} disabled={disabled || busy} title={title}>
      {busy ? <span className="spin" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

export function Notice({ tone = "info", title, children, onClose }) {
  return (
    <div className={`notice ${tone}`} role={tone === "bad" ? "alert" : "status"}>
      <div>
        {title ? <strong>{title}</strong> : null}
        {children ? <div className="notice-body">{children}</div> : null}
      </div>
      {onClose ? (
        <button type="button" className="x" onClick={onClose} aria-label="Dismiss">
          ×
        </button>
      ) : null}
    </div>
  );
}

export function KV({ items }) {
  return (
    <dl className="kv">
      {items.filter(Boolean).map(([k, v], i) => (
        <div key={i}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Empty({ children }) {
  return <p className="empty">{children}</p>;
}

/** Lifecycle rail for one invoice: shows where it is and when each step happened. */
export function Lifecycle({ inv }) {
  const steps = [
    { s: 1, label: "Submitted", at: inv.submittedAt },
    { s: 2, label: "Verified & graded" },
    { s: 3, label: "Sold to SPV" },
    { s: 4, label: "Funded", at: inv.fundedAt },
    { s: 5, label: inv.status === 6 ? "Defaulted" : "Buyer paid", at: inv.closedAt && inv.status >= 5 ? inv.closedAt : 0 },
  ];
  const cur = inv.status === 7 ? 0 : inv.status === 6 ? 5 : inv.status;
  return (
    <ol className="rail">
      {steps.map((st) => (
        <li key={st.s} className={cur > st.s ? "done" : cur === st.s ? `now${inv.status === 6 ? " bad" : ""}` : ""}>
          <span className="dot" aria-hidden="true" />
          <span className="lbl">{st.label}</span>
        </li>
      ))}
    </ol>
  );
}
