/**
 * Regression suite for scripts/lib/squad-roles.js — WHICH OF TWO BEHAVIOURS an
 * upgrade run takes, decided by counting seats on the live multisig.
 *
 * WHAT IT PROTECTS. `scripts/squad-upgrade.js` spends before it votes: by the
 * approve step it has already paid for any ExtendProgram and created the vault
 * transaction. The planner reads the multisig's own members, masks and threshold
 * and settles the whole shape of the run first.
 *
 * THE BEHAVIOUR THAT CHANGED, AND WHY THIS FILE WAS REWRITTEN (2026-09-15).
 * This module used to THROW whenever the keys in hand could not reach the
 * threshold, which was right while every cluster was 2-of-3 with two agent-held
 * seats. The rotation that morning made the two clusters deliberately
 * asymmetric — devnet's agent seats reach quorum, mainnet's do not — so a short
 * quorum on mainnet is now the DESIGN, not a fault. It is a MODE:
 *
 *   autonomous   enough Vote seats AND an Execute seat — run it end to end
 *   handoff      not enough — create, approve what you can, stop for a human
 *
 * The refusals that remain are dead ends rather than handoffs, and each has a
 * test below: no seat at all (the literal 09:41 state, when `ALEX_BOT_KEY` and
 * `MASON_KEY` had both been removed), no seat that can Initiate, and a handoff
 * whose shortfall the remaining members could never cover.
 *
 * No keys, no network, no @sqds dependency: plain base58 strings and node
 * stdlib, so this runs in CI's guards lane.
 *
 *   npm run test:scripts
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  EXECUTE,
  INITIATE,
  SquadRoleError,
  VOTE,
  describeMask,
  planUpgrade,
} = require("../lib/squad-roles");

// Live keys, used here only as distinguishable identifiers.
const SYSTEM = "7auwTLSvNniSUeAgL6v9RStMXJhWrrUhSJgwFWLpcqC"; // agent, mainnet
const SYSTEM_DEVNET = "2eGs8G3wzhEeNQQU2Q86BmmA2xTpDbMMae3Y1bvpZfx9"; // agent, devnet
const ADMIN = "BLSBw8fXHzZc5pbaYCKMpMSsrtXBTbWXpUPVzMrXx9oo"; // agent, both
const XAN = "8K81w4e6UcB7TiANhM9N8sAgijJvTxxybRi8AENRaRYd"; // agent, devnet only
const ALEX = "7ZDJp7FUHhuceAqcW9CHe81hCiaMTjgWAXfprBM59Tcr"; // operator
const ALEX_TWO = "3Qj4v9qjhXgkru6zCRCErRVhy8Q6qU3NrNpvpXLTZboA"; // operator
const ALEX_THREE = "9gACbzsCLmkYF9Yx1EBGmwMvvyfuTquJ6qs8QsoQvHXf"; // operator
const MASON = "CytJS23p1zCM2wvUUngiDePtbMB484ebD7bK4nDqWjrR"; // retired 2026-09-15

const ALL = INITIATE | VOTE | EXECUTE; // mask 7, what every live seat holds today

const member = (key, mask = ALL) => ({ key, mask });
const seat = (role, pubkey) => ({ role, pubkey });

/** The live mainnet shape: 3 of 5, two seats agent-held. */
const MAINNET = {
  threshold: 3,
  members: [SYSTEM, ALEX_TWO, ALEX, ALEX_THREE, ADMIN].map((k) => member(k)),
};
const MAINNET_SEATS = [seat("system", SYSTEM), seat("admin", ADMIN)];

/** The live devnet shape: 3 of 5, three seats agent-held. */
const DEVNET = {
  threshold: 3,
  members: [SYSTEM_DEVNET, ALEX_TWO, ALEX, XAN, ADMIN].map((k) => member(k)),
};
const DEVNET_SEATS = [
  seat("system.devnet", SYSTEM_DEVNET),
  seat("admin", ADMIN),
  seat("xan", XAN),
];

// --- the two live clusters, which are the whole point -----------------------

test("devnet reaches quorum from agent seats alone, so it runs AUTONOMOUS", () => {
  const plan = planUpgrade({ multisig: DEVNET, seats: DEVNET_SEATS });

  assert.equal(plan.mode, "autonomous");
  assert.equal(plan.approvalsAvailable, 3);
  assert.equal(plan.threshold, 3);
  assert.equal(plan.shortfall, 0);
  assert.ok(plan.executor, "an autonomous run needs a seat that can Execute");
  assert.deepEqual(
    plan.voters.map((v) => v.role).sort(),
    ["admin", "system.devnet", "xan"]
  );
});

test("mainnet is one seat short, so the SAME input runs HANDOFF", () => {
  const plan = planUpgrade({ multisig: MAINNET, seats: MAINNET_SEATS });

  assert.equal(plan.mode, "handoff");
  assert.equal(plan.approvalsAvailable, 2);
  assert.equal(plan.threshold, 3);
  assert.equal(plan.shortfall, 1);
  assert.deepEqual(
    plan.outsideVoters.map((m) => m.pubkey).sort(),
    [ALEX_TWO, ALEX, ALEX_THREE].sort(),
    "the handoff is addressed to the operator's three wallets, and names them"
  );
});

test("the mode comes from the COUNT, not from which cluster it is", () => {
  // Same roster, same members, threshold lowered by one: mainnet flips to
  // autonomous. Nothing in this module knows the word "mainnet", which is the
  // property that keeps the two behaviours from needing a flag.
  const plan = planUpgrade({
    multisig: { ...MAINNET, threshold: 2 },
    seats: MAINNET_SEATS,
  });

  assert.equal(plan.mode, "autonomous");
  assert.equal(plan.shortfall, 0);
});

// --- the rotation's residue -------------------------------------------------

test("a roster seat that is no longer a member is dropped, not fatal", () => {
  // The 09:41 rotation removed Xan from mainnet but left him on devnet. A
  // roster offering him to mainnet must still produce a usable plan.
  const plan = planUpgrade({
    multisig: MAINNET,
    seats: [...MAINNET_SEATS, seat("xan", XAN)],
  });

  assert.equal(plan.mode, "handoff");
  assert.deepEqual(plan.unseated.map((s) => s.role), ["xan"]);
  assert.deepEqual(plan.seated.map((s) => s.role).sort(), ["admin", "system"]);
  assert.equal(
    plan.approvalsAvailable,
    2,
    "an unseated key must not be counted toward quorum"
  );
});

test("the same key twice is one seat, not two votes", () => {
  const plan = planUpgrade({
    multisig: MAINNET,
    seats: [seat("system", SYSTEM), seat("system-again", SYSTEM), seat("admin", ADMIN)],
  });

  assert.equal(plan.seated.length, 2);
  assert.equal(plan.approvalsAvailable, 2);
});

test("REFUSES when every candidate key was rotated out — the 09:41 state", () => {
  // This is the defect the whole task exists for: squad-upgrade.js named
  // ALEX_BOT_KEY (Xan) and MASON_KEY (Mason), and both were removed from both
  // multisigs. The refusal must say so, and name what IS seated.
  assert.throws(
    () =>
      planUpgrade({
        multisig: MAINNET,
        seats: [seat("xan", XAN), seat("mason", MASON)],
      }),
    (error) => {
      assert.ok(error instanceof SquadRoleError);
      assert.match(error.message, /is a member of this multisig/);
      assert.match(error.message, /squad-clusters/, "it must name where the roster lives");
      return true;
    }
  );
});

test("REFUSES when no seat can Initiate — nothing could open the transaction", () => {
  assert.throws(
    () =>
      planUpgrade({
        multisig: {
          threshold: 3,
          members: [
            member(SYSTEM, VOTE | EXECUTE),
            member(ADMIN, VOTE | EXECUTE),
            member(ALEX),
            member(ALEX_TWO),
            member(ALEX_THREE),
          ],
        },
        seats: MAINNET_SEATS,
      }),
    (error) => {
      assert.ok(error instanceof SquadRoleError);
      assert.match(error.message, /none can Initiate/);
      return true;
    }
  );
});

test("REFUSES a handoff nobody could finish — that is litter, not a handoff", () => {
  // Two agent seats can vote, threshold 4, and only one other member holds
  // Vote. Creating the proposal would pay rent for a transaction that can never
  // pass and advance the index as if something had happened.
  assert.throws(
    () =>
      planUpgrade({
        multisig: {
          threshold: 4,
          members: [
            member(SYSTEM),
            member(ADMIN),
            member(ALEX),
            member(ALEX_TWO, INITIATE | EXECUTE),
            member(ALEX_THREE, INITIATE | EXECUTE),
          ],
        },
        seats: MAINNET_SEATS,
      }),
    (error) => {
      assert.ok(error instanceof SquadRoleError);
      assert.match(error.message, /quorum is unreachable/);
      assert.match(error.message, /can never pass/);
      return true;
    }
  );
});

test("a seat that cannot Vote still counts as a seat, but not as an approval", () => {
  const plan = planUpgrade({
    multisig: {
      threshold: 2,
      members: [
        member(SYSTEM, INITIATE | EXECUTE), // seated, mute
        member(ADMIN),
        member(ALEX),
        member(ALEX_TWO),
      ],
    },
    seats: MAINNET_SEATS,
  });

  assert.equal(plan.seated.length, 2);
  assert.equal(plan.approvalsAvailable, 1, "only ADMIN can vote");
  assert.equal(plan.mode, "handoff");
  assert.equal(plan.shortfall, 1);
});

test("quorum reached but no Execute seat is a HANDOFF, not an autonomous run", () => {
  // The approvals are there; the last step is not. Executing is a human's,
  // so the run must stop rather than approve and then discover it cannot finish.
  const plan = planUpgrade({
    multisig: {
      threshold: 2,
      members: [
        member(SYSTEM, INITIATE | VOTE),
        member(ADMIN, INITIATE | VOTE),
        member(ALEX),
      ],
    },
    seats: MAINNET_SEATS,
  });

  assert.equal(plan.mode, "handoff");
  assert.equal(plan.shortfall, 0, "no approvals are owed — only the execute is");
  assert.equal(plan.executor, null);
  assert.deepEqual(plan.outsideExecutors.map((m) => m.pubkey), [ALEX]);
});

// --- input the caller can get wrong ----------------------------------------

test("REFUSES a multisig that was not read from chain", () => {
  assert.throws(
    () => planUpgrade({ multisig: { threshold: 3 }, seats: MAINNET_SEATS }),
    /read it from chain/
  );
});

test("REFUSES a threshold that is not a usable quorum", () => {
  assert.throws(
    () => planUpgrade({ multisig: { ...MAINNET, threshold: 0 }, seats: MAINNET_SEATS }),
    /not a usable quorum/
  );
});

test("describeMask names the bits a human needs under pressure", () => {
  assert.equal(describeMask(ALL), "Initiate|Vote|Execute (7)");
  assert.equal(describeMask(INITIATE | EXECUTE), "Initiate|Execute (5)");
  assert.equal(describeMask(0), "none (0)");
});
