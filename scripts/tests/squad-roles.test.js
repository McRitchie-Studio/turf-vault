/**
 * Regression suite for scripts/lib/squad-roles.js — WHO CAN SIGN A MAINNET
 * UPGRADE, asked before the first lamport.
 *
 * WHAT IT PROTECTS. `scripts/squad-upgrade.js` spends before it votes: by the
 * approve step it has already paid for ExtendProgram and created the vault
 * transaction. A key that cannot do what the next step asks — evicted by a
 * rotation, granted a narrower mask than the tooling uses, unable to Vote, or
 * simply fewer approvers than the threshold — strands a half-done upgrade with a
 * buffer on chain. The planner reads the multisig's own members, masks and
 * threshold and refuses first.
 *
 * WHO SIGNS, as the script runs it: the bot initiates, casts one approval, pays
 * and executes; Mason casts the second. Narrowing the bot to drop Vote was
 * proposed and DECLINED — Squads counts approvals only from Vote-holders, so it
 * would leave two voters against threshold 2 with no spare — so the mask this
 * requires of the bot is all three bits, which is what the script uses.
 *
 * No keys, no network, no @sqds dependency: plain base58 strings and node
 * stdlib, so this runs in CI's guards lane.
 *
 *   npm run test:scripts
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  SquadRoleError,
  INITIATE,
  VOTE,
  EXECUTE,
  planUpgradeSigners,
} = require("../lib/squad-roles");

// The documented member set (scripts/squad.json "members" is documentation
// only — live truth is the on-chain Multisig account, which is exactly what
// the planner is handed).
const BOT = "8K81w4e6UcB7TiANhM9N8sAgijJvTxxybRi8AENRaRYd";
const ALEX = "7ZDJp7FUHhuceAqcW9CHe81hCiaMTjgWAXfprBM59Tcr";
const MASON = "CytJS23p1zCM2wvUUngiDePtbMB484ebD7bK4nDqWjrR";

const ALL = INITIATE | VOTE | EXECUTE; // 7
const NO_VOTE = INITIATE | EXECUTE; // 5 — the narrowing that was declined

function multisig({
  botMask = ALL,
  alexMask = ALL,
  masonMask = ALL,
  threshold = 2,
  members,
} = {}) {
  return {
    threshold,
    members: members || [
      { key: BOT, mask: botMask },
      { key: ALEX, mask: alexMask },
      { key: MASON, mask: masonMask },
    ],
  };
}

const plan = (opts = {}) =>
  planUpgradeSigners({
    multisig: multisig(opts.multisig),
    bot: opts.bot === undefined ? BOT : opts.bot,
    approvers: opts.approvers === undefined ? [BOT, MASON] : opts.approvers,
  });

// --- the plan the script actually runs --------------------------------------

test("the bot initiates, approves and executes; Mason casts the second approval", () => {
  const p = plan();

  assert.deepEqual(p.approvers, [BOT, MASON]);
  assert.equal(p.transactionCreator, BOT);
  assert.equal(
    p.creator,
    BOT,
    "the bot opens the proposal, as the script does"
  );
  assert.equal(p.executor, BOT);
  assert.equal(p.approvals, 2);
  assert.equal(p.threshold, 2);
  assert.ok(p.quorumReached);
});

test("a human pair plans just as happily — this module decides nothing about WHO", () => {
  const p = plan({ approvers: [ALEX, MASON] });

  assert.deepEqual(p.approvers, [ALEX, MASON]);
  assert.ok(p.quorumReached);
});

test("the plan requires of the bot exactly the bits the script uses", () => {
  const p = plan();

  assert.equal(p.botMaskRequired, INITIATE | VOTE | EXECUTE);
  assert.equal(p.botMask, ALL);
});

// --- refusals: every way the quorum could quietly not be there --------------

const REFUSED = [
  [
    "the bot is not a member at all",
    {
      multisig: {
        members: [
          { key: ALEX, mask: ALL },
          { key: MASON, mask: ALL },
        ],
      },
    },
    /not a member/i,
  ],
  [
    "the bot lost Execute",
    { multisig: { botMask: INITIATE | VOTE } },
    /Execute/,
  ],
  [
    "the bot lost Initiate",
    { multisig: { botMask: VOTE | EXECUTE } },
    /Initiate/,
  ],
  [
    "only one approver is supplied for a threshold of 2",
    { approvers: [MASON] },
    /threshold 2/i,
  ],
  [
    "the same approver is supplied twice",
    { approvers: [MASON, MASON] },
    /twice|duplicate/i,
  ],
  [
    "the bot was narrowed to Initiate|Execute and can no longer cast its approval",
    { multisig: { botMask: NO_VOTE } },
    /Vote/,
  ],
  [
    "an approver is not a member of this multisig",
    { approvers: [BOT, "So1oNotAMemberOfThisMultisig11111111111111"] },
    /not a member/i,
  ],
  [
    "an approver cannot vote",
    { multisig: { masonMask: INITIATE | EXECUTE } },
    /Vote/,
  ],
  [
    "the threshold is higher than the approvers in hand",
    { multisig: { threshold: 3 } },
    /threshold 3/i,
  ],
  ["no approver is supplied at all", { approvers: [] }, /threshold 2/i],
];

for (const [label, opts, pattern] of REFUSED) {
  test(`refuses to sign when ${label}`, () => {
    assert.throws(
      () => plan(opts),
      (err) => {
        assert.ok(
          err instanceof SquadRoleError,
          `expected SquadRoleError, got ${err && err.constructor.name}`
        );
        assert.match(err.message, pattern);
        return true;
      }
    );
  });
}

test("a refusal never prints key material — only public keys and masks", () => {
  try {
    plan({ multisig: { botMask: INITIATE | VOTE } });
    assert.fail("expected a refusal");
  } catch (err) {
    assert.ok(
      !/[0-9A-HJ-NP-Za-km-z]{80,}/.test(err.message),
      "a base58 secret is ~88 chars; nothing that long may appear"
    );
  }
});
