/**
 * vault-transfer — the decisions behind `scripts/squad-vault-transfer.js`, with
 * no network, no SDK and no key material, so every refusal is graded in
 * `scripts/tests/vault-transfer.test.js` on CI's guards lane.
 *
 * THE PATTERN THIS ENCODES (Steffon's `squad-vault-ops` SOP, 2026-10-12). For a
 * move out of the mainnet Squad vault, an agent creates the vault transaction
 * and its proposal, approves it with the two agent-held seats, and hands
 * Mr. McRitchie ONE link and ONE line. He approves from one of his own seats and
 * may execute. If he does not, the agent executes — and only once his approval
 * is on chain. Two agent votes are never enough on mainnet, even though the
 * Squad's threshold of 3 would accept them plus any third member.
 *
 * Mainnet Squad tx #7 (2026-10-12, 6.2 SOL Bk9s -> HwqC) was the worked
 * example; this lifts its scratch script into a general tool.
 *
 * WHAT IS REFUSED HERE, and why each one is a refusal rather than a warning:
 *
 *   · a send whose expected index is not the live `transaction_index`. Someone
 *     else created a transaction since the plan was read, so a second proposal
 *     for the same move is one keystroke away. Re-plan; never "retry".
 *   · an approval or execute of an index whose on-chain instruction is not
 *     EXACTLY the planned transfer. An approval signs "whatever is at index N",
 *     not what this run computed.
 *   · a mainnet execute without an operator approval on chain.
 *   · a forbidden key on mainnet, whatever it is seated as.
 */

"use strict";

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PE6sTDAZZTF1qTX";

const SOL_DECIMALS = 9;
const SYSTEM_TRANSFER = 2; // SystemInstruction::Transfer, u32 LE
const TOKEN_TRANSFER_CHECKED = 12; // TokenInstruction::TransferChecked, u8

class TransferError extends Error {
  constructor(message) {
    super(message);
    this.name = "TransferError";
  }
}

/**
 * "6.2" with 9 decimals -> 6_200_000_000n. Integer arithmetic only: a float
 * parse of a money amount is how 6.2 SOL becomes 6199999999 lamports.
 */
function parseAmount(text, decimals) {
  const raw = String(text ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    throw new TransferError(`amount ${JSON.stringify(text)} is not a plain positive decimal`);
  }
  const [whole, frac = ""] = raw.split(".");
  if (frac.length > decimals) {
    throw new TransferError(`amount ${raw} has more than ${decimals} decimal places`);
  }
  const base = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
  if (base <= 0n) throw new TransferError("amount must be greater than zero");
  return base;
}

/** 6_200_000_000n, 9 -> "6.2" */
function formatAmount(base, decimals) {
  const unit = 10n ** BigInt(decimals);
  const whole = base / unit;
  const frac = (base % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

function u64le(buf, offset) {
  return buf.readBigUInt64LE(offset);
}

/**
 * Decode one instruction a vault transaction carries, from plain data:
 * `{ programId: string, accounts: string[], data: Buffer|Uint8Array }`.
 */
function describeInstruction(ix) {
  const data = Buffer.from(ix.data);
  if (ix.programId === SYSTEM_PROGRAM && data.length === 12 && data.readUInt32LE(0) === SYSTEM_TRANSFER) {
    return {
      kind: "sol",
      from: ix.accounts[0],
      to: ix.accounts[1],
      amount: u64le(data, 4),
      decimals: SOL_DECIMALS,
      accountCount: ix.accounts.length,
    };
  }
  if (ix.programId === TOKEN_PROGRAM && data.length === 10 && data[0] === TOKEN_TRANSFER_CHECKED) {
    return {
      kind: "spl",
      source: ix.accounts[0],
      mint: ix.accounts[1],
      destination: ix.accounts[2],
      authority: ix.accounts[3],
      amount: u64le(data, 1),
      decimals: data[9],
      accountCount: ix.accounts.length,
    };
  }
  return { kind: "other", programId: ix.programId, data: data.toString("hex") };
}

/**
 * Does the vault transaction on chain carry EXACTLY the planned move — one
 * instruction, the right program, source, destination, mint and amount?
 *
 * `plan` is `{ kind: "sol", vault, to, amount }` or
 * `{ kind: "spl", vault, mint, source, destination, amount, decimals }`.
 * Returns `{ ok, reasons }`; an empty `reasons` is the only pass.
 */
function matchesPlan(instructions, plan) {
  const reasons = [];
  if (!Array.isArray(instructions) || instructions.length !== 1) {
    reasons.push(`expected exactly 1 instruction, found ${instructions ? instructions.length : 0}`);
    return { ok: false, reasons };
  }
  const got = describeInstruction(instructions[0]);
  if (got.kind !== plan.kind) {
    reasons.push(`instruction is ${got.kind}, plan is ${plan.kind}`);
    return { ok: false, reasons };
  }
  const want = (label, a, b) => {
    if (a !== b) reasons.push(`${label}: on chain ${a}, planned ${b}`);
  };
  if (plan.kind === "sol") {
    want("from", got.from, plan.vault);
    want("to", got.to, plan.to);
    want("accounts", got.accountCount, 2);
  } else {
    want("source", got.source, plan.source);
    want("mint", got.mint, plan.mint);
    want("destination", got.destination, plan.destination);
    want("authority", got.authority, plan.vault);
    want("decimals", got.decimals, plan.decimals);
    want("accounts", got.accountCount, 4);
  }
  if (got.amount !== plan.amount) reasons.push(`amount: on chain ${got.amount}, planned ${plan.amount}`);
  return { ok: reasons.length === 0, reasons };
}

/**
 * The duplicate-proposal guard. `send` must name the `transaction_index` the
 * plan read; if the chain has moved, someone created a transaction since.
 */
function checkExpectedIndex(current, expected) {
  if (expected === null || expected === undefined || expected === "") {
    throw new TransferError(
      `send needs --expect-index=<the multisig's current transaction_index> (now ${current}). ` +
        `Run plan first: it reads the index, so a second proposal for the same move cannot slip in.`
    );
  }
  let want;
  try {
    want = BigInt(expected);
  } catch (_) {
    throw new TransferError(`--expect-index=${expected} is not an integer`);
  }
  if (BigInt(current) !== want) {
    throw new TransferError(
      `the multisig's transaction_index is ${current}, not ${want}: a transaction was created since ` +
        `the plan. Read it on the Squads page before anything else — it may be this same transfer.`
    );
  }
  return BigInt(current) + 1n;
}

/** Refuse a forbidden key on mainnet, whatever it is seated as. */
function assertSignerAllowed(pubkey, cluster, forbidden) {
  if (cluster === "mainnet-beta" && Object.prototype.hasOwnProperty.call(forbidden, pubkey)) {
    throw new TransferError(`${pubkey} (${forbidden[pubkey]}) never signs on mainnet. Refusing.`);
  }
}

/** Agent seats that are live voters and have not yet approved. */
function approvalsOwed(approved, seats, members) {
  const done = new Set(approved);
  const voters = new Set(members.filter((m) => (m.mask & 0b010) !== 0).map((m) => m.key));
  return seats.filter((seat) => voters.has(seat.pubkey) && !done.has(seat.pubkey));
}

/**
 * May an agent execute this proposal? On mainnet only once an operator seat's
 * approval is on chain. The threshold is the Squads program's rule; this one is
 * ours, and it is stricter on purpose.
 */
function executeGate({ cluster, status, approved, operatorKeys }) {
  if (status === "Executed") {
    throw new TransferError("the proposal is already Executed; nothing to do");
  }
  if (status !== "Approved") {
    throw new TransferError(`the proposal is ${status}, not Approved; it has not reached threshold`);
  }
  const operatorApprovals = approved.filter((k) => operatorKeys.includes(k));
  if (cluster === "mainnet-beta" && operatorApprovals.length === 0) {
    throw new TransferError(
      "no approval from Mr. McRitchie's seats is on chain. On mainnet an agent executes only after " +
        "one of his seats has approved; agent votes alone never move the vault. Refusing."
    );
  }
  return { operatorApprovals };
}

/** The hand-back: one link, one line. */
function handoff({ url, index, plan, symbol, approvedBy, operatorNames }) {
  const amount = `${formatAmount(plan.amount, plan.kind === "sol" ? SOL_DECIMALS : plan.decimals)} ${symbol}`;
  const to = plan.kind === "sol" ? plan.to : `${plan.destinationOwner} (token account ${plan.destination})`;
  return [
    url,
    `Squad tx #${index}: send ${amount} from the vault ${plan.vault} to ${to}. ` +
      `Approved by ${approvedBy.join(" + ")}; approve from ${operatorNames.join(", ")}, then execute it ` +
      `or tell me to.`,
  ];
}

module.exports = {
  SOL_DECIMALS,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  TransferError,
  approvalsOwed,
  assertSignerAllowed,
  checkExpectedIndex,
  describeInstruction,
  executeGate,
  formatAmount,
  handoff,
  matchesPlan,
  parseAmount,
};
