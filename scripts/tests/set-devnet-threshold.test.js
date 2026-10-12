"use strict";

/**
 * Guard: scripts/set-devnet-threshold.js names every governance action by the
 * same index the program uses, and refuses exactly the actions the program
 * floors. Both tables are restated in JS for an operator with no build, so this
 * test PARSES programs/turf_vault/src/state.rs and compares. Pure node:test, no
 * chain access.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  parsePlan,
  ACTIONS,
  FLOORED,
  PROGRAM_ID,
  MAINNET_ID,
  DEVNET_GENESIS,
} = require("../set-devnet-threshold.js");

const STATE = fs.readFileSync(
  path.join(__dirname, "..", "..", "programs", "turf_vault", "src", "state.rs"),
  "utf8"
);

function rustActions() {
  const block = STATE.slice(STATE.indexOf("pub mod gov_action"));
  const out = {};
  for (const m of block
    .slice(0, block.indexOf("COUNT"))
    .matchAll(/pub const ([A-Z_]+): u8 = (\d+);/g)) {
    out[m[1].toLowerCase()] = Number(m[2]);
  }
  return out;
}

function rustFloored() {
  const block = STATE.slice(STATE.indexOf("pub const THRESHOLD_FLOORS"));
  const body = block.slice(0, block.indexOf("\n};"));
  return [...body.matchAll(/f\[gov_action::([A-Z_]+) as usize\] = 3;/g)].map(
    (m) => m[1].toLowerCase()
  );
}

test("ACTIONS matches state.rs gov_action, name for name and index for index", () => {
  assert.deepStrictEqual(ACTIONS, rustActions());
});

test("FLOORED matches state.rs THRESHOLD_FLOORS", () => {
  assert.deepStrictEqual([...FLOORED].sort(), rustFloored().sort());
});

test("settle_contest at 2 is a valid devnet plan", () => {
  assert.deepStrictEqual(parsePlan("settle_contest", "2"), {
    action: "settle_contest",
    code: 0,
    value: 2,
  });
});

test("a floored action is refused before anything is read", () => {
  assert.throws(() => parsePlan("update_signers", "3"), /floored/);
  assert.throws(() => parsePlan("set_governance", "3"), /floored/);
});

test("an unknown action or an out-of-range value is refused", () => {
  assert.throws(() => parsePlan("settle", "2"), /--action/);
  assert.throws(() => parsePlan("settle_contest", "0"), /--value/);
  assert.throws(() => parsePlan("settle_contest", "6"), /--value/);
  assert.throws(() => parsePlan("settle_contest", "two"), /--value/);
});

test("the pinned program is devnet's, never mainnet's", () => {
  assert.notStrictEqual(PROGRAM_ID, MAINNET_ID);
  assert.strictEqual(PROGRAM_ID, "EQGFJAcABtDb6VXtiijTjZ6cE2UqdvhnqJvoharJbpMJ");
  assert.strictEqual(DEVNET_GENESIS, "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
});
