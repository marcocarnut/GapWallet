// The price of bitcoin, for "About 1,234.56 USD" under a mainnet balance
// (BITCOIN.md, W5). Off mainnet nothing is fetched: test coins have no value,
// and the page says so instead.
//
// The page asks the quote server for the quote and nothing else: the URL is
// the one in Settings, fetched as it is, with nothing added to it. No address,
// key or amount goes there. The server learns the IP that asks, and when.
//
// SPDX-License-Identifier: GPL-3.0-or-later
import { tr } from "./i18n.js";

export const CURRENCIES = ["USD", "BRL"];

// Coinbase's public spot price: no key, answers browsers (CORS)
export const PRICE_DEFAULTS = {
  USD: "https://api.coinbase.com/v2/prices/BTC-USD/spot",
  BRL: "https://api.coinbase.com/v2/prices/BTC-BRL/spot",
};

const TIMEOUT_MS = 15000;

export class PriceError extends Error {
  constructor(message) {
    super(message);
    this.name = "PriceError";
  }
}

// A quote URL as typed, checked: http(s), no user name or password.
export function parsePriceUrl(text) {
  let u;
  try {
    u = new URL(String(text).trim());
  } catch {
    throw new PriceError(tr("That isn't a web address."));
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new PriceError(tr("A server's address starts with https:// or http://."));
  if (u.username || u.password) throw new PriceError(tr("A server's address can't hold a user name or password."));
  return u.href;
}

// The price in the answer. Understands the answers of the common free quote
// servers: a bare number; Coinbase's { data: { amount, currency } }; CoinGecko's
// { bitcoin: { brl } }; mempool.space's { USD }. Only the bare number can't say
// which currency it is in: that one is taken on trust from Settings.
export function parsePrice(text, currency) {
  const fail = () => { throw new PriceError(tr("The price server's answer has no price in {currency}.", { currency })); };
  const number = (v) => {
    const n = typeof v === "string" && /^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v) : v;
    return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
  };
  const bare = number(String(text));
  if (bare) return bare;
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return fail();
  }
  // An answer that names its currency must name the chosen one: a BRL URL set
  // for USD mustn't show as dollars. Coinbase's always names it.
  if (j?.data?.amount !== undefined && j.data.currency !== currency) {
    throw new PriceError(tr("The price server answered in {got}, not {currency}.", { got: String(j.data.currency ?? "?"), currency }));
  }
  const found = [j?.data?.amount, j?.bitcoin?.[currency.toLowerCase()], j?.[currency]].map(number).find(Boolean);
  return found ?? fail();
}

export async function fetchPrice(url, currency, { fetch: f = globalThis.fetch } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let r;
  try {
    r = await f(url, { signal: ctl.signal, credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" });
  } catch (e) {
    throw new PriceError(tr("The price server can't be reached. ({reason})", { reason: e.message }));
  } finally {
    clearTimeout(timer);
  }
  const text = await r.text();
  if (!r.ok) throw new PriceError(tr("The price server answered {status}.", { status: String(r.status) }));
  return parsePrice(text, currency);
}

// What `sats` are worth at `price` a bitcoin, in cents, rounded
export const valueInCents = (sats, price) => Math.round((sats * price) / 1e6);
