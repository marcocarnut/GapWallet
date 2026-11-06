// What the user imports: an account's public key, as a descriptor or a zpub.
//
//   wpkh([73c5da0a/84h/0h/0h]xpub…/<0;1>/*)#checksum      (BITCOIN.md, "Public key export")
//   sh(wpkh([73c5da0a/49h/0h/0h]xpub…/<0;1>/*))#checksum
//   zpub… or ypub…  (vpub…, upub… on test networks)
//
// parseAccount() -> { network, script, purpose, coinType, account, node (the
// account's public BIP-32 node), fingerprint (hex, the master's) | null,
// warnings: [string] }
//
// P2WPKH and P2SH-P2WPKH accounts. Private keys are refused by what they look
// like, before anything else reads them, and an error never repeats its input.
//
// SPDX-License-Identifier: GPL-3.0-or-later
import { HARDENED, parseXpub, serializeXpub, versionFor, Bip32Error } from "../vendor/zerogap/bip32.js";

export class ImportError extends Error {
  constructor(message) {
    super(message);
    this.name = "ImportError";
  }
}

export const NETWORK_INFO = {
  mainnet: { name: "Mainnet", lib: "mainnet", coinType: 0 },
  signet: { name: "Signet", lib: "testnet", coinType: 1 },
  testnet4: { name: "Testnet4", lib: "testnet", coinType: 1 },
};

export const SCRIPT_INFO = {
  p2wpkh: { name: "P2WPKH", purpose: 84, wrap: (key) => `wpkh(${key})` },
  "p2sh-p2wpkh": { name: "P2SH-P2WPKH", purpose: 49, wrap: (key) => `sh(wpkh(${key}))` },
};

// BIP-380's checksum.
const INPUT_CHARSET = "0123456789()[],'/*abcdefgh@:$%{}IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~ijklmnopqrstuvwxyzABCDEFGH`#\"\\ ";
const CHECKSUM_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0xf5dee51989n, 0xa9fdca3312n, 0x1bab10e32dn, 0x3706b1677an, 0x644d626ffdn];

function polymod(c, value) {
  const top = c >> 35n;
  let next = ((c & 0x7ffffffffn) << 5n) ^ BigInt(value);
  GENERATOR.forEach((g, i) => {
    if ((top >> BigInt(i)) & 1n) next ^= g;
  });
  return next;
}

export function descriptorChecksum(text) {
  let c = 1n, cls = 0, count = 0;
  for (const ch of text) {
    const pos = INPUT_CHARSET.indexOf(ch);
    if (pos < 0) throw new ImportError("The descriptor holds a character descriptors can't have.");
    c = polymod(c, pos & 31);
    cls = cls * 3 + (pos >> 5);
    if (++count === 3) {
      c = polymod(c, cls);
      cls = 0;
      count = 0;
    }
  }
  if (count > 0) c = polymod(c, cls);
  for (let i = 0; i < 8; i++) c = polymod(c, 0);
  c ^= 1n;
  let out = "";
  for (let i = 0; i < 8; i++) out += CHECKSUM_CHARSET[Number((c >> BigInt(5 * (7 - i))) & 31n)];
  return out;
}

const looksPrivate = (text) => {
  const s = text.trim();
  return /(^|[^1-9A-Za-z])[xyztuv]prv[1-9A-HJ-NP-Za-km-z]{20,}/.test(s) // extended private keys, alone or in a descriptor
    || /^[5KLc9][1-9A-HJ-NP-Za-km-z]{50,51}$/.test(s) // WIF
    || /^([a-z]{3,8}[\s,]+){11,}[a-z]{3,8}$/.test(s) // seed words
    || /^(ms|MS)1[02-9ac-hj-np-zAC-HJ-NP-Z]{20,}/.test(s); // codex32
};

function readKey(text) {
  try {
    return parseXpub(text);
  } catch (e) {
    if (e instanceof Bip32Error) throw new ImportError("That public key can't be read: " + e.message + ".");
    throw e;
  }
}

// The account the key says it is: depth 3, a hardened child.
function accountOf(node) {
  if (node.depth !== 3) {
    throw new ImportError(`This key is at depth ${node.depth}, not an account's (depth 3). A master xpub can't stand in: ` +
      "account paths are hardened, so a watch-only wallet can't derive them from it.");
  }
  if (node.childNumber < HARDENED) throw new ImportError("This key's account number isn't hardened, so it isn't an account key.");
  return node.childNumber - HARDENED;
}

function checkNetwork(keyNetwork, network) {
  const info = NETWORK_INFO[network];
  if (!info) throw new ImportError("Choose a network.");
  if (keyNetwork !== info.lib) {
    const has = keyNetwork === "mainnet" ? "mainnet" : "a test network";
    throw new ImportError(`This key is for ${has}, but you chose ${info.name}.`);
  }
  return info;
}

const accountFields = (network, script, info, account, node, fingerprint, warnings) => ({
  network, script, purpose: SCRIPT_INFO[script].purpose, coinType: info.coinType, account, node, fingerprint, warnings });

function parseFingerprint(text) {
  const s = (text || "").trim().toLowerCase();
  if (s === "") return null;
  if (!/^[0-9a-f]{8}$/.test(s)) throw new ImportError("A master fingerprint is 8 hexadecimal digits, like 73c5da0a.");
  return s;
}

function parseExtendedKey(text, network, fingerprint) {
  const prefix = text.slice(0, 4);
  if (prefix === "xpub" || prefix === "tpub") {
    throw new ImportError(`A bare ${prefix} doesn't say what kind of addresses it makes. Import the descriptor, or the zpub or ypub.`);
  }
  if (!["zpub", "vpub", "ypub", "upub"].includes(prefix)) throw new ImportError("This isn't a descriptor, a zpub or a ypub.");
  const key = readKey(text);
  const info = checkNetwork(key.network, network);
  return accountFields(network, key.script, info, accountOf(key.node), key.node, fingerprint, []);
}

function parseDescriptor(text, network, fingerprintGiven) {
  const warnings = [];
  const hash = text.lastIndexOf("#");
  const body = hash < 0 ? text : text.slice(0, hash);
  if (hash < 0) {
    warnings.push("The descriptor had no checksum, so a typing mistake in its fingerprint wouldn't show.");
  } else if (text.slice(hash + 1) !== descriptorChecksum(body)) {
    throw new ImportError("The descriptor's checksum is wrong: it was changed or mistyped.");
  }
  const nested = body.startsWith("sh(wpkh(");
  const script = nested ? "p2sh-p2wpkh" : "p2wpkh";
  const inner = nested && body.endsWith(")") ? body.slice(3, -1) : body;
  if (/^(sh|pkh|tr|wsh)\(/.test(inner)) throw new ImportError("Only wpkh(…) and sh(wpkh(…)) accounts are supported for now.");
  const m = /^wpkh\((?:\[([0-9a-fA-F]{8})((?:\/\d+['h]?)*)\])?([1-9A-HJ-NP-Za-km-z]+)\/<0;1>\/\*\)$/.exec(inner);
  if (!m) {
    if (/\/[01]\/\*\)+$/.test(body)) throw new ImportError("This descriptor covers one chain only. The wallet needs both: …/<0;1>/*.");
    throw new ImportError("This descriptor isn't of the form wpkh([fingerprint/84h/0h/0h]xpub…/<0;1>/*).");
  }
  const [, fp, origin, xpub] = m;
  const prefix = xpub.slice(0, 4);
  if (prefix !== "xpub" && prefix !== "tpub") throw new ImportError(`A descriptor holds an xpub or tpub, not a ${prefix}.`);
  const key = readKey(xpub);
  const info = checkNetwork(key.network, network);
  const account = accountOf(key.node);
  if (fp) {
    const want = [SCRIPT_INFO[script].purpose, info.coinType, account].map((n) => `/${n}h`).join("");
    if (origin.replace(/'/g, "h") !== want) {
      throw new ImportError(`The descriptor's origin should be ${want.slice(1)}, for this key on ${info.name}.`);
    }
    const given = fingerprintGiven;
    if (given && given !== fp.toLowerCase()) throw new ImportError("The descriptor's fingerprint isn't the one you typed.");
    return accountFields(network, script, info, account, key.node, fp.toLowerCase(), warnings);
  }
  return accountFields(network, script, info, account, key.node, fingerprintGiven, warnings);
}

// `fingerprint`: the master's, as typed, or "" when the import doesn't say.
export function parseAccount(text, network, fingerprint = "") {
  const s = String(text).trim();
  if (s === "") throw new ImportError("Paste a descriptor, a zpub or a ypub.");
  if (looksPrivate(s)) throw new ImportError("This is a private key or a seed. Nothing was kept. GapWallet only ever takes public keys.");
  const fp = parseFingerprint(fingerprint);
  return /^[a-z]+\(/.test(s) ? parseDescriptor(s, network, fp) : parseExtendedKey(s, network, fp);
}

// The account's descriptor, with origin (when known) and checksum, as text.
export function accountDescriptor(a) {
  const key = serializeXpub(a.node, a.coinType === 0 ? "xpub" : "tpub");
  const origin = a.fingerprint ? `[${a.fingerprint}/${a.purpose}h/${a.coinType}h/${a.account}h]` : "";
  const body = SCRIPT_INFO[a.script].wrap(`${origin}${key}/<0;1>/*`);
  return `${body}#${descriptorChecksum(body)}`;
}

// The account's key as Electrum shows it: { name: "zpub", key }.
export function accountSlip132(a) {
  const name = versionFor(a.script, NETWORK_INFO[a.network].lib);
  return { name, key: serializeXpub(a.node, name) };
}

export const accountPath = (a) => `m/${a.purpose}'/${a.coinType}'/${a.account}'`;
