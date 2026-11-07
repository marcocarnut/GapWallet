# E1 results

Passing cases one line each (`docs/E1.md`, "Results"). The key in these runs is
BIP-39's public test phrase, and nothing went on a network.

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
