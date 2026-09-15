"use strict";

/**
 * THE ON-CHAIN BYTE LAYOUT OF `VaultState`, declared once.
 *
 * `VaultState` is an Anchor `zero_copy(unsafe)` + `#[repr(C)]` account: the
 * account data buffer is reinterpreted in place, with no name-keyed decode and
 * no version tag. Every field's OFFSET is therefore its identity, and any
 * reader — the program, a ceremony script, an operator with a hex dump — has
 * to agree on the same numbers or it is reading a different account than it
 * thinks.
 *
 * These constants exist so the ceremony scripts in this directory do not each
 * carry their own copy. The program's own copy is asserted independently in
 * `programs/turf_vault/src/governance_tests.rs`; the two are checked against
 * each other in `scripts/tests/vault-layout.test.js`, which parses the Rust
 * struct rather than trusting either.
 *
 * WHY SCRIPTS READ BYTES AND NOT THE IDL. A ceremony script is what an
 * operator runs on the worst day, possibly from a borrowed machine with
 * nothing checked out. Decoding 160 bytes at fixed offsets needs only
 * `@solana/web3.js`; going through Anchor's account coder needs the IDL, which
 * needs a build, which needs the toolchain. The scripts stay deliberately
 * cheap to run.
 */

const PUBKEY = 32;

/** Byte offsets into the account DATA (after Anchor's 8-byte discriminator). */
const OFFSETS = {
  signers: 0, //   3 × 32 = 96
  threshold: 96,
  bump: 97,
  paused: 98,
  payout_mint: 99,
  treasury_authority: 131,
  accepted_currencies: 163, // 16 × 80 = 1280
  // v0.26: APPENDED into what used to be `_reserved`, which is why every
  // offset above is unchanged and no account had to be migrated.
  signers_ext: 1443, //   2 × 32 = 64
};

/** `VaultState` data size, and the full account size including discriminator. */
const DATA_LEN = 1507;
const ACCOUNT_LEN = 8 + DATA_LEN;

/** Slots in the first array, slots in the appended one, and the total. */
const BASE_SLOTS = 3;
const EXT_SLOTS = 2;
const MAX_SIGNERS = BASE_SLOTS + EXT_SLOTS;

const DISCRIMINATOR = 8;

/** The all-zero pubkey — the program's "this slot is EMPTY" sentinel. */
const DEFAULT_PUBKEY = "11111111111111111111111111111111";

/**
 * Read all five signer slots out of a raw `vault_state` account buffer.
 *
 * Returns one entry per SLOT, empty slots included, so a caller can tell
 * "slot 4 is empty" from "there is no slot 4" — the distinction a pre-flight
 * check before a rotation exists to make.
 *
 * @param {Buffer} data raw account data INCLUDING the 8-byte discriminator
 * @param {{ toBase58: (b: Uint8Array) => string }} encode base58 encoder
 * @returns {{ index: number, field: string, base58: string, empty: boolean }[]}
 */
function readSignerSlots(data, encode) {
  if (!data || data.length < ACCOUNT_LEN) {
    throw new Error(
      `vault_state account is ${data ? data.length : 0} bytes; expected ${ACCOUNT_LEN}. ` +
        "Refusing to decode — a short buffer would read garbage at these offsets."
    );
  }
  const slots = [];
  for (let i = 0; i < MAX_SIGNERS; i += 1) {
    const inExt = i >= BASE_SLOTS;
    const base = inExt
      ? OFFSETS.signers_ext + (i - BASE_SLOTS) * PUBKEY
      : OFFSETS.signers + i * PUBKEY;
    const start = DISCRIMINATOR + base;
    const bytes = data.subarray(start, start + PUBKEY);
    const base58 = encode(bytes);
    slots.push({
      index: i,
      field: inExt ? "signers_ext" : "signers",
      base58,
      empty: base58 === DEFAULT_PUBKEY,
    });
  }
  return slots;
}

/**
 * Is this vault still in its PRE-ROTATION shape — three occupied slots and the
 * two appended ones empty?
 *
 * Before the ceremony this answers "the appended slots are untouched, so the
 * upgrade has changed nothing". After it, the same call answers "the rotation
 * landed". It is the successor to the pre-upgrade `check-reserved.js`, which
 * asked whether the 64 reserved bytes were all zero; those bytes are now the
 * slots, so the question became this one.
 */
function isUnrotated(slots) {
  return (
    slots.length === MAX_SIGNERS &&
    slots.slice(0, BASE_SLOTS).every((s) => !s.empty) &&
    slots.slice(BASE_SLOTS).every((s) => s.empty)
  );
}

/** Slots are LEFT-PACKED: the program refuses a live key after an empty one. */
function isLeftPacked(slots) {
  const firstEmpty = slots.findIndex((s) => s.empty);
  if (firstEmpty === -1) return true;
  return slots.slice(firstEmpty).every((s) => s.empty);
}

module.exports = {
  PUBKEY,
  OFFSETS,
  DATA_LEN,
  ACCOUNT_LEN,
  DISCRIMINATOR,
  BASE_SLOTS,
  EXT_SLOTS,
  MAX_SIGNERS,
  DEFAULT_PUBKEY,
  readSignerSlots,
  isUnrotated,
  isLeftPacked,
};
