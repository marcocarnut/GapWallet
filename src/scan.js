// Scans an account up to the gap limit (docs/ESPLORA.md, "Scanning").
//
//   scanAccount(account, client, { gapLimit, onProgress })
//     -> { tip, addresses: Map(address -> entry), used: [entry], coins: [Coin],
//          history: [Item], balance: { confirmed, unconfirmed },
//          next: [next receive index, next change index] }
//
//   entry = addressAt()'s, plus { stats, used }
//   Coin  = { txid, vout, value, confirmed, height, entry }
//   Item  = { txid, net, fee, kind: "in" | "out" | "self", height | null, time | null, confirmations }
import { addressAt } from "./account.js";

export const DEFAULT_GAP = 20;

const txCount = (s) => s.chain_stats.tx_count + s.mempool_stats.tx_count;
const funds = (s) => s.chain_stats.funded_txo_sum + s.mempool_stats.funded_txo_sum
  - s.chain_stats.spent_txo_sum - s.mempool_stats.spent_txo_sum;

// One chain, in order. Each round asks for exactly the addresses that could
// still complete the gap, so an empty chain costs `gapLimit` requests and
// nothing is asked past the end.
async function scanChain(account, client, chain, gapLimit, found) {
  let index = 0, emptyRun = 0, highest = -1;
  while (emptyRun < gapLimit) {
    const entries = [];
    for (let i = 0; i < gapLimit - emptyRun; i++) entries.push(addressAt(account, chain, index + i));
    const stats = await Promise.all(entries.map((e) => client.address(e.address)));
    entries.forEach((e, i) => {
      e.stats = stats[i];
      e.used = txCount(stats[i]) > 0;
      found.set(e.address, e);
      if (e.used) {
        highest = e.index;
        emptyRun = 0;
      } else {
        emptyRun++;
      }
    });
    index += entries.length;
  }
  return highest + 1;
}

// All of an address's transactions: stops at its tx_count, or at a page
// with nothing new (page sizes differ between servers).
async function historyOf(client, e, into) {
  const total = txCount(e.stats);
  const seen = new Set();
  let page = await client.txs(e.address);
  for (;;) {
    let fresh = 0, lastConfirmed = null;
    for (const t of page) {
      if (!seen.has(t.txid)) {
        seen.add(t.txid);
        fresh++;
      }
      into.set(t.txid, t);
      if (t.status.confirmed) lastConfirmed = t.txid;
    }
    if (seen.size >= total || fresh === 0 || lastConfirmed === null) return;
    page = await client.txsAfter(e.address, lastConfirmed);
  }
}

// What one transaction did to the account.
export function historyItem(t, mine, tip) {
  let spent = 0, received = 0, inputsMine = 0;
  for (const v of t.vin) {
    if (v.prevout && mine.has(v.prevout.scriptpubkey_address)) {
      spent += v.prevout.value;
      inputsMine++;
    }
  }
  for (const v of t.vout) if (mine.has(v.scriptpubkey_address)) received += v.value;
  const allOutsMine = t.vout.every((v) => mine.has(v.scriptpubkey_address));
  const self = inputsMine === t.vin.length && allOutsMine;
  const height = t.status.confirmed ? t.status.block_height : null;
  return { txid: t.txid, net: received - spent, fee: t.fee, kind: self ? "self" : inputsMine > 0 ? "out" : "in",
    height, time: t.status.block_time ?? null, confirmations: height === null ? 0 : Math.max(0, tip - height + 1) };
}

export async function scanAccount(account, client, { gapLimit = DEFAULT_GAP, onProgress } = {}) {
  const addresses = new Map();
  const say = (text) => onProgress && onProgress(text);
  const tip = await client.tipHeight();
  say("Asking about receive addresses…");
  const nextReceive = await scanChain(account, client, 0, gapLimit, addresses);
  say("Asking about change addresses…");
  const nextChange = await scanChain(account, client, 1, gapLimit, addresses);

  const used = [...addresses.values()].filter((e) => e.used);
  say("Fetching coins and history…");
  const utxoLists = await Promise.all(used.filter((e) => funds(e.stats) > 0).map(async (e) => {
    const list = await client.utxos(e.address);
    return list.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, confirmed: u.status.confirmed === true,
      height: u.status.block_height ?? null, entry: e }));
  }));
  const coins = utxoLists.flat().sort((a, b) => b.value - a.value || (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : a.vout - b.vout));

  const txs = new Map();
  await Promise.all(used.map((e) => historyOf(client, e, txs)));
  const history = [...txs.values()].map((t) => historyItem(t, addresses, tip)).sort((a, b) => {
    if ((a.height === null) !== (b.height === null)) return a.height === null ? -1 : 1;
    return (b.height ?? 0) - (a.height ?? 0) || (a.txid < b.txid ? -1 : 1);
  });

  const balance = { confirmed: 0, unconfirmed: 0 };
  for (const c of coins) balance[c.confirmed ? "confirmed" : "unconfirmed"] += c.value;
  return { tip, addresses, used, coins, history, balance, next: [nextReceive, nextChange] };
}
