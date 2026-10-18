export function sgd(cents, { dp, sign = false } = {}) {
  if (cents === undefined || cents === null || Number.isNaN(cents)) return "—";
  const d = dp ?? (Math.round(cents) % 100 !== 0 ? 2 : 0);
  const v = Math.abs(cents) / 100;
  const s = v.toLocaleString("en-SG", { minimumFractionDigits: d, maximumFractionDigits: d });
  const pre = cents < 0 ? "−" : sign && cents > 0 ? "+" : "";
  return `${pre}S$${s}`;
}

export const pct = (x, dp = 2) => `${x.toFixed(dp)}%`;

export function date(ts) {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleDateString("en-SG", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Singapore" });
}

export function dateTime(ts) {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString("en-SG", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Singapore" });
}

export const shortHex = (h, a = 6, b = 4) => (h ? `${h.slice(0, a)}…${h.slice(-b)}` : "");

export const days = (n) => `${n} day${n === 1 ? "" : "s"}`;

/** parse "12,500.50" → cents */
export function parseSgd(str) {
  const n = Number(String(str).replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}
