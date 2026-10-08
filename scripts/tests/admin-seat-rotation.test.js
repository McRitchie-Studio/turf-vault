/**
 * Regression suite for scripts/lib/admin-seat-rotation.js — the plan and the
 * read-back check behind scripts/ceremony/rotate-admin-seat.js.
 *
 * Pure node stdlib, so it runs in CI's guards lane.   npm run test:scripts
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  NEW_SEAT,
  OLD_SEAT,
  SEAT_MASK,
  checkReadBack,
  planRotation,
  plannedActions,
  proposalProblems,
  refuseOldSigner,
} = require("../lib/admin-seat-rotation");

const SYSTEM = "7auwTLSvNniSUeAgL6v9RStMXJhWrrUhSJgwFWLpcqC";
const ALEX = "7ZDJp7FUHhuceAqcW9CHe81hCiaMTjgWAXfprBM59Tcr";
const ALEX_TWO = "3Qj4v9qjhXgkru6zCRCErRVhy8Q6qU3NrNpvpXLTZboA";
const ALEX_THREE = "9gACbzsCLmkYF9Yx1EBGmwMvvyfuTquJ6qs8QsoQvHXf";
const m = (key, mask = 7) => ({ key, mask });

// Mainnet 4H3fP3ot…, read 2026-10-08 before the rotation.
const MAINNET_BEFORE = { threshold: 3, members: [m(SYSTEM), m(ALEX_TWO), m(ALEX), m(ALEX_THREE), m(OLD_SEAT)] };

test("today's mainnet plans cleanly: same count, same threshold, old out, new in", () => {
  const plan = planRotation(MAINNET_BEFORE);
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.threshold, 3);
  assert.equal(plan.after.length, plan.before.length);
  assert.ok(plan.after.includes(NEW_SEAT));
  assert.ok(!plan.after.includes(OLD_SEAT));
});

test("a re-run after the rotation REFUSES rather than half-applying", () => {
  const done = { threshold: 3, members: [m(SYSTEM), m(ALEX_TWO), m(ALEX), m(ALEX_THREE), m(NEW_SEAT)] };
  const { problems } = planRotation(done);
  assert.ok(problems.some((p) => /NOT a member/.test(p)));
  assert.ok(problems.some((p) => /ALREADY a member/.test(p)));
});

test("the plan refuses when the exposed key holds a mask other than the one it grants", () => {
  const odd = { threshold: 3, members: [m(SYSTEM), m(ALEX_TWO), m(ALEX), m(ALEX_THREE), m(OLD_SEAT, 3)] };
  assert.ok(planRotation(odd).problems.some((p) => /mask 3/.test(p)));
});

test("the transaction is ONE remove then ONE add at mask 7, and nothing else", () => {
  assert.deepEqual(plannedActions(), [
    { kind: "RemoveMember", key: OLD_SEAT },
    { kind: "AddMember", key: NEW_SEAT, mask: SEAT_MASK },
  ]);
  assert.ok(!plannedActions().some((a) => a.kind === "ChangeThreshold"), "the threshold is unchanged");
});

test("read-back: an exact match passes; every drift refuses", () => {
  assert.deepEqual(checkReadBack(plannedActions()), []);

  const extra = [...plannedActions(), { kind: "ChangeThreshold", threshold: 1 }];
  assert.ok(checkReadBack(extra).some((p) => /extra action/.test(p)));

  const wrongKey = [{ kind: "RemoveMember", key: OLD_SEAT }, { kind: "AddMember", key: SYSTEM, mask: 7 }];
  assert.ok(checkReadBack(wrongKey).some((p) => /names/.test(p)));

  const wrongMask = [{ kind: "RemoveMember", key: OLD_SEAT }, { kind: "AddMember", key: NEW_SEAT, mask: 1 }];
  assert.ok(checkReadBack(wrongMask).some((p) => /mask 1/.test(p)));

  const removesAlex = [{ kind: "RemoveMember", key: ALEX }, { kind: "AddMember", key: NEW_SEAT, mask: 7 }];
  assert.ok(checkReadBack(removesAlex).length > 0);

  assert.ok(checkReadBack([plannedActions()[1]]).length > 0, "an add without its remove refuses");
  assert.ok(checkReadBack([]).length > 0);
});

test("a stale or wrong-status proposal refuses; the devnet #17 shape is stale", () => {
  // Devnet #17 (2026-09-15) reads Active with staleTransactionIndex 18.
  assert.ok(proposalProblems({ index: 17, staleTransactionIndex: 18, status: "Active" }).some((p) => /stale/.test(p)));
  assert.deepEqual(proposalProblems({ index: 19, staleTransactionIndex: 18, status: "Active", want: "Active" }), []);
  assert.ok(proposalProblems({ index: 6, staleTransactionIndex: 4, status: "Active", want: "Approved" }).length === 1);
});

test("the exposed key never signs", () => {
  assert.equal(refuseOldSigner(OLD_SEAT).length, 1);
  assert.deepEqual(refuseOldSigner(SYSTEM), []);
});
