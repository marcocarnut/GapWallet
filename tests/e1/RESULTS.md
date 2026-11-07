# E1 results

Passing cases one line each (`docs/E1.md`, "Results"). The key in these runs is
BIP-39's public test phrase, and nothing went on a network.

## Part 1, the attacks

2026-11-07 00:03 -03. GapWallet d1f523e plus `tests/e1/attacks.mjs`, signer zerogap 13f3bc8,
in the simulator at its default 640x480, PSBTs read by its synthetic camera as
Base43. Each case was run on both accounts, `84h/1h/0h` and `49h/1h/0h`:
18 cases, 0 failed. Two inputs (60000 and 70000 sat), 100000 sat paid.

| Edit | What the signer did |
| --- | --- |
| None (the control) | Change checked, both inputs signed; the transaction's SHA-256 is the one signed in Node, whose txid is the wallet's. |
| Change script and key swapped, path unchanged | Red, 1 refuted, change counted as sent, "Sign anyway" asked with "Don't sign" focused. |
| Change script swapped, key and path still claiming ours | The same, with two red warnings. |
| Change at index 500000 | Amber with the path, 1 stray, counted as sent. |
| Change in account 7 | The same. |
| Change at index 1002, inputs at 0 and 1 | The same: one past the limit. |
| Change at index 1001 | Green, change checked, no warning: the limit. See below. |
| `PSBT_IN_WITNESS_UTXO` lowered on both inputs | Red on each, 0 to sign, the sign button disabled. The fee shown is the true one. |
| The same on one input | Red, 1 to sign. Told "Sign anyway", it signed only the honest input, leaving a partly signed PSBT. Which input is from the same edit signed in Node. |

Colours and the dialog were checked by eye on `84h`'s screenshots. The rest comes
from the signer's log, compared by the script.

### Not a failure, but not resolved

The signer calls change at home up to 1000 past the inputs' highest index
(`CHANGE_GAP`), but a wallet sees only what its scan reaches. So a hostile
computer can move change to an index the signer shows in green, as "back to your
wallet", and the wallet doesn't show it:

| Change at index, nothing used before it | Seen at gap 20 (default) | Seen at gap 1000 (the page's maximum) | Signer, inputs at 0 and 1 |
| --- | --- | --- | --- |
| 19 | yes | yes | green |
| 20 to 999 | no | yes | green |
| 1000, 1001 | no | no | green |

The scans at 999, 1000 and 1001 were run against the stub at gap 1000. The gap 20
column follows from the same rule, and index 1001 is the row above. The coins
aren't lost, as their keys are the wallet's, but finding them means guessing to
raise the gap, or past 999 can't be done in the page at all.
