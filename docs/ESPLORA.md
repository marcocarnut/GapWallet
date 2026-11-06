# W0: the Esplora client

GapWallet is the online half of the zerogap pipeline (`docs/plans/BITCOIN.md`
in the zerogap repository). It holds public keys only: it watches an account,
builds PSBTs and broadcasts what the offline signer signed. This file says
how it talks to a server. It is written before the code; a later indexer needs
to serve exactly what is in "Endpoints", with the same shapes.

## Networks and servers

| Network | Coin type | Keys | Addresses | Genesis block |
| --- | --- | --- | --- | --- |
| mainnet | `0h` | zpub, ypub, xpub | `bc1…`, `3…` | `000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f` |
| signet | `1h` | vpub, upub, tpub | `tb1…`, `2…` | `00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6` |
| testnet4 | `1h` | vpub, upub, tpub | `tb1…`, `2…` | `00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043` |

- **No default server.** The page contacts nothing until the user has chosen a
  server for the account's network. mempool.space's addresses are offered as
  presets, each one a click the user makes, next to what the server will learn
  ("Privacy"):
  `https://mempool.space/api`, `https://mempool.space/signet/api`,
  `https://mempool.space/testnet4/api`. Any other Esplora URL can be typed.
- **The first request checks the network.** `GET /block-height/0` must give
  that network's genesis hash, or the server is refused. Signet and testnet4
  share their addresses and keys, so nothing else would tell them apart.
- **An import does not need the network.** A descriptor or zpub is parsed
  and its first address shown offline, so the user can compare it with the
  signer before anything is sent anywhere.

### Content-Security-Policy

The page is one HTML file with a `<meta>` policy:

- `default-src 'none'`; scripts only by the SHA-256 of the one inline script
  (the build computes it); no remote scripts, styles, images or frames.
- `connect-src` can't name a server the user will type later, and a static
  file can't change its own policy after the fact. It can narrow it: policies
  add up, and each one must allow a request. So:
  - the static policy says `connect-src https: http:` (your own server may
    well be plain HTTP on the local network);
  - at start, before any request, the page adds a second `<meta>` naming only
    the origin of the saved server;
  - changing the server saves it and reloads the page.

  With no server saved, the second policy is `connect-src 'none'`.

## Endpoints

All paths are below the server's base URL. Only these are used.

| Request | Used for | Answer used |
| --- | --- | --- |
| `GET /block-height/0` | the network check | text: the block hash |
| `GET /blocks/tip/height` | confirmations; the locktime | text: a number |
| `GET /address/:address` | the scan | `chain_stats` and `mempool_stats`, each `{ funded_txo_count, funded_txo_sum, spent_txo_count, spent_txo_sum, tx_count }` |
| `GET /address/:address/utxo` | the coins | `[{ txid, vout, value, status: { confirmed, block_height, block_time } }]` |
| `GET /address/:address/txs` | history | the unconfirmed ones and the 25 newest confirmed: `[{ txid, fee, status, vin: [{ txid, vout, prevout: { scriptpubkey_address, value } }], vout: [{ scriptpubkey_address, value }] }]` |
| `GET /address/:address/txs/chain/:last_txid` | history, older pages | the next 25 confirmed |
| `GET /tx/:txid/hex` | the previous transaction for a PSBT | text: the raw transaction |
| `GET /fee-estimates` | the fee suggestions | `{ "<blocks>": sat/vB, … }` |
| `POST /tx` | broadcast | body: raw hex as `text/plain`; answer: text, the txid |

Observed on mempool.space (2026-11-06), and to be kept in mind:

- every answer has `Access-Control-Allow-Origin: *`, so the page can call it
  from any origin, including `file://`;
- `/fee-estimates` answers **203**, not 200: any 2xx is a success;
- errors are text, not JSON: `400 Invalid Bitcoin address`;
- a refused broadcast is `400` with the node's error as text
  (`sendrawtransaction RPC error: {"code":-22,"message":"…"}`), shown to the
  user as it came.

### Requests

At most 4 at a time, each with a 20 s timeout, and paced: one request every
50 ms on a server on your own network (localhost, private addresses, `.local`,
`.lan`), and every 500 ms anywhere else, since a public server's limit has to
be assumed.

**mempool.space's limit can't be seen from a page.** Measured 2026-11-06:
about 20 requests in 3 seconds gets a `429` from its nginx, with no CORS header
and no `Retry-After`. Even 3 to 5 requests a second got some, and a run of
connection timeouts of about 10 s each; after the last of those bursts the
server stopped accepting connections from this machine for a while, while
blockstream.info still answered. (Probably a temporary block, not established:
a local tunnel was also flapping.) Going over costs far more than going
slowly. The browser hides an answer without that header, so the page sees a
failed `fetch`, the same as a dropped connection. So:

- any failure on a `GET` may be the limit. It holds *every* request back (1 s,
  doubling each time, up to 32 s, for up to 6 tries) and doubles the interval
  between requests, up to 4 s. 20 successes in a row bring the interval down by
  a quarter, back to the starting pace at the fastest. The page says when it is waiting;
- a `429` or `503` the page *can* see (a server with CORS on its errors) does
  the same, and `Retry-After` is honoured if there is one;
- when the tries run out, the error says the server can't be reached *or is
  limiting requests*, since the page can't tell which.

`POST /tx` is paced but **never** retried automatically: after a failure the
user decides, seeing the server's answer. (Sending the same transaction twice
is harmless, but a retry can hide what happened.)

A scan is only ever started by the user: on opening an account, the refresh
button, and after a broadcast. No timers: polling tells the server when the
page is open and strains a public server.

### What the server is not trusted with

A server can lie by omission or invent coins, so:

- addresses come from our own derivation, never from a server's answer;
- each coin's previous transaction is fetched for a PSBT, and its txid is
  computed here: it must be the coin's txid, and the output's script and
  amount must be what the server claimed and what we derived. A mismatch stops
  the build;
- the previous transaction goes in the PSBT, so the signer checks it too
  (without its witnesses: the txid doesn't cover them, and they cost QR space);
- broadcasting: the txid the server returns must be the one computed here.

What it can still do: hide coins or history, or show a false balance. That
costs the user visibility, not keys; the signer shows what is really spent.

## Scanning

Esplora has no xpub endpoint. The page derives addresses and asks about each.

- **Gap limit: 20**, configurable per account (1 to 1000). The scan stops
  on a chain after that many consecutive addresses with no history.
- For each chain (0 receive, 1 change), from index 0, in order:
  `GET /address/:address`. An address is *used* when
  `chain_stats.tx_count + mempool_stats.tx_count > 0`.
- For used addresses with funds (funded minus spent, confirmed plus
  mempool, above 0): `GET /address/:address/utxo`.
- For used addresses: `GET /address/:address/txs`, then older pages until
  the address's `tx_count` is reached or a page brings nothing new (page sizes
  differ between servers). Transactions are merged by txid.
- An empty account costs `2 × gap limit` requests: 40 at the default, 20 s or
  more on a public server. Each used address costs up to 2 more, plus its
  history pages.

**Balance:** confirmed coins; unconfirmed coins are shown on their own.
**History:** each transaction's effect on the account: amounts paid to our
addresses minus the amounts of our coins it spends, with its fee and its
confirmations. A transaction that spends coins from several addresses appears
once.

**Receive address:** the first index after the highest used one on chain 0,
with the next few listed. The wallet doesn't record which it has shown;
giving out more than the gap limit of them without any being paid can put a
payment past the scan. The page says so, and the gap limit can be raised.

## Building a transaction

### Fees

- `GET /fee-estimates`; shown for 1, 3, 6 and 144 blocks, plus a typed rate.
  The default is the 6-block estimate. If the server has no estimates, the
  user types a rate; nothing is guessed.
- Rates are sat/vB, from 0.1 up to 10000; a fee is rounded up to a whole
  satoshi.
- Size is computed from the weight, with a 72-byte signature: 42 WU overhead,
  272 WU per P2WPKH input, 364 per P2SH-P2WPKH input, `4 × (9 + script)` per
  output.
- **Warnings the user must acknowledge:** a fee above 5% of the amount sent,
  or a rate over 3 times the 1-block estimate. Rates outside the range above
  are refused.
- Transactions signal replacement (BIP-125): sequence `0xfffffffd`, version 2,
  locktime the tip's height.

### Coins

Selection is deterministic for the same coins, amount and rate.

- **Automatic:** only confirmed coins, and
  1. a single coin that pays the amount and fee with no change, within the
     fee of a change output;
  2. else the smallest single coin that covers it, with change;
  3. else the largest coins, one by one, until they cover it.
- **By hand:** the user ticks coins, confirmed or not, and exactly those are
  spent.
- **Send everything:** all the chosen coins, with no change; the amount is
  what remains after the fee.
- If the confirmed coins fall short, the error says how much is unconfirmed
  rather than spending it.
- Coins that cost more to spend than they hold at this rate are left out by
  the automatic rule, and the page says so.

### Change

- On chain 1, at the first index after the highest used one, which is always
  within the scan's reach and the signer's bound on change.
- Change below the dust limit (294 sat for a P2WPKH account, 540 for
  P2SH-P2WPKH) goes to the fee, and the page says how much.
- Outputs are placed in random order, and inputs too: a wallet that always
  puts change last gives it away.
- A payment below its address type's dust limit is refused: P2WPKH 294,
  P2SH 540, P2PKH 546, P2WSH and P2TR 330 sat.

### The PSBT

The contract is "PSBTs" in BITCOIN.md. Version 0, for P2WPKH and P2SH-P2WPKH
accounts (`sh(wpkh(…))`, purpose 49, ypub or upub):

- `PSBT_GLOBAL_UNSIGNED_TX`;
- each input: `PSBT_IN_NON_WITNESS_UTXO`, `PSBT_IN_WITNESS_UTXO`,
  `PSBT_IN_BIP32_DERIVATION`;
- the change output: `PSBT_OUT_BIP32_DERIVATION`;
- P2SH-P2WPKH also has `PSBT_IN_REDEEM_SCRIPT` on inputs and
  `PSBT_OUT_REDEEM_SCRIPT` on change;
- a derivation always holds the **master** fingerprint and the full path,
  `m/<purpose>'/<coin>'/<account>'/<chain>/<index>`. An account's own fingerprint is
  never written in its place.

A P2SH-P2WPKH txid covers the scriptSig, unlike native segwit's, so the signed
transaction's txid isn't the unsigned one's. The scriptSig is known in advance
(one push of the redeemScript), so the finished txid is computed when the
transaction is built, and a signed transaction with any other scriptSig
counts as a different transaction.

An account with no known master fingerprint is watch-only: balance and
history work, and the page refuses to build a PSBT. A descriptor carries the
fingerprint in its origin; a zpub import asks for it, and takes purpose
from the version, account from the child number (depth must be 3, the child
hardened), and coin type from the chosen network. A version that disagrees
with the network is refused.

**Size:** the previous transaction can make the PSBT too big for one code.
It then goes out as a BBQr series ("QR codes" below). zerogap's signer doesn't
read series yet (S2), so the page also offers to leave out
`PSBT_IN_NON_WITNESS_UTXO`, and says what that costs: the signer can no longer
prove the amounts of the coins, so a lying server could trick it into a fee
higher than it shows (the fee attack on segwit v0). It is the user's explicit
choice, each time; it is never dropped silently.

## QR codes

- **Out:** Electrum's Base43 in one code, by default, whenever it fits. Otherwise
  or by choice, a BBQr series: file type `P`, compressed (`Z`) unless that
  doesn't shrink it, every code the same QR version at error correction L.
  The page picks the fewest codes whose version is at most 12; the user can
  change the number of codes and the speed (500 ms per code to start with).
  Those defaults want tuning on the rig (B2).
- **In:** the camera or a paste: hex, Base64 or Base43 in one code, or BBQr of
  type `T` or `P`, one code or a series, in any order, each as often as it
  comes round. BBQr's text is also Base43's, so `B$…` is BBQr unless it reads
  as a transaction, as in the signer. A code from another series starts that
  one over; a damaged series is dropped, with a message, and read again.
- **Public keys** may also be read with the camera: a descriptor, zpub or ypub
  as plain text, or BBQr of type `U`. What a code holds appears on the screen
  only if it is a public key, in case a seed's code is shown by mistake.

## Privacy: what each server learns

Written here for the settings page, which says the same.

| Who | Learns |
| --- | --- |
| The Esplora server | **Every address of the account**, asked in a burst from one IP address and so linked together: the balance and whole history of the wallet, and when it is opened. Each transaction before anyone else sees it, and which IP sent it. Any addresses past the gap limit it is asked about, used or not. |
| Network observers | With HTTPS, that the page talks to that server, not what it asks. |
| The site serving the page | That the page was loaded. It is sent nothing else: no request goes to it. Better still, run the file from disk or your own server. |
| The camera | Stays in the browser: frames are decoded in the page and never sent. |

- mempool.space can link all of this to the IP address. Your own server,
  or a VPN or Tor, is what limits this.
- The server never sees the public key itself, only addresses, so it can't
  derive addresses it wasn't asked about.
- Stored in this browser (`localStorage`): settings, and each account's
  descriptor or zpub. Anyone with those sees the whole wallet, though they
  can't spend. "Forget this account" removes them. Balances and history are
  not stored; they are fetched again.
- Private keys are refused, not held: an xprv, zprv or similar pasted by
  mistake gets an error, and nothing is stored or sent.

## Tests

- **Deterministic, no network (`npm test`):** a stub Esplora in Node, serving
  fixtures recorded from mempool.space's signet and testnet4 (with the
  command that recorded them), plus cases built by hand: an empty account, the
  gap limit reached exactly, paged history, `429`, a server that lies about a
  coin (wrong amount, wrong script, wrong previous transaction), the wrong
  genesis block.
- **Vectors:** BIP-32, BIP-84, BIP-380 checksums, BIP-174's format; addresses
  against Bitcoin Core's and BIP-84's.
- **The real signer:** PSBTs from the wallet signed by the signer's library
  under Node, as `tests/signer/run_node.mjs` does (no second signer here):
  `plan` must find every input and call the change ours, and `finalize` gives
  the transaction the wallet then recognises as the one it built.
- **The page:** headless Chromium against the stub: first run, import,
  scan, build, a signed code through a fake camera feed, broadcast; and a check
  that the page makes no request except to the chosen server.
- **By hand, end to end (E1):** on signet or testnet4 through mempool.space,
  with the signer in the simulator. No regtest for now: it needs bitcoind on
  this machine, which is the user's call.
