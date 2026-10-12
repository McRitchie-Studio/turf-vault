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

/**
 * The index moved since the plan. Was it THIS move? `candidates` are the
 * transactions created since, read back as `{ index, instructions, status }`.
 * Returns the transaction that carries exactly the planned transfer, else null.
 *
 * AN EXECUTED MATCH WINS (2026-10-12, Carl on squad-vault-ops-sop). If the money
 * already moved at one index while an identical proposal is still live at
 * another, the live one is a DUPLICATE: approving it moves the money twice. So
 * the result is `{ index, executed: true, liveDuplicates: [<indexes>] }`, naming
 * the FIRST executed match (where the money left) and every live copy, which the
 * advice says to cancel. Only with no executed match does a live one (Active or
 * Approved) win, as `{ index, executed: false }`: "approve or execute THAT
 * index". Neither ever means "send again".
 */
function findMatchingIndex(candidates, plan) {
  let executed = null;
  let live = null;
  const liveIndexes = [];
  for (const c of candidates) {
    if (!matchesPlan(c.instructions, plan).ok) continue;
    if (c.status === "Executed" && executed === null) executed = BigInt(c.index);
    if (["Active", "Approved"].includes(c.status)) {
      liveIndexes.push(BigInt(c.index));
      if (live === null) live = BigInt(c.index);
    }
  }
  if (executed !== null) return { index: executed, executed: true, liveDuplicates: liveIndexes };
  if (live !== null) return { index: live, executed: false };
  return null;
}

/** What to tell the operator when the index moved: approve the match, report it done, or stop and read. */
function indexMovedAdvice(match, rerunArgs) {
  if (match && match.executed) {
    const done = `this transfer was already executed at #${match.index}. Do NOT send again; verify the balances from chain.`;
    const dupes = match.liveDuplicates || [];
    if (dupes.length === 0) return done;
    const list = dupes.map((i) => `#${i}`).join(", ");
    return (
      `${done}\n   ${list} ${dupes.length === 1 ? "is a live duplicate" : "are live duplicates"} of the same ` +
      `transfer: do NOT approve or execute ${dupes.length === 1 ? "it" : "them"}. Cancel ${list} on the Squads page ` +
      `(reject while Active, cancel once Approved), or it moves the money a second time.`
    );
  }
  if (match) {
    return (
      `transaction #${match.index} already carries exactly this transfer. Do NOT send again; finish it with:\n` +
      `   node scripts/squad-vault-transfer.js approve ${rerunArgs} --index=${match.index}`
    );
  }
  return "no transaction created since the plan carries this transfer. Read the Squads page, then re-plan.";
}

/**
 * The blockhash expired before the network confirmed. The transaction cannot
 * land any more, but it may already have landed. The recovery is to re-run the
 * SAME command: `send` with the same --expect-index refuses if its create landed
 * and names the transaction that carries the move; `approve` casts only the
 * votes still owed; `execute` refuses an Executed proposal. A fresh `plan`
 * would hand out the NEW index, and a send on it creates a second proposal.
 */
function expiredConfirmationAdvice(label, signature, mode) {
  const rerun =
    mode === "send"
      ? "re-run the same send with the same --expect-index; never run plan for a new index"
      : `re-run the same ${mode}`;
  return `${label}: confirmation expired for ${signature}; it may already have landed. To recover, ${rerun}.`;
}

/**
 * The vault must hold the amount BEFORE a proposal exists: a proposal that can
 * never execute is rent-paying litter and an index that looks like progress.
 * `source` is `{ exists, balance }` read from chain (lamports, or token base units).
 */
function checkSourceFunds(plan, source) {
  if (plan.kind === "spl" && !source.exists) {
    throw new TransferError(`the vault has no token account ${plan.source} for mint ${plan.mint}; nothing to send`);
  }
  if (BigInt(source.balance) < plan.amount) {
    throw new TransferError(`the vault holds ${source.balance}, less than the ${plan.amount} planned (base units)`);
  }
}

/**
 * A secret's 64 bytes, from the JSON byte-array or base58 form. Every failure is
 * a FIXED message: a parser's own error quotes the text it choked on, and that
 * text is the secret. `decodeBase58` is injected so this file needs no SDK.
 */
function secretBytesFrom(raw, decodeBase58) {
  const text = String(raw ?? "").trim();
  if (text.startsWith("[")) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (_) {
      throw new TransferError("secret is not a 64-byte JSON array");
    }
    const ok = Array.isArray(parsed) && parsed.length === 64 && parsed.every((b) => Number.isInteger(b) && b >= 0 && b <= 255);
    const bytes = ok ? Uint8Array.from(parsed) : null;
    parsed = null;
    if (!bytes) throw new TransferError("secret is not a 64-byte JSON array");
    return bytes;
  }
  let decoded;
  try {
    decoded = decodeBase58(text);
  } catch (_) {
    throw new TransferError("secret is not a 64-byte base58 string");
  }
  if (!decoded || decoded.length !== 64) throw new TransferError("secret is not a 64-byte base58 string");
  return Uint8Array.from(decoded);
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
  checkSourceFunds,
  describeInstruction,
  executeGate,
  expiredConfirmationAdvice,
  findMatchingIndex,
  formatAmount,
  handoff,
  indexMovedAdvice,
  matchesPlan,
  parseAmount,
  secretBytesFrom,
};
