/**
 * Guard: the OFF-CHAIN username derivation cannot drift from the on-chain one.
 *
 * WHAT IS AT RISK. `UsernameRecord` sits at a PDA seeded on the canonical form
 * of the name, and `scripts/lib/username-key.js` is a SECOND implementation of
 * that rule — the one Rails, the migration and any operator script will use.
 * Two implementations of a consensus rule drift; the only question is whether
 * anything notices. A drifted `canonicalKey` derives the wrong address, so
 * "is this name free?" is answered against an account that is not the one the
 * program will write, and the answer is wrong in the direction that says FREE.
 *
 * SO THIS FILE READS THE RUST SOURCE. Every cross-language test below parses
 * `programs/turf_vault/src/instructions/set_username.rs` and compares it to the
 * JS module — it asserts agreement with the PROGRAM, not with a copy of the
 * program's values restated here, which would only prove this file agrees with
 * itself.
 *
 * IT CANNOT PASS VACUOUSLY. The real failure mode of a source-parsing guard is
 * an extractor that finds nothing and reports success, so every extractor has
 * a control asserting it found the real thing.
 *
 * Pure Node stdlib (node:test + node:assert), no dependency tree — so it runs
 * in CI's `guards` lane, which deliberately installs nothing.
 *
 *   npm run test:scripts
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  RECORD_SEED_PREFIX,
  RESERVED_PREFIXES,
  MIN_USERNAME_LEN,
  USERNAME_BYTES,
  canonicalKey,
  isSameName,
  usernameBuffer,
  usernameRecordSeeds,
  usesReservedPrefix,
} = require("../lib/username-key.js");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SOURCE_REL = "programs/turf_vault/src/instructions/set_username.rs";
const SOURCE = fs.readFileSync(path.join(REPO_ROOT, SOURCE_REL), "utf8");

/** Every `b"..."` entry inside the RESERVED_PREFIXES array literal. */
function rustReservedPrefixes() {
  const block = SOURCE.match(
    /const RESERVED_PREFIXES: &\[&\[u8\]\] = &\[([\s\S]*?)\];/
  );
  if (!block) return null;
  return [...block[1].matchAll(/b"([^"]*)"/g)].map((hit) => hit[1]);
}

function rustConst(name) {
  const hit = SOURCE.match(
    new RegExp(`const\\s+${name}\\s*:\\s*usize\\s*=\\s*(\\d+)\\s*;`)
  );
  return hit ? Number(hit[1]) : null;
}

// ────────────────────────────────────────────────────────────────────────────
// THE CROSS-LANGUAGE PINS
// ────────────────────────────────────────────────────────────────────────────

test("the JS reserved-prefix list matches the program's, in order", () => {
  const rust = rustReservedPrefixes();

  // Control first: if the extractor came back empty, everything below would
  // pass for the wrong reason.
  assert.ok(
    rust && rust.length > 0,
    [
      "",
      `Could not extract RESERVED_PREFIXES from ${SOURCE_REL}.`,
      "Either the array was renamed or reshaped — in which case update",
      "rustReservedPrefixes() here — or it is gone, which is a much bigger",
      "change than this guard. Until then every assertion in this file is",
      "passing vacuously.",
      "",
    ].join("\n")
  );

  assert.deepEqual(
    RESERVED_PREFIXES,
    rust,
    [
      "",
      "scripts/lib/username-key.js and the program disagree about which",
      "username prefixes are reserved.",
      "",
      `  program (${SOURCE_REL}): ${JSON.stringify(rust)}`,
      `  scripts/lib/username-key.js: ${JSON.stringify(RESERVED_PREFIXES)}`,
      "",
      "A name the JS list lets through and the program refuses is a signup",
      "that fails at the last step; a name the JS list refuses and the program",
      "allows is a name nobody can take. Add it to BOTH or neither.",
      "",
    ].join("\n")
  );
});

test("xan is reserved on both sides", () => {
  // Named separately because it is the entry this change adds, and because a
  // deepEqual failure above would not say WHICH entry moved.
  assert.ok(
    rustReservedPrefixes().includes("xan"),
    "the program must reserve `xan` — an operator identity is not claimable"
  );
  assert.ok(usesReservedPrefix("xan"));
  assert.ok(usesReservedPrefix("XAN"), "the rule is case-insensitive");
  // It is a PREFIX rule, like every other entry: `mod` has always blocked
  // `modern`, so `xan` blocking `xanadu` is the existing design, not new.
  assert.ok(usesReservedPrefix("xanadu"));
  assert.ok(!usesReservedPrefix("xylophone"));
});

test("the length floor and the buffer width match the program", () => {
  const rustMin = rustConst("MIN_USERNAME_LEN");
  assert.ok(rustMin !== null, `could not find MIN_USERNAME_LEN in ${SOURCE_REL}`);
  assert.equal(MIN_USERNAME_LEN, rustMin);

  // The on-chain field is `[u8; 32]` everywhere it appears.
  assert.ok(
    /username: \[u8; 32\]/.test(SOURCE),
    "the program's username argument is no longer [u8; 32]"
  );
  assert.equal(USERNAME_BYTES, 32);
});

test("the record seed prefix matches the program's literal", () => {
  const registry = fs.readFileSync(
    path.join(REPO_ROOT, "programs/turf_vault/src/instructions/username_registry.rs"),
    "utf8"
  );
  assert.ok(
    registry.includes(`b"${RECORD_SEED_PREFIX}"`),
    [
      "",
      `The program no longer seeds UsernameRecord with b"${RECORD_SEED_PREFIX}".`,
      "Every address derived off-chain would point at an account the program",
      "does not write — and a read of a non-existent account reports the name",
      "as FREE, which is the wrong direction to be wrong in.",
      "",
    ].join("\n")
  );
});

// ────────────────────────────────────────────────────────────────────────────
// THE DERIVATION ITSELF
// ────────────────────────────────────────────────────────────────────────────

test("names differing only in case derive the SAME key", () => {
  // The uniqueness rule. If this stopped holding, "Alice" and "alice" would
  // derive different PDAs, both would be claimable, and the registry would be
  // silently off for exactly the impersonation it exists to stop.
  for (const [a, b] of [
    ["Alice", "alice"],
    ["ALICE", "alice"],
    ["aLiCe", "alice"],
  ]) {
    assert.ok(isSameName(a, b), `${a} and ${b} must be one name`);
    assert.deepEqual(canonicalKey(a), canonicalKey(b));
  }
});

test("distinct names never share a key", () => {
  for (const [a, b] of [
    ["alice", "alicee"],
    ["alice", "alic"],
    ["alice", "bob"],
    ["alice", "alice "],
  ]) {
    assert.ok(!isSameName(a, b), `${a} and ${b} must be different names`);
  }
});

test("the key is 32 bytes and keeps its zero padding", () => {
  const key = canonicalKey("Alice");
  assert.equal(key.length, 32);
  assert.equal(key.subarray(0, 5).toString("utf8"), "alice");
  assert.ok(key.subarray(5).every((byte) => byte === 0));
});

test("canonicalizing a key again changes nothing", () => {
  const key = canonicalKey("Alice");
  assert.deepEqual(canonicalKey(key.subarray(0, 5).toString("utf8")), key);
});

test("a name too long to fit throws rather than truncating", () => {
  // A silently truncated name derives a DIFFERENT record than the program
  // writes, so the caller would read availability off the wrong account.
  assert.throws(() => usernameBuffer("x".repeat(33)), /33 bytes/);
  assert.doesNotThrow(() => usernameBuffer("x".repeat(32)));
});

test("the seeds are the prefix and the canonical key, in that order", () => {
  const seeds = usernameRecordSeeds("Alice");
  assert.equal(seeds.length, 2);
  assert.equal(seeds[0].toString("utf8"), "username");
  assert.deepEqual(seeds[1], canonicalKey("alice"));
  // Each seed must be within Solana's 32-byte per-seed limit.
  for (const seed of seeds) assert.ok(seed.length <= 32);
});

test("control: the lowercase fold really is a fold", () => {
  // If canonicalKey became the identity function, every equality test above
  // would still pass for the pairs that are already lowercase. This fails on
  // an identity function.
  assert.notDeepEqual(
    canonicalKey("ALICE"),
    usernameBuffer("ALICE"),
    "canonicalKey returned its input unchanged — it is no longer folding case"
  );
});
