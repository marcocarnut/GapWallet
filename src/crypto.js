// The cryptography the vendored zerogap libraries ask for (vendor/zerogap/
// crypto.js), from the noble libraries.
//
// GapWallet holds no private keys, so it has no use for private-key
// operations. setCrypto() insists on all of them being there; here each one
// throws, so nothing can quietly sign or derive a private key in this page.
//
// SPDX-License-Identifier: GPL-3.0-or-later
import { sha256, sha512 } from "../vendor/noble-hashes/sha2.js";
import { ripemd160 } from "../vendor/noble-hashes/legacy.js";
import { hmac as nobleHmac } from "../vendor/noble-hashes/hmac.js";
import { Point } from "../vendor/noble-secp256k1/index.js";
import { setCrypto, NEEDED } from "../vendor/zerogap/crypto.js";

const bigint = (bytes) => bytes.reduce((v, b) => (v << 8n) | BigInt(b), 0n);

function isPublicKey(key) {
  try {
    Point.fromBytes(key);
    return true;
  } catch {
    return false;
  }
}

// publicKey + tweak·G. RangeError for what BIP-32 calls an invalid child.
function publicKeyTweakAdd(publicKey, tweak, compressed = true) {
  const t = bigint(tweak);
  if (t >= Point.CURVE().n) throw new RangeError("tweak out of range");
  const p = Point.fromBytes(publicKey);
  const sum = t === 0n ? p : p.add(Point.BASE.multiply(t));
  if (sum.equals(Point.ZERO)) throw new RangeError("the sum is the point at infinity");
  return sum.toBytes(compressed);
}

function hmac(name, key, data) {
  if (name !== "SHA-512") throw new Error("only HMAC-SHA-512 is here");
  return nobleHmac(sha512, key, data);
}

const available = { sha256, sha512, ripemd160, hmac, isPublicKey, publicKeyTweakAdd };

const refused = (name) => () => {
  throw new Error(`GapWallet is watch-only: it has no ${name}`);
};

export function installCrypto() {
  const all = {};
  for (const name of NEEDED) all[name] = available[name] || refused(name);
  setCrypto(all);
}
