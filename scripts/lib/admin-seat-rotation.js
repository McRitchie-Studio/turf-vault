/**
 * admin-seat-rotation — the PLAN and the READ-BACK check for rotating the
 * exposed agent admin seat out of a Squads V4 multisig (2026-10-08, task
 * rotate-mainnet-admin-key).
 *
 * `BLSBw8…` (`solana.turf.admin`) sat in local env files on many desks. It is a
 * mask-7 member of BOTH multisigs. The rotation is ONE config transaction per
 * cluster: `removeMember(BLSBw8…)` then `addMember(4bKN…, mask 7)`, threshold
 * unchanged. Two transactions would stale the second (Squads error 6007), and a
 * split leaves the multisig a seat short in between.
 *
 * Pure data in, pure data out: no SDK, no network, no key material, so every
 * refusal below is graded in scripts/tests/admin-seat-rotation.test.js in CI's
 * guards lane. `scripts/ceremony/rotate-admin-seat.js` flattens the chain's
 * accounts into these shapes and refuses on any problem this file names.
 */

"use strict";

const OLD_SEAT = "BLSBw8fXHzZc5pbaYCKMpMSsrtXBTbWXpUPVzMrXx9oo"; // solana.turf.admin, EXPOSED
const NEW_SEAT = "4bKNSqkrKeggSyrds16Ak7rcB4ibvGJ4ZLsKjvQgC3Vk"; // solana.turf.governance
const SEAT_MASK = 7; // Initiate|Vote|Execute — what OLD_SEAT holds on both clusters

/**
 * Validate the swap against LIVE membership before anything is built.
 *
 * @param {{threshold: number, members: Array<{key: string, mask: number}>}} ms
 * @returns {{problems: string[], threshold: number, before: string[], after: string[]}}
 */
function planRotation(ms) {
  const problems = [];
  const members = (ms && Array.isArray(ms.members) ? ms.members : []).map((m) => ({
    key: String(m.key),
    mask: Number(m.mask),
  }));
  const threshold = Number(ms && ms.threshold);
  const keys = members.map((m) => m.key);
  const old = members.find((m) => m.key === OLD_SEAT);

  if (!old) problems.push(`the exposed key ${OLD_SEAT} is NOT a member — nothing to rotate`);
  else if (old.mask !== SEAT_MASK) {
    problems.push(`the exposed key holds mask ${old.mask}, not ${SEAT_MASK} — the plan grants ${SEAT_MASK}; re-plan`);
  }
  if (keys.includes(NEW_SEAT)) problems.push(`the new key ${NEW_SEAT} is ALREADY a member — add would fail`);
  if (!Number.isInteger(threshold) || threshold < 1) problems.push(`threshold ${ms && ms.threshold} is not usable`);

  const after = keys.filter((k) => k !== OLD_SEAT).concat(old ? [NEW_SEAT] : []);
  if (Number.isInteger(threshold) && threshold > after.length) {
    problems.push(`threshold ${threshold} exceeds the ${after.length} members left after the swap`);
  }
  return { problems, threshold, before: keys, after };
}

/**
 * The actions the transaction carries, in the order the program applies them.
 * Plain data; the ceremony script maps it onto SDK action objects.
 */
function plannedActions() {
  return [
    { kind: "RemoveMember", key: OLD_SEAT },
    { kind: "AddMember", key: NEW_SEAT, mask: SEAT_MASK },
  ];
}

/**
 * Compare the actions READ BACK from the on-chain ConfigTransaction with the
 * plan. Approving or executing a config transaction you have not read back is
 * how a multisig gets captured, so any difference — an extra action, a changed
 * threshold, another key, another mask, another order — is a refusal.
 *
 * @param {Array<{kind: string, key?: string, mask?: number, threshold?: number}>} actions
 * @returns {string[]} problems; empty means an exact match
 */
function checkReadBack(actions) {
  const want = plannedActions();
  const got = Array.isArray(actions) ? actions : [];
  const problems = [];
  if (got.length !== want.length) {
    problems.push(`${got.length} action(s) on chain, the plan has ${want.length}`);
  }
  want.forEach((w, i) => {
    const g = got[i];
    if (!g) return;
    if (g.kind !== w.kind) problems.push(`action ${i + 1} is ${g.kind}, the plan has ${w.kind}`);
    else if (g.key !== w.key) problems.push(`action ${i + 1} ${g.kind} names ${g.key}, the plan names ${w.key}`);
    else if (w.kind === "AddMember" && Number(g.mask) !== w.mask) {
      problems.push(`action ${i + 1} grants mask ${g.mask}, the plan grants ${w.mask}`);
    }
  });
  got.slice(want.length).forEach((g, j) => problems.push(`unexpected extra action ${want.length + j + 1}: ${g.kind}`));
  return problems;
}

/**
 * Whether a proposal at `index` can still move. Squads V4 refuses to approve or
 * execute a config proposal at or below the multisig's staleTransactionIndex;
 * one stale on arrival is litter, not a vote.
 */
function proposalProblems({ index, staleTransactionIndex, status, want }) {
  const problems = [];
  if (BigInt(index) <= BigInt(staleTransactionIndex)) {
    problems.push(`index ${index} is stale (staleTransactionIndex ${staleTransactionIndex}) — it can never execute`);
  }
  if (want && status !== want) problems.push(`proposal is ${status}, this step needs ${want}`);
  return problems;
}

/** A key that must never sign anything in this ceremony. */
function refuseOldSigner(pubkey) {
  return pubkey === OLD_SEAT ? [`${OLD_SEAT} is the key being rotated out; it never signs its own removal`] : [];
}

module.exports = {
  NEW_SEAT,
  OLD_SEAT,
  SEAT_MASK,
  checkReadBack,
  planRotation,
  plannedActions,
  proposalProblems,
  refuseOldSigner,
};
