// What this browser keeps: settings, and each account's public key
// (docs/ESPLORA.md, "Privacy"). Balances and history are not kept.
//
// SPDX-License-Identifier: GPL-3.0-or-later
const KEY = "gapwallet.v1";

const EMPTY = { accounts: [], current: null, servers: {} };

export function load(storage = localStorage) {
  try {
    const s = JSON.parse(storage.getItem(KEY));
    return s && Array.isArray(s.accounts) ? { ...EMPTY, ...s } : { ...EMPTY };
  } catch {
    return { ...EMPTY };
  }
}

export const save = (state, storage = localStorage) => storage.setItem(KEY, JSON.stringify(state));
