// Amounts, as text and whole satoshis. Never through floating point.
export const SATS = 100000000;
const MAX_SATS = 2100000000000000;

export function parseBtc(text) {
  const s = String(text).trim();
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (s === "" || !m || (m[1] === "" && !m[2])) throw new RangeError("Enter an amount in BTC, like 0.001.");
  if ((m[2] || "").length > 8) throw new RangeError("Bitcoin has 8 decimal places at most.");
  const sats = Number(BigInt(m[1] || "0") * 100000000n + BigInt((m[2] || "").padEnd(8, "0") || "0"));
  if (!Number.isSafeInteger(sats) || sats > MAX_SATS) throw new RangeError("That's more bitcoin than there is.");
  return sats;
}

export function formatBtc(sats) {
  const negative = sats < 0;
  const n = Math.abs(sats);
  const whole = Math.floor(n / SATS);
  return `${negative ? "-" : ""}${whole}.${String(n % SATS).padStart(8, "0")}`;
}
