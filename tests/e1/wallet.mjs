// The E1 test wallet: public descriptors only, signet only (docs/E1.md). Its
// words are never in this repository: tools that sign take them at run time.
//
// SPDX-License-Identifier: GPL-3.0-or-later
export const SERVER = "https://blockstream.info/signet/api";
export const FINGERPRINT = "7d8108a9";
export const DESCRIPTORS = {
  84: "wpkh([7d8108a9/84h/1h/0h]tpubDCitPvyuF28L3whn8azxQEDhjAWfBActN1ReopLqWv259TMg46EuM6Kky9JPFDY2ReJZ6WL5wva28jtd9A83fZJY2LnzDi3AP8R4Tx1GYbF/<0;1>/*)#zcz4lee8",
  49: "sh(wpkh([7d8108a9/49h/1h/0h]tpubDCepw7VjyrbxXFQHpgwotUC9Rrfpd1MbJqGMXsciTRT8hNGLArN6pziatApr3TtYMfMiax7hZEowa45eTPrwB7FxeBup6aL2UUuN84cQbhw/<0;1>/*))#fz03jdcy",
};
export const RECEIVE = {
  84: ["tb1qkeshjc7mcdj9aucg0h237lnrvsjv69wwh262wy", "tb1qvxdjje4sgdwk0wp575fdcacnztrhmfwkjlch0x", "tb1qjkce2z8ctx5x5r9g8qdfytpt3f2atsxc6vatj4"],
  49: ["2NG8w9g3ePS3EEPNsue42yy3qNxFz9FPS4J", "2NBmZK8Fgz5W5boLVtqRJB2Nnod3Z2kaudf", "2N4BAFEGJZToF2Q7RnjyCozajF9Q6j2w7jR"],
};
