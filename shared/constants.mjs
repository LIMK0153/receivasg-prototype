// Shared constants used by the deploy script, tests and frontend.

export const GRADES = ["AAA", "AA", "A", "BBB", "BB", "B", "CCC"];

export const STATUS = ["None", "Submitted", "Offered", "Listed", "Funded", "Repaid", "Defaulted", "Cancelled"];

export const CATEGORY = ["None", "SME", "CorporateBuyer", "AccreditedInvestor", "InstitutionalInvestor"];

// ReceivableNote.canTransfer() result codes
export const COMPLIANCE_CODES = {
  0: "Compliant",
  1: "Note series is paused by the agent",
  2: "Sender wallet is frozen",
  3: "Receiver wallet is frozen",
  4: "Sender is not KYC-verified",
  5: "Receiver is not a verified accredited or institutional investor",
  6: "Sender does not hold enough notes",
  7: "Note series has been retired",
};

export const SGD_DECIMALS = 2; // tSGD and notes both use 2 decimals (cents)
export const MIN_FINANCING_PCT = 85;
export const SERVICING_FEE_BPS = 10;
export const DAY = 86400;

// Benchmark quoted in the submitted press release (footnote 2)
export const TBILL = {
  rate: 1.92,
  label: "6-month Singapore T-bill",
  source: "MAS, Singapore Government Securities auction, 29 September 2026",
  tenorDays: 182,
};

// Comparison quoted in the submitted press release (DBS Sales Invoice Financing)
export const TRADITIONAL = {
  advancePctHigh: 90,
  advanceRange: "70–90%",
  note: "Conventional invoice financing lends against a portion of the invoice; interest and fees apply and the balance is only released after the buyer pays.",
};

// Fictional demo actors (all names fictional, for academic purposes)
export const ACTORS = {
  admin:      { name: "ReceivaSG Operations",           short: "ReceivaSG Ops",  kind: "ops" },
  bank:       { name: "Issuing bank (tokenised SGD)",    short: "Issuing bank",   kind: "bank" },
  treasury:   { name: "ReceivaSG Treasury (fees)",       short: "Treasury",       kind: "treasury" },
  sme:        { name: "Meridian Engineering Pte Ltd",    short: "Meridian (SME)", kind: "sme", uen: "201912345K" },
  buyer:      { name: "Straits Marine Holdings Ltd",     short: "Straits Marine (buyer)", kind: "buyer", uen: "198800123M" },
  investorA:  { name: "Lion Gate Family Office",         short: "Lion Gate FO",   kind: "investor", type: "Accredited investor" },
  investorB:  { name: "Lim & Pang Capital",              short: "Lim & Pang",     kind: "investor", type: "Institutional investor" },
  unverified: { name: "Unverified wallet (no KYC)",      short: "Unverified",     kind: "unverified" },
  bgSme1:     { name: "Kallang Precision Pte Ltd",       short: "Kallang Precision", kind: "sme", uen: "201511223D" },
  bgSme2:     { name: "Tuas Fresh Foods Pte Ltd",        short: "Tuas Fresh Foods",  kind: "sme", uen: "201833445G" },
  bgBuyer1:   { name: "Pioneer Petrochem Asia Ltd",      short: "Pioneer Petrochem", kind: "buyer", uen: "199001122E" },
  bgBuyer2:   { name: "Jurong Build Corp Ltd",           short: "Jurong Build",      kind: "buyer", uen: "200455667H" },
  bgBuyer3:   { name: "Orchid Lane Retail Group",        short: "Orchid Lane Retail", kind: "buyer", uen: "201277889J" },
};

// Off-chain credit inputs for each buyer (the obligor whose payment backs the invoice).
// ReceivaSG's credit engine turns these into a grade; the grade is written on-chain.
export const BUYER_CREDIT = {
  bgBuyer1: { onTimePct: 99, yearsTrading: 34, revenueSgdM: 4200, overduePct: 1, invoiceNowHistory: 1840 },
  buyer:    { onTimePct: 94, yearsTrading: 18, revenueSgdM: 650,  overduePct: 7, invoiceNowHistory: 620 },
  bgBuyer2: { onTimePct: 88, yearsTrading: 20, revenueSgdM: 380,  overduePct: 11, invoiceNowHistory: 410 },
  bgBuyer3: { onTimePct: 71, yearsTrading: 6,  revenueSgdM: 45,   overduePct: 31, invoiceNowHistory: 88 },
};

/** ReceivaSG credit scorecard (off-chain model, prototype weights). */
export function creditScore(c) {
  const onTime = c.onTimePct;                                  // 0–100
  const tenure = Math.min(c.yearsTrading / 25, 1) * 100;       // 0–100
  const scale = Math.min(Math.log10(Math.max(c.revenueSgdM, 1)) / Math.log10(5000), 1) * 100;
  const overdue = Math.max(0, 100 - c.overduePct * 2.5);       // 0–100
  const history = Math.min(c.invoiceNowHistory / 1000, 1) * 100;
  const score = 0.4 * onTime + 0.15 * tenure + 0.15 * scale + 0.2 * overdue + 0.1 * history;
  return {
    score: Math.round(score * 10) / 10,
    parts: { onTime, tenure: Math.round(tenure), scale: Math.round(scale), overdue: Math.round(overdue), history: Math.round(history) },
  };
}

export function gradeFromScore(score) {
  const bands = [93, 88, 82, 74, 66, 58]; // AAA, AA, A, BBB, BB, B, else CCC
  for (let i = 0; i < bands.length; i++) if (score >= bands[i]) return i;
  return 6;
}
