// E1, part 1, the test wallet's rows (docs/E1.md), through harness.mjs. Reads only:
// the script fails if the page tries to POST. Not part of npm test.
//
//   E1_WORDS="..." node --experimental-default-type=module tests/e1/rows.mjs [out-dir] [row ...]
//
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { parseXpub, serializeXpub } from "../../vendor/gapkeep/bip32.js";
import { DESCRIPTORS } from "./wallet.mjs";
import { BUILT, OUT, WRONG_FINGERPRINT, attempt, browser, buildRow, fine, loadWif, loadWords, master, nothingSecret, oneCode, openAccount, pageFee, posts, proxy, read, readBack, readShot, record, results, s, seriesCodes, server, showCodes, signAndReadBack, signAndShow, signerSays, sim, upstream, wifAt } from "./harness.mjs";

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
