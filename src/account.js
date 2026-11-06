// An account's addresses, derived here and never taken from a server.
//
//   addressAt(account, chain, index)
//     -> { address, script, redeemScript | null, pubkey, chain, index, path, steps }
//
// SPDX-License-Identifier: GPL-3.0-or-later
import { HARDENED, deriveChild } from "../vendor/zerogap/bip32.js";
import { hash160 } from "../vendor/zerogap/psbt/hashes.js";
import { p2shScript, p2wpkhScript, scriptToAddress } from "../vendor/zerogap/psbt/script.js";
import { accountPath, NETWORK_INFO } from "./descriptor.js";

const chains = new WeakMap(); // account -> [chain 0's node, chain 1's node]

function chainNode(account, chain) {
  let c = chains.get(account);
  if (!c) chains.set(account, (c = []));
  if (!c[chain]) c[chain] = deriveChild(account.node, chain);
  return c[chain];
}

export function addressAt(account, chain, index) {
  if (chain !== 0 && chain !== 1) throw new RangeError("chain is 0 or 1");
  if (!Number.isInteger(index) || index < 0 || index >= HARDENED) throw new RangeError("bad address index");
  const pubkey = deriveChild(chainNode(account, chain), index).publicKey;
  const witnessProgram = p2wpkhScript(hash160(pubkey));
  const nested = account.script === "p2sh-p2wpkh";
  const script = nested ? p2shScript(hash160(witnessProgram)) : witnessProgram;
  return { address: scriptToAddress(script, NETWORK_INFO[account.network].lib), script,
    redeemScript: nested ? witnessProgram : null, pubkey, chain, index,
    path: `${accountPath(account)}/${chain}/${index}`,
    steps: [HARDENED + account.purpose, HARDENED + account.coinType, HARDENED + account.account, chain, index] };
}
