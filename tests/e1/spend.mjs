// E1, part 3 (docs/E1.md): real spends on signet, through harness.mjs. Each runs
// page to signer to page and is broadcast by the page's own button. Spends the test
// wallet's coins, so don't run it twice: it refuses unless the coins are the ones
// planned below. It stops at the first thing that isn't as expected, before the next
// broadcast. Not part of npm test.
//
//   E1_WORDS="..." node --experimental-default-type=module tests/e1/spend.mjs out-dir
//
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { addressAt } from "../../src/account.js";
import { parseAccount } from "../../src/descriptor.js";
import { DESCRIPTORS, FINGERPRINT } from "./wallet.mjs";
import { BUILT, LONG, OUT, PAYEE, browser, buildRow, fine, net, nothingSecret, oneCode, openAccount, pageFee, posts, proxy, read, record,
  seriesCodes, sent, server, signAndReadBack, upstream } from "./harness.mjs";

net.live = true;
const GAP = 5; // of the page's 20: each scan costs the public server about a third
const POLL_MS = 60000;
const CONFIRM_WAIT_MS = 90 * 60000;

const sleep = (ms) => new Promise((d) => setTimeout(d, ms));
const shortId = (id) => `${id.slice(0, 10)}…${id.slice(-6)}`;
const toSats = (text) => Math.round(Number(text.replace(/[^\d.-]/g, "")) * 1e8);
const own = (purpose, i) => addressAt(parseAccount(DESCRIPTORS[purpose], "signet", FINGERPRINT), 0, i).address;

const scanDone = (page) => page.waitForFunction(() => {
  const r = document.getElementById("refresh");
  return r && !r.disabled;
}, { timeout: LONG * 3 });

// What the page says now: balance, history and coins, as a user reads them.
async function look(page) {
  await scanDone(page);
  await page.click("#tab-overview");
  await page.waitForSelector("#balance");
  const overview = await page.evaluate(() => ({
    balance: document.getElementById("balance").textContent,
    unconfirmed: document.getElementById("unconfirmed")?.textContent ?? null,
    history: [...document.querySelectorAll("#history tbody tr")].map((r) => ({
      kind: r.className, when: r.children[0].innerText.replace(/\s+/g, " "), what: r.children[1].innerText.replace(/\s+/g, " "), amount: r.children[2].innerText,
    })),
  }));
  await page.click("#tab-send");
  await page.waitForSelector("#address");
  await page.$eval("details", (e) => { e.open = true; });
  const coins = await page.$$eval("#coins tr", (rows) => rows.map((r) => [r.children[1].textContent.trim(), r.children[2].textContent.trim()]));
  return { ...overview, coins: coins.map(([where, value]) => ({ path: where.split(" ")[0], unconfirmed: where.includes("unconfirmed"), sats: toSats(value) })) };
}

async function rescan(page) {
  net.generation++;
  await scanDone(page);
  await page.click("#refresh");
  await sleep(500);
  return look(page);
}

function holdsCoins(state, want, where) {
  const got = Object.fromEntries(state.coins.map((c) => [c.path, c.sats]));
  assert.deepEqual(got, want, `the coins on ${where}`);
}

// One spend, broadcast. Stops the script if anything isn't so.
async function spend({ name, purpose, page, coins, inputs, amount, to, series, kind, change, received, after }) {
  const tag = `${purpose}-${name.replace(/[^a-zA-Z0-9]+/g, "-")}`;
  const review = await buildRow(page, { coins, amount: (amount / 1e8).toFixed(8), to });
  const fee = pageFee(review);
  const built = series ? await seriesCodes(page, 2) : { codes: await oneCode(page) };
  const r = await signAndReadBack(page, tag, built.codes, coins.length);
  assert.ok(fine(r, review), `${tag}: not as reviewed: ${JSON.stringify(r.says)} ${r.back?.result}`);
  assert.equal(r.back.broadcast, "on");
  assert.ok(r.says.some((l) => /^change: 0 claimed, 1 checked, 0 stray, 0 unverified, 0 refuted, 0 far/.test(l)), `${tag}: the change: ${JSON.stringify(r.says)}`);
  const signerHash = /SHA-256 ([0-9a-f]+)/.exec(r.says.find((l) => l.startsWith("signed")))[1];

  net.posts = 1;
  await page.click("#broadcast");
  await page.waitForFunction(() => document.getElementById("sent-txid") || document.querySelector("#broadcast-result .bad, #broadcast-result [class*=bad]"), { timeout: LONG });
  const post = sent.at(-1);
  assert.equal(post?.status, 200, `${tag}: the server said ${post?.answer}`);
  const pageTxid = await page.$eval("#sent-txid", (e) => e.textContent);
  const disagrees = await page.evaluate(() => document.body.innerText.includes("different transaction id"));
  const bytesHash = createHash("sha256").update(Buffer.from(post.hex, "hex")).digest("hex").slice(0, signerHash.length);
  await scanDone(page);
  await page.click("#send-another");
  const state = await look(page);

  const rows = state.history.filter((h) => h.what.includes(shortId(pageTxid)));
  const row = rows[0];
  const shown = row ? toSats(row.amount) : null;
  const checks = {
    "the page's txid is the signed one": pageTxid === r.back.txid,
    "the server answers with it": pageTxid === post.answer && !disagrees,
    "the signer signed these bytes": bytesHash === signerHash,
    "history shows it once": rows.length === 1,
    "as the right kind, unconfirmed": row?.kind === kind && row.when.startsWith("unconfirmed"),
    "with its fee": kind === "self" ? shown === fee : shown === -(amount + fee),
    "the coins moved": Object.entries(after(inputs - amount - fee)).every(([p, v]) => state.coins.find((c) => c.path === p)?.sats === v) && state.coins.length === Object.keys(after(0)).length,
    "the change is at the next index": state.coins.find((c) => c.path === change)?.sats === inputs - amount - fee,
    ...(received ? { "the payment to itself is here": state.coins.find((c) => c.path === received)?.sats === amount } : {}),
  };
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  record(name, purpose, { verdict: failed.length ? "FAIL" : "PASS", failed, txid: pageTxid, fee, amount, inputs: coins, parts: built.codes.length, info: built.info, says: r.says, state, hex: post.hex });
  assert.deepEqual(failed, [], `${tag}: stopping before the next broadcast`);
  return pageTxid;
}

async function statusOf(txid) {
  net.generation++;
  return JSON.parse((await read(`/tx/${txid}/status`)).body);
}
async function waitUntil(what, test) {
  const end = Date.now() + CONFIRM_WAIT_MS;
  for (;;) {
    const got = await test();
    if (got) return got;
    assert.ok(Date.now() < end, `gave up waiting for ${what}`);
    console.log(`${new Date().toISOString()} waiting for ${what}`);
    await sleep(POLL_MS);
  }
}

// --- the spends ------------------------------------------------------------

const a84 = await openAccount(DESCRIPTORS[84], null, GAP);
const stale = await openAccount(DESCRIPTORS[84], null, GAP); // keeps today's scan: it will be behind
const a49 = await openAccount(DESCRIPTORS[49], null, GAP);
const start84 = await look(a84.page);
holdsCoins(start84, { "0/0": 10000, "0/1": 5000, "0/2": 4000 }, "84h at the start");
holdsCoins(await look(a49.page), { "0/0": 5100, "0/1": 4100 }, "49h at the start");
await look(stale.page);

// Signed now, sent once the coin it spends has confirmed in another transaction
const conflict = await (async () => {
  const review = await buildRow(stale.page, { coins: ["0/1"], amount: "0.00002000" });
  const r = await signAndReadBack(stale.page, "84-conflict", await oneCode(stale.page), 1);
  assert.ok(fine(r, review) && r.back.broadcast === "on", "the conflicting spend isn't ready");
  return r;
})();

// The next receive addresses, as the Receive tab gives them
const receiveAt = async (page, purpose, i) => {
  await page.click("#tab-receive");
  await page.waitForSelector("#receive-address");
  const shown = await page.$eval("#receive-address", (e) => e.textContent);
  assert.equal(shown, own(purpose, i));
  await page.click("#tab-send");
  await page.waitForSelector("#address");
  return shown;
};

const t1 = await spend({ name: "Base43, to itself", purpose: 84, page: a84.page, coins: ["0/1"], inputs: 5000, amount: 2000,
  to: await receiveAt(a84.page, 84, 3), kind: "self", change: "1/0", received: "0/3",
  after: (c) => ({ "0/0": 10000, "0/2": 4000, "0/3": 2000, "1/0": c }) });
const change84 = (await look(a84.page)).coins.find((c) => c.path === "1/0").sats;
const t2 = await spend({ name: "series, next change index", purpose: 84, page: a84.page, coins: ["0/0", "0/2"], inputs: 14000, amount: 3000,
  to: PAYEE, series: true, kind: "out", change: "1/1",
  after: (c) => ({ "0/3": 2000, "1/0": change84, "1/1": c }) });
const t3 = await spend({ name: "Base43", purpose: 49, page: a49.page, coins: ["0/0"], inputs: 5100, amount: 2000,
  to: PAYEE, kind: "out", change: "1/0",
  after: (c) => ({ "0/1": 4100, "1/0": c }) });
const change49 = (await look(a49.page)).coins.find((c) => c.path === "1/0").sats;
const t4 = await spend({ name: "series, to itself, next change index, spending unconfirmed change", purpose: 49, page: a49.page, coins: ["0/1", "1/0"], inputs: 4100 + change49, amount: 3000,
  to: await receiveAt(a49.page, 49, 2), series: true, kind: "self", change: "1/1", received: "0/2",
  after: (c) => ({ "0/2": 3000, "1/1": c }) });

// --- confirmations ---------------------------------------------------------

const confOf = (state, txid) => {
  const row = state.history.find((h) => h.what.includes(shortId(txid)));
  return Number(/(\d+) conf/.exec(row?.when ?? "")?.[1] ?? 0);
};
await waitUntil("the four to confirm", async () => {
  for (const t of [t1, t2, t3, t4]) if (!(await statusOf(t)).confirmed) return false;
  return true;
});
const first = await rescan(a84.page);
const height = (await statusOf(t1)).block_height;
await waitUntil("another block", async () => {
  net.generation++;
  return Number((await read("/blocks/tip/height")).body) > height + confOf(first, t1) - 1;
});
const second = await rescan(a84.page);
const last49 = await rescan(a49.page);
const counts = [confOf(first, t1), confOf(second, t1)];
record("confirmations count up", 84, { verdict: counts[0] >= 1 && counts[1] > counts[0] ? "PASS" : "FAIL", counts, state: second });
record("confirmed", 49, { verdict: confOf(last49, t3) >= 1 && confOf(last49, t4) >= 1 && !last49.unconfirmed ? "PASS" : "FAIL", state: last49 });

// --- a broadcast refused ---------------------------------------------------

net.posts = 1;
const before = sent.length;
await stale.page.click("#broadcast");
await stale.page.waitForFunction(() => document.getElementById("broadcast-result")?.innerText.includes("hasn't been retried") || document.getElementById("sent-txid"), { timeout: LONG });
const said = await stale.page.$eval("#broadcast-result", (e) => e.innerText).catch(() => "");
await sleep(15000); // nothing more goes out
const post = sent.at(-1);
const again = await stale.page.$eval("#broadcast", (e) => !e.disabled).catch(() => false);
record("broadcast refused: the same coin again", 84, { verdict: sent.length === before + 1 && post.status !== 200 && said.includes("refused") && said.includes(post.answer.slice(0, 40)) && again ? "PASS" : "FAIL",
  status: post.status, server: post.answer, page: said, posts: sent.length - before, conflict: conflict.back.txid });

await browser.close();
server.close();
proxy.close();
for (const f of readdirSync(OUT)) if (f.endsWith(".json")) nothingSecret(readFileSync(`${OUT}/${f}`, "utf8"), f);
console.log(`upstream: ${upstream.reads} reads, ${upstream.cached} answered without one; ${sent.length} POSTs. Output in ${OUT}`);
// The page's own POSTs are noted too, with their full address; a refused one has only its path
assert.deepEqual(posts.filter((p) => !p.startsWith("http")), [], "a POST that wasn't allowed");
assert.equal(posts.length, sent.length, "the page's POSTs and the ones sent");
