# Contributing to GapWallet

Thank you for helping. Start with [README.md](README.md) to build, run and test
it, and [docs/ESPLORA.md](docs/ESPLORA.md) for how it talks to servers, scans,
picks coins and builds PSBTs. The signer is
[GapKeep](https://github.com/marcocarnut/GapKeep)'s.

Security problems: not in a public issue, please; see [SECURITY.md](SECURITY.md).

## The rules

- **Run the tests:** `npm test`, with the GapKeep repository next to this one
  (or `GAPKEEP_DIR`). PSBTs are signed by the real signer's library there, not
  a second one written here.
- **Rebuild the page:** `node tools/build.mjs`, and commit `gapwallet.html`
  with the change; `npm test` fails if it is out of date.
- **No private keys, ever.** GapWallet holds public keys only. Never log or
  store a seed, a private key or a share, not even in a test: tests use public
  test vectors, and live tests take a test wallet's words from the
  environment.
- **No new requests without saying so.** Every request the page makes is in
  `docs/ESPLORA.md`; a new one goes there first. Nothing is fetched from
  anywhere but the servers the person chose: no CDNs, fonts or analytics.
- **Be kind to public servers.** Tests use a stub or recorded answers. Don't
  run load or rate-limit tests against public servers.
- **Every visible text in both languages:** wrap it in `tr()` and add its
  pt-BR text to `src/lang-pt-BR.js`; `tests/i18n.test.mjs` checks.
- **Vendored code is never edited by hand.** `vendor/` is fetched by
  `tools/vendor.py` from pinned sources and checked against
  `vendor/MANIFEST.json`.
- New files carry `SPDX-License-Identifier: GPL-3.0-or-later` in their
  header comment. Contributions are under GPL-3.0-or-later
  ([LICENSE](LICENSE)).
