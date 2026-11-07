// E1, part 1, the test wallet's rows (docs/E1.md): the real page on signet, the
// real signer app in zerogap's simulator, and only QR codes between them. A code
// is read off the page's canvas into the simulator's synthetic camera; the answer
// is read off a screenshot of the simulator and pasted into the page.
//
//   E1_WORDS="..." node --experimental-default-type=module tests/e1/rows.mjs [out-dir] [row ...]
//
// Reads: a run makes many scans of the same addresses, and repeating them against
// the public signet server gets this machine a 429. So the page talks to a proxy
// here, which asks the server once for each distinct read, at most one every
// UPSTREAM_GAP_MS, keeps the answer in tests/e1/.cache and serves it from there.
// Delete that folder to read afresh. The proxy refuses anything but GET, so nothing
// can be broadcast, and the script fails if the page tries. Not part of npm test.
//
// The words come only from the environment. They reach the simulator through a
// pipe, so no scenario holding them is ever on disk, the simulator's environment
// doesn't have them, and the script fails if they turn up in anything it kept.
//
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { ZEROGAP, loadSigner } from "../helpers.mjs";
import { decodeFrame } from "../../src/qr.js";
import { base58CheckEncode } from "../../vendor/zerogap/psbt/basen.js";
import { serializeXpub, parseXpub } from "../../vendor/zerogap/bip32.js";
import { DESCRIPTORS, FINGERPRINT, SERVER } from "./wallet.mjs";

const WORDS = process.env.E1_WORDS;
assert.ok(WORDS, "E1_WORDS is not set");
delete process.env.E1_WORDS;

const OUT = process.argv[2] || mkdtempSync(join(tmpdir(), "gapwallet-e1-"));
const ONLY = process.argv.slice(3);
const CHROME = ["/usr/bin/chromium", "/usr/bin/google-chrome"].find(existsSync);
const PAYEE = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";
const WRONG_FINGERPRINT = "deadbeef";

const s = await loadSigner();
const master = s.bip32.fromSeed(s.bip39.seedFromMnemonic(WORDS, ""));
assert.equal(s.bip32.fingerprintHex(master), FINGERPRINT, "E1_WORDS isn't the test wallet's");
const wifAt = (path) => base58CheckEncode(Uint8Array.of(0xef, ...s.bip32.derive(master, path).privateKey, 1));
const SECRETS = [WORDS, ...["84'", "49'"].flatMap((p) => [0, 1].map((i) => wifAt(`m/${p}/1'/0'/0/${i}`)))];

mkdirSync(OUT, { recursive: true });
const card = mkdtempSync(join(tmpdir(), "gapwallet-card-"));
process.on("exit", () => rmSync(card, { recursive: true, force: true }));
mkdirSync(join(card, "apps"));
for (const a of readdirSync(join(ZEROGAP, "apps"))) {
  if (a !== "launcher") cpSync(join(ZEROGAP, "apps", a), join(card, "apps", a), { recursive: true });
}

// --- the signer ------------------------------------------------------------

const BOOT = ["expect Keyboard attached 60", "expect launcher ready 60", "tile signer", "expect signer ready 10",
  "expect signer selftest: 4 passed, 0 failed 30", "wait 0.5"];
const nothingSecret = (text, where) => {
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `a secret in ${where}`);
};

function sim(name, lines) {
  const dir = join(OUT, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir);
  // cat: Node's stdin is a socket, which /dev/stdin can't open
  const run = spawnSync("sh", ["-c", 'cat | python3 tools/qemu_harness.py --sim sim/build/zgsim --card "$1" --out "$2" /dev/stdin', "sh", card, dir],
    { cwd: ZEROGAP, encoding: "utf8", maxBuffer: 1 << 28, input: `${[...BOOT, ...lines].join("\n")}\n` });
  const log = run.stdout + run.stderr;
  nothingSecret(log, "the simulator's output");
  if (existsSync(join(dir, "serial.log"))) nothingSecret(readFileSync(join(dir, "serial.log"), "utf8"), "the serial log");
  writeFileSync(join(dir, "run.log"), log);
  return { ok: run.status === 0, log, dir, lines: log.split("\n").filter((l) => l.includes("app:signer: signer: ")).map((l) => l.replace(/^.*?app:signer: signer: /, "")) };
}

const showCodes = (codes) => {
  const lines = ["mark", "key ret", "wait 0.3", "mark"];
  codes.forEach((c, i) => {
    lines.push(`camera qr ${c}`);
    lines.push(i === codes.length - 1 ? "expect signer: change: 20" : `expect signer: BBQr part: ${i + 1} of ${codes.length} 20`, ...(i === codes.length - 1 ? [] : ["mark"]));
  });
  lines.push("camera scene", "wait 0.5", "shot 01-claimed");
  return lines;
};
const loadWords = ["key ret", "wait 0.3", "key tab", "key ret", "wait 0.3", `type ${WORDS}`, "wait 0.3", "key tab", "mark", "key ret",
  "expect signer: key loaded \\(seed words\\) 15", "wait 0.5", "mark", "key ret", "expect signer: change: 5", "wait 0.5", "shot 02-keys"];
const loadWif = (wif) => ["key ret", "wait 0.3", "key tab", "key tab", "key ret", "wait 0.3", `type ${wif}`, "mark", "key ret",
  "expect signer: key loaded \\(wif\\) 15", "wait 0.5", "mark", "key ret", "expect signer: change: 5", "wait 0.5", "shot 02-keys"];
const signAndShow = (n) => ["mark", "key ret", `expect signer: signed ${n} inputs? 30`, "wait 0.8", "shot 03-signed"];

// A screenshot's QR code: through the page's own decoder, enlarged, as the
// simulator draws modules a few pixels wide; zbarimg as a second opinion.
function readShot(file) {
  const raw = execFileSync("python3", ["-c", `import sys
from PIL import Image
i = Image.open(sys.argv[1]).convert("RGBA")
i = i.resize((i.width * 3, i.height * 3), Image.NEAREST)
sys.stdout.buffer.write(i.width.to_bytes(4, "big") + i.height.to_bytes(4, "big") + i.tobytes())`, file], { maxBuffer: 1 << 28 });
  const w = raw.readUInt32BE(0), h = raw.readUInt32BE(4);
  const got = decodeFrame(new Uint8ClampedArray(raw.subarray(8)), w, h);
  if (got) return { text: got.text, by: "decodeFrame" };
  try {
    const text = execFileSync("zbarimg", ["-q", "--raw", file], { encoding: "utf8" }).trim();
    if (text) return { text, by: "zbarimg" };
  } catch { /* nothing found */ }
  return null;
}

// --- the page --------------------------------------------------------------

const posts = [];
const html = readFileSync(new URL("../../gapwallet.html", import.meta.url), "utf8");
const server = createServer((q, r) => {
  r.writeHead(200, { "Content-Type": "text/html" });
  r.end(html);
});
await new Promise((d) => server.listen(0, "127.0.0.1", d));
// --- the server, once ------------------------------------------------------

const UPSTREAM_GAP_MS = 2000;
const CACHE = new URL("./.cache/", import.meta.url).pathname;
mkdirSync(CACHE, { recursive: true });
const upstream = { reads: 0, cached: 0, turn: Promise.resolve() };
async function read(path) {
  const file = join(CACHE, createHash("sha256").update(path).digest("hex"));
  if (existsSync(file)) {
    upstream.cached++;
    return JSON.parse(readFileSync(file, "utf8"));
  }
  const mine = upstream.turn.then(async () => {
    if (existsSync(file)) return;
    await new Promise((d) => setTimeout(d, UPSTREAM_GAP_MS));
    upstream.reads++;
    const r = await fetch(SERVER + path);
    if (r.status === 429) throw new Error(`the server answered 429 at read ${upstream.reads}, ${new Date().toISOString()}`);
    const body = await r.text();
    if (r.status === 200) writeFileSync(file, JSON.stringify({ status: r.status, type: r.headers.get("content-type"), body }));
    return { status: r.status, type: r.headers.get("content-type"), body };
  });
  upstream.turn = mine.catch(() => {});
  return (await mine) ?? JSON.parse(readFileSync(file, "utf8"));
}
let limited = null;
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type" };
const proxy = createServer(async (q, r) => {
  if (q.method === "OPTIONS") {
    r.writeHead(204, CORS);
    r.end();
    return;
  }
  if (q.method !== "GET") {
    posts.push(q.url);
    r.writeHead(405, CORS);
    r.end("reads only");
    return;
  }
  try {
    const a = await read(q.url.replace(/^\/api/, ""));
    r.writeHead(a.status, { ...CORS, "Content-Type": a.type || "text/plain" });
    r.end(a.body);
  } catch (e) {
    limited = e.message; // stop at once: more requests would only make it worse
    console.log(limited);
    process.exit(3);
  }
});
await new Promise((d) => proxy.listen(0, "127.0.0.1", d));
const PROXY = `http://127.0.0.1:${proxy.address().port}/api`;

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });

const LONG = 180000;
const hasText = (page, needle, timeout = 15000) => page.waitForFunction((n) => document.body.innerText.includes(n), { timeout }, needle);

async function openAccount(key, fingerprint) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.setDefaultTimeout(LONG);
  page.on("request", (r) => { if (r.method() === "POST") posts.push(r.url()); });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.click("input[value=signet]");
  await page.type("#key", key);
  if (fingerprint) await page.type("#fingerprint", fingerprint);
  await page.waitForFunction(() => !document.getElementById("add").disabled);
  await Promise.all([page.waitForNavigation(), page.click("#add")]);
  await page.type("#server", PROXY);
  await Promise.all([page.waitForNavigation(), page.click("#use-server")]);
  await page.waitForSelector("#balance");
  await page.click("#tab-send");
  await page.waitForSelector("#address");
  await new Promise((d) => setTimeout(d, 3000)); // the estimates, which would fill an empty rate
  return { page, ctx };
}

const setValue = (page, sel, value) => page.$eval(sel, (e, v) => {
  e.value = v;
  e.dispatchEvent(new Event("input", { bubbles: true }));
}, value);

async function backToForm(page) {
  for (let i = 0; i < 5 && !(await page.$("#address")); i++) {
    await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent === "Back").click());
  }
  await page.waitForSelector("#address");
}

async function buildRow(page, { coins, amount, all }) {
  await backToForm(page);
  await setValue(page, "#address", PAYEE);
  await page.$eval("details", (e) => { e.open = true; });
  await page.$$eval("#coins input[type=checkbox]", (boxes) => boxes.forEach((b) => { if (b.checked) b.click(); }));
  if (coins) {
    await page.$$eval("#coins tr", (rows, wanted) => rows.forEach((r) => {
      if (wanted.includes(r.children[1].textContent.trim())) r.querySelector("input").click();
    }), coins);
  }
  const allNow = await page.$eval("#send-all", (e) => e.checked);
  if (allNow !== Boolean(all)) await page.click("#send-all");
  if (!all) await setValue(page, "#amount", amount);
  await setValue(page, "#rate", "1");
  // Review fetches each coin's previous transaction: a failure shows on the form,
  // and the page lets the user press Review again, as this does
  for (let tries = 1; ; tries++) {
    await page.click("#review");
    await page.waitForFunction(() => document.getElementById("to-sign") || document.getElementById("send-error")?.textContent, { timeout: LONG });
    if (await page.$("#to-sign")) break;
    const said = await page.$eval("#send-error", (e) => e.textContent);
    console.log(`   the form said, try ${tries}, ${new Date().toISOString()}: ${said}`);
    if (tries === 4) throw new Error(`Review refused: ${said}`);
    await new Promise((d) => setTimeout(d, 20000));
  }
  const review = await page.$eval("#review-fee", (e) => e.closest("div").innerText);
  if (await page.$("#ack-fee")) await page.click("#ack-fee");
  await page.click("#to-sign");
  await page.waitForSelector("#psbt-size");
  if (await page.$("#format-base43:not(:disabled)")) await page.click("#format-base43"); // the page keeps the last choice
  return review;
}

const canvasFrame = (page, sel) => page.$eval(sel, (c) => ({ part: c.dataset.part, w: c.width, h: c.height,
  data: Array.from(c.getContext("2d").getImageData(0, 0, c.width, c.height).data) }));

async function oneCode(page) {
  const f = await canvasFrame(page, "#psbt-qr");
  const got = decodeFrame(Uint8ClampedArray.from(f.data), f.w, f.h);
  assert.ok(got, "the page's code reads");
  return [got.text];
}

async function seriesCodes(page, size) {
  await page.click("#format-bbqr");
  await page.waitForSelector("#series-qr");
  const offered = await page.$$eval("#series-size option", (o) => o.map((x) => Number(x.value)));
  const use = offered.filter((n) => n <= size).at(-1);
  await page.select("#series-size", String(use));
  await new Promise((d) => setTimeout(d, 300));
  await page.waitForSelector("#series-qr");
  const info = await page.$eval("#qr-info", (e) => e.textContent);
  const total = Number(/: (\d+) code/.exec(info)[1]);
  const parts = new Map();
  for (let i = 0; i < 400 && parts.size < total; i++) {
    const f = await canvasFrame(page, "#series-qr");
    const got = decodeFrame(Uint8ClampedArray.from(f.data), f.w, f.h);
    if (got) parts.set(f.part, got.text);
    await new Promise((d) => setTimeout(d, 120));
  }
  assert.equal(parts.size, total);
  return { codes: [...parts.keys()].sort((a, b) => a - b).map((k) => parts.get(k)).reverse(), info, offered };
}

async function readBack(page, text) {
  if (!(await page.$("#signed"))) await page.click("#to-scan");
  await page.waitForSelector("#signed");
  await setValue(page, "#signed", text);
  await page.click("#read-pasted");
  await new Promise((d) => setTimeout(d, 400));
  return page.evaluate(() => ({ result: document.getElementById("scan-result")?.innerText ?? "",
    txid: document.getElementById("signed-txid")?.textContent ?? null,
    broadcast: document.getElementById("broadcast") ? (document.getElementById("broadcast").disabled ? "off" : "on") : "absent" }));
}

// --- the rows --------------------------------------------------------------

const results = [];
function record(row, purpose, fields) {
  results.push({ row, purpose, ...fields });
  console.log(`\n== ${row}, ${purpose}h: ${fields.verdict}`);
  for (const [k, v] of Object.entries(fields)) if (k !== "verdict") console.log(`   ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  writeFileSync(join(OUT, "results.json"), `${JSON.stringify(results, null, 1)}\n`);
}
async function attempt(name, purpose, row) {
  if (ONLY.length && !ONLY.includes(name)) return;
  try {
    await row();
  } catch (e) {
    if (e instanceof assert.AssertionError && /a secret|E1_WORDS/.test(e.message)) throw e;
    record(name, purpose, { verdict: "ERROR", message: e.message });
  }
}
const signerSays = (run, re) => run.lines.filter((l) => re.test(l));

// Sign and read back: what most rows share.
async function signAndReadBack(page, name, codes, n, load = loadWords) {
  const run = sim(name, [...showCodes(codes), ...load, ...signAndShow(n)]);
  const read = readShot(join(run.dir, "03-signed.png"));
  const back = read ? await readBack(page, read.text) : null;
  return { run, read, back, says: signerSays(run, /^(read|review|totals|danger|warn|change|signed|showing)/) };
}

const BUILT = "This is the transaction built here, signed.";
const sats = (btc) => Math.round(Number(btc) * 1e8);
const pageFee = (review) => sats(/([\d.]+) BTC \(\d+ vB/.exec(review)[1]);
// The signer's own reading of the fee, after the keys, against the page's
const feesAgree = (review, says) => {
  const fees = says.filter((l) => l.startsWith("totals:")).map((l) => Number(/fee (\d+) sat/.exec(l)[1]));
  return fees.length > 0 && fees.every((f) => f === pageFee(review));
};
const fine = (r, review) => r.run.ok && r.back?.result.includes(BUILT) && feesAgree(review, r.says);

const PLANS = { // coins as the page lists them, chain/index
  84: { one: ["0/1"], oneAmount: "0.00002000", two: ["0/1", "0/2"], twoAmount: "0.00007000", dust: ["0/1"], dustAmount: "0.00004700" },
  49: { one: ["0/0"], oneAmount: "0.00002000", two: ["0/0", "0/1"], twoAmount: "0.00007000", dust: ["0/0"], dustAmount: "0.00004800" },
};

const signedSoFar = {};
for (const purpose of [84, 49]) {
  const plan = PLANS[purpose];
  const { page, ctx } = await openAccount(DESCRIPTORS[purpose]);
  const tag = (n) => `${purpose}-${n}`;

  await attempt("one", purpose, async () => {
    const review = await buildRow(page, { coins: plan.one, amount: plan.oneAmount });
    const codes = await oneCode(page);
    const r = await signAndReadBack(page, tag("one"), codes, 1);
    if (r.back) signedSoFar[purpose] = r.read.text;
    record("one input, change, Base43", purpose, { verdict: fine(r, review) ? "PASS" : "FAIL", review, chars: codes[0].length, shotReadBy: r.read?.by, says: r.says, back: r.back });
  });
  await attempt("two", purpose, async () => {
    const review = await buildRow(page, { coins: plan.two, amount: plan.twoAmount });
    const r = await signAndReadBack(page, tag("two"), await oneCode(page), 2);
    record("several inputs, chosen by hand", purpose, { verdict: fine(r, review) ? "PASS" : "FAIL", review, shotReadBy: r.read?.by, says: r.says, back: r.back });
  });
  await attempt("all", purpose, async () => {
    const review = await buildRow(page, { all: true });
    const codes = await oneCode(page);
    const n = purpose === 84 ? 3 : 2;
    const r = await signAndReadBack(page, tag("all"), codes, n);
    record("send everything", purpose, { verdict: fine(r, review) ? "PASS" : "FAIL", review, shotReadBy: r.read?.by, says: r.says, back: r.back });
    if (signedSoFar[purpose] && r.back) {
      const wrong = await readBack(page, signedSoFar[purpose]);
      const on = wrong.broadcast === "on";
      let ticked = null;
      if (await page.$("#ack-different")) {
        await page.click("#ack-different");
        ticked = await page.$eval("#broadcast", (e) => (e.disabled ? "off" : "on"));
        await page.click("#ack-different");
      }
      record("signed code from another transaction", purpose, { verdict: !on && wrong.result.includes("isn't the transaction built here") && ticked === "on" ? "PASS" : "FAIL", wrong, afterTick: ticked });
    }
  });
  await attempt("dust", purpose, async () => {
    const review = await buildRow(page, { coins: plan.dust, amount: plan.dustAmount });
    const r = await signAndReadBack(page, tag("dust"), await oneCode(page), 1);
    const dropped = Number(/(\d+) sat that would have been change/.exec(review)?.[1] ?? NaN);
    const vsize = Number(/\((\d+) vB/.exec(review)[1]); // at 1 sat/vB, its fee in sat
    record("change dropped as dust", purpose, { verdict: fine(r, review) && dropped !== null && pageFee(review) === vsize + dropped ? "PASS" : "FAIL", review, says: r.says, back: r.back });
  });
  await attempt("series", purpose, async () => {
    for (const size of [2, 8, 16]) {
      const review = await buildRow(page, { all: true });
      const { codes, info, offered } = await seriesCodes(page, size);
      const n = purpose === 84 ? 3 : 2;
      const r = await signAndReadBack(page, tag(`series${size}`), codes, n);
      record(`series, up to ${size} codes`, purpose, { verdict: fine(r, review) ? "PASS" : "FAIL", info, offered, parts: codes.length, shotReadBy: r.read?.by, says: r.says, back: r.back, review });
    }
  });
  await attempt("answer", purpose, async () => {
    // Every signed transaction here fits one code, so the signer's BBQr answer is
    // asked for: Done, Next transaction, Show as PSBT, Show as BBQr
    const review = await buildRow(page, { coins: plan.one, amount: plan.oneAmount });
    const stepping = Array.from({ length: 6 }, (_, i) => ["mark", "key ret", "expect signer: part \\d+ of \\d+, \\d+ modules 10", "wait 0.5", `shot 05-part-${i}`]).flat();
    const run = sim(tag("answer"), [...showCodes(await oneCode(page)), ...loadWords, ...signAndShow(1),
      "key tab", "key tab", "key tab", "mark", "key ret", "expect signer: showing the signed tx as BBQr 15", "wait 0.8",
      "key tab", "key tab", "key tab", "key ret", "wait 0.3", "key tab", ...stepping]); // Pause, then Next part
    const parts = new Set();
    let by = null;
    for (let i = 0; i < 6; i++) {
      const read = readShot(join(run.dir, `05-part-${i}.png`));
      if (read) {
        parts.add(read.text);
        by = read.by;
      }
    }
    const back = parts.size ? await readBack(page, [...parts].reverse().join("\n")) : null;
    const says = signerSays(run, /^(signed|showing)/);
    const total = Number(/, (\d+) parts?, version/.exec(says.find((l) => l.includes("as BBQr")) ?? "")?.[1]);
    record("the signer's answer as BBQr, on request", purpose, { verdict: run.ok && parts.size === total && [...parts].every((p) => p.startsWith("B$")) && back?.result.includes(BUILT) ? "PASS" : "FAIL", partsRead: parts.size, shotReadBy: by, says, back });
  });
  await attempt("partly", purpose, async () => {
    const review = await buildRow(page, { coins: ["0/0", "0/1"], amount: purpose === 84 ? "0.00012000" : "0.00007000" });
    const wif = wifAt(`m/${purpose}'/1'/0'/0/1`);
    const r = await signAndReadBack(page, tag("partly"), await oneCode(page), 1, loadWif(wif));
    record("partly signed PSBT back", purpose, { verdict: r.run.ok && /1 of 2 inputs signed/.test(r.back?.result ?? "") && r.back?.broadcast === "absent" ? "PASS" : "FAIL", review, shotReadBy: r.read?.by, says: r.says, back: r.back });
  });
  await ctx.close();

  await attempt("fingerprint", purpose, async () => {
    const { node } = parseXpub(/\]([a-zA-Z0-9]+)\//.exec(DESCRIPTORS[purpose])[1]);
    const key = serializeXpub(node, purpose === 84 ? "vpub" : "upub");
    const wrong = await openAccount(key, WRONG_FINGERPRINT);
    const review = await buildRow(wrong.page, { coins: plan.one, amount: plan.oneAmount });
    const codes = await oneCode(wrong.page);
    const run = sim(tag("fingerprint"), [...showCodes(codes), ...loadWords]);
    const says = signerSays(run, /^(read|review|totals|danger|warn|change|signed)/);
    // The reason is on the input's row, below the fold at 640x480: asked of the signer's
    // library, for this PSBT and this key
    const psbt = s.psbtLib.parsePsbt(s.transport.readPayload(codes[0], null).bytes);
    const reason = s.sign.plan(psbt, master, { network: "testnet" }).inputs[0].reason;
    record("wrong master fingerprint on import", purpose, { verdict: run.ok && says.some((l) => /^review: .*, 0 to sign/.test(l)) && /another wallet/.test(reason ?? "") ? "PASS" : "FAIL", reason, review, says });
    await wrong.ctx.close();
  });
}

await browser.close();
server.close();
proxy.close();
console.log(`upstream: ${upstream.reads} reads, ${upstream.cached} answered from the cache`);
for (const f of readdirSync(OUT)) if (f.endsWith(".json")) nothingSecret(readFileSync(join(OUT, f), "utf8"), f);
assert.deepEqual(posts, [], "the page made a POST");
console.log(`\n${results.filter((r) => r.verdict === "PASS").length} of ${results.length} PASS; 0 POSTs. Output in ${OUT}`);
