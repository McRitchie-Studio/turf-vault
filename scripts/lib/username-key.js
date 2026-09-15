"use strict";

/**
 * username-key — the OFF-CHAIN half of the username registry's derivation.
 *
 * WHY THIS FILE EXISTS. `UsernameRecord` lives at a PDA seeded on the
 * canonical form of the name, so anything outside the program that wants to
 * ask "is this name free?", derive a record address, or run the migration has
 * to reproduce `canonical_username_key` EXACTLY. A second implementation of a
 * consensus rule is a drift risk by construction, so this one is written once,
 * in one place, and pinned against the Rust source by
 * `scripts/tests/username-key.test.js` — which parses
 * `programs/turf_vault/src/instructions/set_username.rs` and fails when the
 * two disagree.
 *
 * PURE NODE STDLIB, DELIBERATELY. It carries no dependency, so it runs in
 * CI's `guards` lane, which installs nothing. PDA derivation itself needs
 * `@solana/web3.js` and is therefore NOT done here — callers pass
 * `usernameRecordSeeds(name)` to `PublicKey.findProgramAddressSync`.
 *
 * THE THREE STATES a derived record can be in, for a caller reading one back:
 *   - the account does not exist            the name is free
 *   - `owner` is some wallet                that player holds it
 *   - `owner` is the [b"vault"] PDA         reserved; nobody can take it
 */

/** Seed prefix for the record PDA. Mirrors `b"username"` in the program. */
const RECORD_SEED_PREFIX = "username";

/**
 * Reserved username PREFIXES, case-insensitive, mirroring `RESERVED_PREFIXES`
 * in the program.
 *
 * THIS LIST IS NOT THE REGISTRY AND DOES NOT OVERLAP WITH IT. The registry is
 * exact-match — it stops a second "admin" and says nothing about "admin123".
 * These catch the lookalikes. Two mechanisms: prefix list = patterns,
 * registry = uniqueness and reservations.
 */
const RESERVED_PREFIXES = [
  "admin",
  "system",
  "turf",
  "vault",
  "turfmonster",
  "support",
  "mod",
  "official",
  "staff",
  "team",
  "root",
  "xan",
];

/** Mirrors `MIN_USERNAME_LEN`. */
const MIN_USERNAME_LEN = 3;

/** The on-chain username buffer width. */
const USERNAME_BYTES = 32;

/**
 * The 32-byte on-chain username buffer: UTF-8, zero-padded on the right.
 * Throws on anything that would not fit, rather than truncating — a silently
 * truncated name would derive a DIFFERENT record than the one the program
 * writes.
 */
function usernameBuffer(name) {
  const bytes = Buffer.from(String(name), "utf8");
  if (bytes.length > USERNAME_BYTES) {
    throw new Error(
      `username is ${bytes.length} bytes; the on-chain field holds ${USERNAME_BYTES}`
    );
  }
  const buf = Buffer.alloc(USERNAME_BYTES);
  bytes.copy(buf);
  return buf;
}

/**
 * The registry key: the username lowercased, zero-padded to 32 bytes.
 *
 * THIS FUNCTION IS THE UNIQUENESS RULE. Two names collide exactly when this
 * returns the same bytes for both, so the ASCII fold here is what makes
 * "Alice" and "alice" one name. Only ASCII is folded, matching the program —
 * which is complete rather than partial, because the on-chain charset bar has
 * already refused every byte outside 0x20..0x7E on every path that can reach
 * a claim.
 */
function canonicalKey(name) {
  const buf = usernameBuffer(name);
  for (let i = 0; i < buf.length; i += 1) {
    const byte = buf[i];
    // 'A'..'Z' -> 'a'..'z'. Written as a byte range rather than
    // String.toLowerCase() so this cannot quietly fold a non-ASCII character
    // the program leaves alone.
    if (byte >= 0x41 && byte <= 0x5a) buf[i] = byte + 0x20;
  }
  return buf;
}

/**
 * Seeds for the `UsernameRecord` PDA. Hand these to
 * `PublicKey.findProgramAddressSync(usernameRecordSeeds(name), programId)`.
 */
function usernameRecordSeeds(name) {
  return [Buffer.from(RECORD_SEED_PREFIX, "utf8"), canonicalKey(name)];
}

/** True when two names are the SAME name as far as the registry is concerned. */
function isSameName(a, b) {
  return canonicalKey(a).equals(canonicalKey(b));
}

/** The reserved-prefix rule, mirroring `validate_username_prefix`. */
function usesReservedPrefix(name) {
  const lower = String(name).toLowerCase();
  return RESERVED_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

module.exports = {
  RECORD_SEED_PREFIX,
  RESERVED_PREFIXES,
  MIN_USERNAME_LEN,
  USERNAME_BYTES,
  canonicalKey,
  isSameName,
  usernameBuffer,
  usernameRecordSeeds,
  usesReservedPrefix,
};
