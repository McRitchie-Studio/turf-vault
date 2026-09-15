/**
 * squad-roles — MEASURE the live multisig, then decide whether this run can
 * finish an upgrade by itself or must stop and hand the rest to a human.
 *
 * WHAT CHANGED, AND WHY (2026-09-15). This module used to answer one question —
 * "can the bot and Mason reach quorum?" — and THROW when the answer was no. That
 * was correct while every cluster's multisig was 2-of-3 with two agent-held
 * seats. It stopped being correct at 09:41, when the Squads rotation left the
 * two clusters deliberately ASYMMETRIC:
 *
 *   devnet   7nRuVw3V…   3 of 5, and THREE of the five are agent-held
 *   mainnet  4H3fP3ot…   3 of 5, and TWO of the five are agent-held
 *
 * Devnet is meant to run unattended. Mainnet is meant to need Mr. McRitchie.
 * A module that throws on a short quorum turns the mainnet half of that design
 * into a broken script, so the short quorum is no longer an error — it is a
 * MODE. One script, two behaviours, chosen by counting seats on chain rather
 * than by a flag somebody has to remember to pass.
 *
 *   mode "autonomous"  the agent holds enough Vote seats to reach threshold AND
 *                      an Execute seat — create, propose, approve, execute.
 *   mode "handoff"     it does not — create, propose, cast every approval it
 *                      CAN, then stop and name what is still owed.
 *
 * WHAT IS STILL A REFUSAL, because these are dead ends rather than handoffs:
 *
 *   · no seat at all. Every candidate key was removed from the multisig, which
 *     is exactly the 09:41 state. There is nothing to create WITH.
 *   · no seat that can Initiate. Same: nothing can open the transaction.
 *   · a handoff whose shortfall the remaining members cannot cover. Creating a
 *     proposal that can never pass leaves rent-paying litter on the multisig
 *     and a transaction index that looks like progress.
 *
 * THE CALLER HANDS IN PLAIN DATA — members as base58 strings with their
 * on-chain mask — so this file has no network, no SDK and no key material, and
 * every branch above is graded in scripts/tests/squad-roles.test.js.
 */

"use strict";

/** Permission bits, as @sqds/multisig 2.1.4 defines them. */
const INITIATE = 0b001;
const VOTE = 0b010;
const EXECUTE = 0b100;

/** Refusal raised before any transaction is built, signed or sent. */
class SquadRoleError extends Error {
  constructor(message) {
    super(message);
    this.name = "SquadRoleError";
  }
}

const BIT_NAMES = [
  [INITIATE, "Initiate"],
  [VOTE, "Vote"],
  [EXECUTE, "Execute"],
];

/** "Initiate|Execute (5)" — for messages a human reads under pressure. */
function describeMask(mask) {
  const names = BIT_NAMES.filter(([bit]) => mask & bit).map(([, name]) => name);
  return `${names.length ? names.join("|") : "none"} (${mask})`;
}

function short(key) {
  return typeof key === "string" && key.length > 12
    ? `${key.slice(0, 4)}…${key.slice(-4)}`
    : String(key);
}

/**
 * Classify one upgrade against live membership.
 *
 * @param {{threshold: number, members: Array<{key: string, mask: number}>}} multisig
 *        the ON-CHAIN Multisig account, flattened. Live truth — never squad.json.
 * @param {Array<{role: string, pubkey: string}>} seats
 *        the keys this run can offer. A seat that is not a live member is
 *        reported in `unseated` and dropped; it is NOT an error.
 * @returns {{mode: "autonomous"|"handoff", threshold: number,
 *            seated: Array<{role, pubkey, mask}>, unseated: Array<{role, pubkey}>,
 *            voters: Array<{role, pubkey, mask}>, initiator: {role, pubkey, mask},
 *            executor: {role, pubkey, mask}|null,
 *            approvalsAvailable: number, shortfall: number,
 *            outsideVoters: Array<{pubkey, mask}>, outsideExecutors: Array<{pubkey, mask}>}}
 * @throws  {SquadRoleError}
 */
function planUpgrade({ multisig, seats }) {
  if (!multisig || !Array.isArray(multisig.members)) {
    throw new SquadRoleError(
      "multisig account has no members array — read it from chain before planning"
    );
  }
  const threshold = Number(multisig.threshold);
  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new SquadRoleError(
      `multisig threshold is ${multisig.threshold}, which is not a usable quorum`
    );
  }
  const candidates = Array.isArray(seats) ? seats : [];

  const members = new Map(
    multisig.members.map((m) => [m.key, Number(m.mask)])
  );

  // --- intersect the roster with the chain ---------------------------------
  // A seat that vanished from the multisig is DROPPED, loudly, not fatal. This
  // is the branch the 09:41 rotation needed and the old module did not have.
  const seated = [];
  const unseated = [];
  const claimed = new Set();
  for (const seat of candidates) {
    if (claimed.has(seat.pubkey)) continue; // one key is one seat, however many roles name it
    claimed.add(seat.pubkey);
    const mask = members.get(seat.pubkey);
    if (mask === undefined) unseated.push({ role: seat.role, pubkey: seat.pubkey });
    else seated.push({ role: seat.role, pubkey: seat.pubkey, mask });
  }

  if (seated.length === 0) {
    throw new SquadRoleError(
      `none of this run's ${candidates.length} candidate key(s) is a member of this multisig ` +
        `— it cannot open an upgrade transaction at all.\n` +
        `    offered: ${candidates.map((s) => `${s.role} ${short(s.pubkey)}`).join(", ") || "(none)"}\n` +
        `    live:    ${multisig.members.map((m) => short(m.key)).join(", ")}\n` +
        `    Re-seat a key, or point the roster in scripts/lib/squad-clusters.js at one that is seated.`
    );
  }

  const initiator = seated.find((s) => s.mask & INITIATE);
  if (!initiator) {
    throw new SquadRoleError(
      `this run holds ${seated.length} seat(s) but none can Initiate — ` +
        seated.map((s) => `${s.role} ${short(s.pubkey)} ${describeMask(s.mask)}`).join(", ") +
        `. A vault transaction cannot be opened.`
    );
  }

  const voters = seated.filter((s) => s.mask & VOTE);
  const executor = seated.find((s) => s.mask & EXECUTE) || null;

  const approvalsAvailable = voters.length;
  const shortfall = Math.max(0, threshold - approvalsAvailable);

  // Members nobody here holds a key for — who the handoff is addressed TO.
  const held = new Set(seated.map((s) => s.pubkey));
  const outside = multisig.members
    .filter((m) => !held.has(m.key))
    .map((m) => ({ pubkey: m.key, mask: Number(m.mask) }));
  const outsideVoters = outside.filter((m) => m.mask & VOTE);
  const outsideExecutors = outside.filter((m) => m.mask & EXECUTE);

  const mode = shortfall === 0 && executor ? "autonomous" : "handoff";

  // A handoff nobody can finish is litter, not a handoff. Refuse BEFORE the
  // transaction account is paid for.
  if (mode === "handoff") {
    if (outsideVoters.length < shortfall) {
      throw new SquadRoleError(
        `quorum is unreachable: threshold ${threshold}, this run can cast ${approvalsAvailable} ` +
          `approval(s), and only ${outsideVoters.length} other member(s) can Vote. ` +
          `Creating the proposal would leave a transaction that can never pass.`
      );
    }
    if (!executor && outsideExecutors.length === 0) {
      throw new SquadRoleError(
        `no member of this multisig holds Execute — an approved upgrade could never be executed.`
      );
    }
  }

  return {
    mode,
    threshold,
    seated,
    unseated,
    voters,
    initiator,
    executor,
    approvalsAvailable,
    shortfall,
    outsideVoters,
    outsideExecutors,
  };
}

module.exports = {
  EXECUTE,
  INITIATE,
  SquadRoleError,
  VOTE,
  describeMask,
  planUpgrade,
  short,
};
