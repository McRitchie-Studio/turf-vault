/**
 * Regression suite for scripts/lib/squad-roles.js — WHO SIGNS A MAINNET UPGRADE.
 *
 * THE DEFECT THIS PINS (2026-09-13, narrow-bot-squads-permissions).
 * `scripts/squad-upgrade.js:160` approved the upgrade proposal AS ALEX BOT:
 *
 *     proposalApprove({ ..., member: alexBot })   // "approve (Alex Bot)"
 *
 * The bot key lives in Heroku config AND on disk. With a Vote bit, a LEAKED BOT
 * KEY PLUS ANY ONE HUMAN KEY reaches the 2-of-3 quorum over mainnet upgrade
 * authority. Mr. McRitchie's decision (activity-8875): the bot loses Vote (mask
 * 5 = Initiate|Execute) and BOTH humans approve. The script must stop voting as
 * the bot BEFORE that mask lands, or the multisig ships a permission the tooling
 * violates.
 *
 * WHAT MAKES THIS EVIDENCE RATHER THAN DECORATION.
 *
 *   1. It grades the ON-CHAIN shape, not our intentions: every case is a
 *      Multisig account's own members + masks + threshold, the values
 *      `squad-upgrade.js` reads back before it spends anything.
 *   2. It proves the planner REFUSES. A planner that accepts everything passes
 *      every happy-path assertion; the REFUSED table below is the half that
 *      says so, including the two shapes that would silently lose quorum — a
 *      duplicate approver, and a threshold the humans alone cannot reach.
 *   3. It runs BOTH masks: 7 (today, before the ceremony) and 5 (after). The
 *      script half must be correct in both, because it lands first.
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
const BOT_AFTER = INITIATE | EXECUTE; // 5 — the mask the ceremony grants

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
    humans: opts.humans === undefined ? [ALEX, MASON] : opts.humans,
  });

// --- the shape the ceremony produces, and the one it starts from ------------

test("with the bot at mask 5 the two humans carry the quorum", () => {
  const p = plan({ multisig: { botMask: BOT_AFTER } });

  assert.deepEqual(p.approvers, [ALEX, MASON]);
  assert.equal(p.executor, BOT);
  assert.equal(
    p.creator,
    ALEX,
    "a human opens the proposal, so no Initiate-vs-Vote question decides it"
  );
  assert.equal(
    p.transactionCreator,
    BOT,
    "the bot still initiates the vault transaction"
  );
  assert.equal(p.approvals, 2);
  assert.equal(p.threshold, 2);
  assert.ok(p.quorumReached);
});

test("the same plan holds while the bot still has mask 7 — the script lands first", () => {
  const p = plan();

  assert.deepEqual(
    p.approvers,
    [ALEX, MASON],
    "the bot must not vote even while it still can"
  );
  assert.ok(!p.approvers.includes(BOT));
  assert.ok(p.quorumReached);
});

test("the plan never asks the bot for a vote it is about to lose", () => {
  const p = plan({ multisig: { botMask: BOT_AFTER } });

  assert.ok(
    !(p.botMaskRequired & VOTE),
    "the script must require only Initiate|Execute of the bot"
  );
  assert.equal(p.botMaskRequired, INITIATE | EXECUTE);
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
    "the bot lost Execute as well as Vote",
    { multisig: { botMask: INITIATE | VOTE } },
    /Execute/,
  ],
  [
    "the bot lost Initiate",
    { multisig: { botMask: VOTE | EXECUTE } },
    /Initiate/,
  ],
  [
    "only one human is supplied for a threshold of 2",
    { humans: [MASON] },
    /threshold 2/i,
  ],
  [
    "the same human is supplied twice",
    { humans: [MASON, MASON] },
    /twice|duplicate/i,
  ],
  [
    "the bot is offered as one of the approvers",
    { humans: [BOT, MASON] },
    /bot/i,
  ],
  [
    "an approver is not a member of this multisig",
    { humans: [ALEX, "So1oNotAMemberOfThisMultisig11111111111111"] },
    /not a member/i,
  ],
  [
    "an approver cannot vote",
    { multisig: { masonMask: INITIATE | EXECUTE } },
    /Vote/,
  ],
  [
    "the human opening the proposal cannot initiate",
    { multisig: { alexMask: VOTE } },
    /Initiate/,
  ],
  [
    "the threshold is higher than the humans can reach without the bot",
    { multisig: { threshold: 3 } },
    /threshold 3/i,
  ],
  ["no human is supplied at all", { humans: [] }, /threshold 2/i],
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
