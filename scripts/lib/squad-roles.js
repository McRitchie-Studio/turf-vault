/**
 * squad-roles — decide WHO signs each step of a mainnet upgrade, and refuse
 * before anything is spent if the quorum is not actually there.
 *
 * WHY THIS EXISTS. A mainnet upgrade SPENDS before it votes: by the time
 * `proposalApprove` runs, the bot has already paid for ExtendProgram and created
 * the vault transaction, and a buffer is sitting on chain. If a key it needs
 * cannot do what the step asks — a member evicted by a rotation, a mask granted
 * narrower than the tooling uses, an approver who cannot Vote, or simply fewer
 * approvers than the threshold — the run dies mid-ceremony and the operator is
 * left with a half-done upgrade and no way to finish it from where they stand.
 *
 * So `squad-upgrade.js` asks this module first, against the multisig's OWN
 * members, masks and threshold read from chain, and refuses BEFORE the first
 * lamport. It reads the chain and decides nothing on its own.
 *
 * WHO SIGNS WHAT, as the script actually runs it (2026-09-14, unchanged by
 * /tasks/narrow-bot-squads-permissions, which was declined — see below):
 *
 *   Initiate (1)  vaultTransactionCreate and proposalCreate — the bot
 *   Vote     (2)  proposalApprove — the bot AND Mason, two of the three members
 *   Execute  (4)  vaultTransactionExecute — the bot
 *
 * and the bot pays every fee, so an approver needs nothing but their key.
 *
 * THE BOT DELIBERATELY KEEPS Vote. Narrowing it to Initiate|Execute was
 * proposed and DECLINED by Mr. McRitchie: Squads counts approvals only from
 * Vote-holders, so dropping the bot's would leave exactly two voters against
 * threshold 2 — lose either human key and upgrade authority freezes with no
 * quorum left to add a replacement. He chose the spare, accepting that a leaked
 * bot key plus one human key still reaches quorum. Do not re-litigate it here;
 * this module describes what the script does, and requires of the bot exactly
 * the bits the script uses.
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

/** Every bit the bot exercises: it initiates, votes, and executes. */
const BOT_MASK_REQUIRED = INITIATE | VOTE | EXECUTE;

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
 * @param {string} bot       base58 pubkey of the Alex Bot key (creates, pays, executes)
 * @param {string[]} approvers base58 pubkeys casting the approvals, in order. The
 *        bot may be one of them — it holds Vote, by decision.
 * @returns {{transactionCreator: string, creator: string, approvers: string[],
 *            executor: string, approvals: number, threshold: number,
 *            quorumReached: boolean, botMask: number, botMaskRequired: number}}
 */
function planUpgradeSigners({ multisig, bot, approvers: approverKeys }) {
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

  // --- the bot: Initiate + Vote + Execute (BOT_MASK_REQUIRED, :56) ----------
  // Vote is REQUIRED here, not optional: narrowing the bot to Initiate|Execute
  // was proposed and DECLINED (see the header, :26). This check throws without
  // it. Do not "fix" the mask to match a narrower comment.
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

  // --- the approvers: distinct, members, able to vote -----------------------
  const approvers = Array.isArray(approverKeys) ? approverKeys.slice() : [];
  approvers.forEach((key, i) => {
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
      `${approvers.length} approver(s) supplied against threshold ${threshold} — ` +
        `${threshold} keys able to Vote must sign this upgrade`
    );
  }

  // --- who opens the proposal ----------------------------------------------
  // The bot, as the script does it. Whether `proposalCreate` demands Initiate or
  // Vote is NOT settled from the vendored IDL (no per-instruction permission
  // docs) and the Rust program is not vendored here — so this requires BOTH of
  // the bot, which it holds, and the question stops deciding anything. Narrow
  // the bot's mask one day and settle it first.
  const creator = bot;
  const creatorMissing = missingBits(botMask, INITIATE | VOTE);
  if (creatorMissing.length) {
    throw new SquadRoleError(
      `proposal creator ${short(creator)} holds ${describeMask(
        botMask
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
