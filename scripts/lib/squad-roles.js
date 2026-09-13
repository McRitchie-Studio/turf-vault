/**
 * squad-roles — decide WHO signs each step of a mainnet upgrade, and refuse
 * before anything is spent if the quorum is not actually there.
 *
 * WHY THIS EXISTS (2026-09-13, narrow-bot-squads-permissions).
 * `scripts/squad-upgrade.js` used to approve the upgrade proposal as ALEX BOT:
 *
 *     proposalApprove({ ..., member: alexBot })   // "approve (Alex Bot)"
 *
 * The bot key lives in Heroku config AND on disk. While it holds Vote, a LEAKED
 * BOT KEY PLUS ANY ONE HUMAN KEY reaches the 2-of-3 quorum over the mainnet
 * program's upgrade authority. Mr. McRitchie's decision (activity-8875): the bot
 * loses Vote — mask 5, Initiate|Execute — and BOTH humans approve every upgrade.
 *
 * THE ORDER IS THE POINT. The script half lands FIRST. Granting mask 5 while
 * the script still votes as the bot would ship a documented permission the
 * tooling violates, and the next upgrade would fail at the approve step with
 * the operator holding a buffer and no idea why. So this planner never asks the
 * bot for Vote — under mask 7 (today) or mask 5 (after the ceremony).
 *
 * WHAT THE BOT STILL DOES, and why it is exactly two bits:
 *
 *   Initiate (1)  vaultTransactionCreate — the bot wraps the BPF upgrade ix
 *   Execute  (4)  vaultTransactionExecute — the bot lands the approved tx
 *
 * and it PAYS for everything (fee payer + rent payer), so the humans need no
 * SOL and no tooling beyond their key.
 *
 * THE PROPOSAL IS OPENED BY A HUMAN, deliberately. The vendored Squads IDL
 * (@sqds/multisig 2.1.4) carries no per-instruction permission docs and the
 * Rust program is not vendored here, so whether `proposalCreate` demands
 * Initiate or Vote is NOT SETTLED. A member who holds both cannot be wrong
 * either way, and the humans hold mask 7 — so the question stops deciding
 * anything. If you ever narrow a human's mask, settle it first.
 *
 * The caller hands in the multisig as plain data — members as base58 strings
 * with their on-chain mask — so this file has no network, no SDK and no key
 * material, and its refusals can be graded in CI (scripts/tests/squad-roles.test.js).
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

/** The two bits the bot exercises. Vote is deliberately absent. */
const BOT_MASK_REQUIRED = INITIATE | EXECUTE;

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

function missingBits(mask, required) {
  return BIT_NAMES.filter(([bit]) => required & bit && !(mask & bit)).map(
    ([, name]) => name
  );
}

/**
 * Plan the signers for one upgrade, or throw.
 *
 * @param {{threshold: number, members: Array<{key: string, mask: number}>}} multisig
 *        the ON-CHAIN Multisig account, flattened. Live truth — never squad.json.
 * @param {string} bot     base58 pubkey of the Alex Bot key (creates, pays, executes)
 * @param {string[]} humans base58 pubkeys of the human approvers, in approval order
 * @returns {{transactionCreator: string, creator: string, approvers: string[],
 *            executor: string, approvals: number, threshold: number,
 *            quorumReached: boolean, botMask: number, botMaskRequired: number}}
 */
function planUpgradeSigners({ multisig, bot, humans }) {
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

  const maskOf = (key) => {
    const member = multisig.members.find((m) => m.key === key);
    return member ? Number(member.mask) : null;
  };

  // --- the bot: Initiate + Execute, and NEVER a vote ------------------------
  const botMask = maskOf(bot);
  if (botMask === null) {
    throw new SquadRoleError(
      `bot ${short(
        bot
      )} is not a member of this multisig — it cannot create or execute the upgrade`
    );
  }
  const botMissing = missingBits(botMask, BOT_MASK_REQUIRED);
  if (botMissing.length) {
    throw new SquadRoleError(
      `bot ${short(bot)} holds ${describeMask(
        botMask
      )} but needs ${botMissing.join(" and ")} ` +
        `to create and execute the upgrade (required ${describeMask(
          BOT_MASK_REQUIRED
        )})`
    );
  }

  // --- the approvers: humans only, distinct, members, able to vote ----------
  const approvers = Array.isArray(humans) ? humans.slice() : [];
  approvers.forEach((key, i) => {
    if (key === bot) {
      throw new SquadRoleError(
        `approver ${i + 1} is the bot ${short(
          bot
        )} — the bot must not vote; a leaked bot key plus one human would be quorum`
      );
    }
    if (approvers.indexOf(key) !== i) {
      throw new SquadRoleError(
        `approver ${short(key)} is supplied twice — that is one vote, not two`
      );
    }
    const mask = maskOf(key);
    if (mask === null) {
      throw new SquadRoleError(
        `approver ${short(key)} is not a member of this multisig`
      );
    }
    if (!(mask & VOTE)) {
      throw new SquadRoleError(
        `approver ${short(key)} holds ${describeMask(mask)} and cannot Vote`
      );
    }
  });

  if (approvers.length < threshold) {
    throw new SquadRoleError(
      `${approvers.length} human approver(s) supplied against threshold ${threshold} — ` +
        `the bot no longer votes, so ${threshold} human keys must sign this upgrade`
    );
  }

  // --- who opens the proposal ----------------------------------------------
  // A human, so no ruling on proposalCreate's permission bit can break it.
  const creator = approvers[0];
  const creatorMask = maskOf(creator);
  const creatorMissing = missingBits(creatorMask, INITIATE | VOTE);
  if (creatorMissing.length) {
    throw new SquadRoleError(
      `proposal creator ${short(creator)} holds ${describeMask(
        creatorMask
      )}; it needs ${creatorMissing.join(" and ")} ` +
        "because the Squads program's requirement for proposalCreate is not settled here"
    );
  }

  return {
    transactionCreator: bot,
    creator,
    approvers,
    executor: bot,
    approvals: approvers.length,
    threshold,
    quorumReached: approvers.length >= threshold,
    botMask,
    botMaskRequired: BOT_MASK_REQUIRED,
  };
}

module.exports = {
  SquadRoleError,
  INITIATE,
  VOTE,
  EXECUTE,
  BOT_MASK_REQUIRED,
  describeMask,
  planUpgradeSigners,
};
