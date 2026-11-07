# E1 results

Passing cases one line each (`docs/E1.md`, "Results"). Nothing here has been
broadcast. The attacks use BIP-39's public test phrase and no network; the wallet
rows use the E1 test wallet, whose words are in no file.

## Part 1, the attacks

2026-11-07 07:40 -03. GapWallet e1-wallet (on 0e4ee8f) with `tests/e1/attacks.mjs`, signer zerogap
f1973eb, in the simulator at its default 640x480, PSBTs read by its synthetic
camera as Base43. Each case was run on both accounts, `84h/1h/0h` and `49h/1h/0h`:
22 cases, 0 failed. Two inputs (60000 and 70000 sat, at indexes 0 and 1, so "top"
is 1), 100000 sat paid.

| Edit | What the signer did |
| --- | --- |
| None (the control) | Change checked, both inputs signed; the transaction's SHA-256 is the one signed in Node, whose txid is the wallet's. |
| Change script and key swapped, path unchanged | Red, 1 refuted, change counted as sent, "Sign anyway" asked with "Don't sign" focused. |
| Change script swapped, key and path still claiming ours | The same, with two red warnings. |
| Change at index 500000 | Amber with the path, 1 stray, counted as sent. |
| Change in account 7 | The same. |
| Change at index 21 (top + 20) | Green, no note: the last at home. |
| Change at index 22 (top + 21) | Amber note giving the index, 1 far, still counted as change. |
| Change at index 1001 (top + 1000) | The same: the last far. |
| Change at index 1002 (top + 1001) | Amber with the path, 1 stray, counted as sent: the first past the limit. |
| `PSBT_IN_WITNESS_UTXO` lowered on both inputs | Red on each, 0 to sign, the sign button disabled. The fee shown is the true one. |
| The same on one input | Red, 1 to sign. Told "Sign anyway", it signed 1 input. That it is the honest one is from the same edit signed in Node: the partly signed PSBT wasn't decoded off the screen. |

Colours and the dialog were checked by eye on `84h`'s screenshots from the first
run (13f3bc8), and the far note's on index 22 from this one. The rest comes from
the signer's log, compared by the script.

The first run (13f3bc8, 18 cases) showed the signer green up to 1000 past the
inputs, beyond what a wallet's scan reaches: GapWallet at its maximum gap of 1000
doesn't show a coin at index 1000 or above with nothing used before it. S3b's far
note is the answer: the signer can't know how far a wallet scans, so it says so at
the moment of signing. The wallet's maximum gap stays at 1000, so a coin the signer
called far at index 1000 or 1001 is still out of the page's reach in that case.

## Part 1, the test wallet

Final pass, finished 2026-11-07 08:02 -03. GapWallet e1-wallet (on 47fd94d), `gapwallet.html`
unchanged from main, signer zerogap f1973eb, simulator at 640x480. `tests/e1/rows.mjs`
drives the real page in Chromium; each code is read off its canvas into the
simulator's synthetic camera, and the signer's answer off a screenshot, then pasted
into the page. No physical camera. 22 cases, 0 failed, 0 POSTs. The fingerprint row's
reason was added after the pass and rerun from the cache, on the same commit.

Coins, all at signet height 329784: `84h` 0/0 10000, 0/1 5000, 0/2 4000 sat; `49h` 0/0
5100, 0/1 4100 sat. `49h` 0/2 got none: the faucet's limit. All unspent. Rate 1 sat/vB.

Every row ran on both accounts, and where a transaction was signed, the page's fee
equals the signer's, before and after the keys.

| Case | Result |
| --- | --- |
| One input, change, Base43 | Amber "Claimed change (not checked yet)" before the keys, green "Change back to your wallet" after. "This is the transaction built here, signed." |
| Several inputs, by hand | 2 inputs, key signs 2. Built here. |
| Send everything | No change output, nothing claimed. 3 inputs on `84h`, 2 on `49h`. Built here. |
| Change dropped as dust | 300 sat fee on both: the transaction's vsize plus the sat the page's note says went to the fee (190 on `84h`, 167 on `49h`). |
| Series, up to 2, 8 and 16 codes | Read by the signer in reverse order. `84h`: 2 at version 12, 8 at 5, 8 at 5. `49h`: 2 at 11, 6 at 5, 6 at 5. The signed answer fit one code, as Base43. |
| The signer's answer as BBQr, on request | 3 parts at version 5, Z on `84h`, base32 on `49h` (compression didn't shrink it). All read off screenshots, joined by the page: built here. |
| Signed code from another transaction | "This isn't the transaction built here", broadcast off until the explicit tick. |
| Partly signed PSBT back (a WIF key for one of two inputs) | "1 of 2 inputs signed", no broadcast offered. The change, which that key can't check, counted as sent. |
| Wrong master fingerprint on import | Sign disabled, "key 7d8108a9 signs 0", change counted as sent, input refused: "its key is from another wallet (fingerprint deadbeef; this wallet is 7d8108a9)". |

Needs funding: a series of 15 codes. These coins give at most 8 (`84h`, 3 inputs), as
"up to 16" shows; it takes more inputs. zerogap's own suite reads 14 and 17 parts
through its Joiner and a 30-input series in, but that isn't this page. Likewise the
signer's answer needing a series: here it was asked for by the button.

Seen on the way, nothing wrong:
- The wrong fingerprint's reason is on the input's row, below the fold at 640x480: what
  shows first is "signs 0" and the note about change. The reason in the table was asked
  of the signer's library for that PSBT, and read in its source to be what the row shows.
- The signer's BBQr answer for a 222-byte transaction is 3 codes at version 5.

Earlier passes that day, commit unknown (lvglzero moved during them), aren't evidence.
They also got this machine a 429 from blockstream.info: about five full passes in half
an hour, each rescanning. That's why the script now reads through a cache: the final
pass made 103 reads, one every 2 s, and no 429.
