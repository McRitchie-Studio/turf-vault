/**
 * admin-seat-rotation — the ARGUMENTS, the PLAN and the READ-BACK check for
 * swapping one member of a Squads V4 multisig for another.
 *
 * History. Written 2026-10-08 (task rotate-mainnet-admin-key) for one swap,
 * `BLSBw8…` (`solana.turf.admin`, exposed) out and `4bKN…` in, with both keys
 * hard-coded. Generalised 2026-10-14 (task squad-seat-rotation-any-pair) when
 * `4bKN…` was itself exposed and had to be swapped for `3LTL…`: the pair is now
 * `--old` / `--new`, both REQUIRED. There is no default pair, because a default
 * is the last swap, and re-running the last swap is never what anyone means.
 *
 * The rotation is ONE config transaction: `removeMember(old)` then
 * `addMember(new, <old's live mask>)`, threshold unchanged. Two transactions
 * would stale the second (Squads error 6007), and a split leaves the multisig a
 * seat short in between.
 *
 * Pure data in, pure data out: no SDK, no network, no key material, so every
 * refusal below is graded in scripts/tests/admin-seat-rotation.test.js in CI's
 * guards lane. `scripts/ceremony/rotate-admin-seat.js` flattens the chain's
 * accounts into these shapes and refuses on any problem this file names.
 */

"use strict";

const { MAINNET_FORBIDDEN_SIGNERS, memberName } = require("./squad-clusters");

/**
 * The 2026-10-09 swap, kept as a NAMED record for the two sweep scripts that
 * emptied BLSBw8 afterwards. Nothing in the rotation reads it: it is history,
 * not a default.
 */
const ROTATION_2026_10_09 = Object.freeze({
  old: "BLSBw8fXHzZc5pbaYCKMpMSsrtXBTbWXpUPVzMrXx9oo", // solana.turf.admin, EXPOSED, rotated out
  new: "4bKNSqkrKeggSyrds16Ak7rcB4ibvGJ4ZLsKjvQgC3Vk", // solana.turf.governance
});

/**
 * Keys that must never be ADDED to a Squad: each has sat somewhere it could be
 * read. Rotating one of these back in would undo a rotation. (Removing one is
 * exactly what this tool is for.)
 */
const EXPOSED_KEYS = Object.freeze({
  BLSBw8fXHzZc5pbaYCKMpMSsrtXBTbWXpUPVzMrXx9oo: "solana.turf.admin, in desk env files (rotated out 2026-10-09)",
  "4bKNSqkrKeggSyrds16Ak7rcB4ibvGJ4ZLsKjvQgC3Vk": "solana.turf.governance, printed into a transcript 2026-10-12",
  F6f8h5yynbnkgWvU5abQx3RJxJpe8EoQmeFBuNKdKzhZ: "agent.solana, leaked",
  ...MAINNET_FORBIDDEN_SIGNERS,
});

const INITIATE = 0b001;
const VOTE = 0b010;
const EXECUTE = 0b100;
const ALL_PERMISSIONS = INITIATE | VOTE | EXECUTE;

const STALE_NOTICE =
  "STALE WARNING (Squads error 6007): executing a config transaction sets the multisig's " +
  "staleTransactionIndex to the latest transaction index. Every proposal still open at that " +
  "moment, before OR after this one, becomes stale and can never execute; it must be re-created.";

// --------------------------------------------------------------------------- base58

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Decode base58 to bytes, or null when a character is outside the alphabet. Pure. */
function base58Decode(s) {
  if (typeof s !== "string" || s.length === 0) return null;
  let n = 0n;
  for (const ch of s) {
    const v = B58.indexOf(ch);
    if (v < 0) return null;
    n = n * 58n + BigInt(v);
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const ch of s) {
    if (ch !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/** A Solana public key: base58 that decodes to exactly 32 bytes. */
function pubkeyProblem(label, s) {
  if (s === undefined || s === null || s === "" || s === true) return `${label} <pubkey> is REQUIRED`;
  const bytes = base58Decode(String(s));
  if (!bytes) return `${label} ${JSON.stringify(s)} is not base58`;
  if (bytes.length !== 32) return `${label} ${s} decodes to ${bytes.length} bytes, not 32`;
  return null;
}

// --------------------------------------------------------------------------- args

const VALUE_FLAGS = ["--cluster", "--old", "--new", "--index", "--as", "--and-approve-as"];
const BOOL_FLAGS = ["--send", "--approve", "--execute", "--allow-outgoing-signer"];

/**
 * Parse the ceremony's argv. Takes `--flag=value` and `--flag value`. Every
 * problem is collected, none thrown, so a test can read them all.
 *
 * @param {string[]} argv  process.argv.slice(2)
 * @returns {{cluster, old, new, index, as, andApproveAs, send, allowOutgoing,
 *            mode: "create"|"approve"|"execute", problems: string[]}}
 */
function parseRotationArgs(argv) {
  const problems = [];
  const values = {};
  const bools = {};
  const args = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < args.length; i += 1) {
    const a = String(args[i]);
    const eq = a.indexOf("=");
    const name = eq >= 0 ? a.slice(0, eq) : a;
    if (VALUE_FLAGS.includes(name)) {
      let v = eq >= 0 ? a.slice(eq + 1) : args[i + 1];
      if (eq < 0) {
        if (v === undefined || String(v).startsWith("--")) v = "";
        else i += 1;
      }
      if (name in values) problems.push(`${name} given twice`);
      values[name] = v;
    } else if (BOOL_FLAGS.includes(name) && eq < 0) {
      bools[name] = true;
    } else {
      problems.push(`unknown argument ${JSON.stringify(a)}`);
    }
  }

  const approve = !!bools["--approve"];
  const execute = !!bools["--execute"];
  const mode = execute ? "execute" : approve ? "approve" : "create";
  if (approve && execute) problems.push("--approve and --execute are separate steps; pass one");

  const out = {
    cluster: values["--cluster"],
    old: values["--old"],
    new: values["--new"],
    index: values["--index"],
    as: values["--as"],
    andApproveAs: values["--and-approve-as"],
    send: !!bools["--send"],
    allowOutgoing: !!bools["--allow-outgoing-signer"],
    mode,
    problems,
  };

  for (const [label, key] of [["--old", "old"], ["--new", "new"]]) {
    const p = pubkeyProblem(label, out[key]);
    if (p) problems.push(p);
  }
  if (out.old && out.new && out.old === out.new) problems.push("--old and --new are the same key; nothing to swap");
  if (out.new && EXPOSED_KEYS[out.new]) {
    problems.push(`--new ${out.new} is an exposed or forbidden key (${EXPOSED_KEYS[out.new]}); it is never added`);
  }

  if (mode !== "create" && !/^\d+$/.test(out.index || "")) problems.push(`--${mode} needs --index=<n>`);
  if (mode === "create" && out.index !== undefined) problems.push("create takes no --index: the next index is read from chain");
  if (mode === "approve" && !out.as) problems.push("--approve needs --as=<roster role>, e.g. --as=governance");
  if (mode !== "approve" && out.as !== undefined) problems.push(`--as belongs to --approve, not ${mode}`);
  if (mode !== "create" && out.andApproveAs !== undefined) problems.push("--and-approve-as belongs to create only");
  if (out.andApproveAs === "") problems.push("--and-approve-as needs a roster role");
  if (out.allowOutgoing && mode === "execute") {
    problems.push("--allow-outgoing-signer covers an APPROVAL only; the outgoing key never creates or executes");
  }
  if (out.allowOutgoing && mode === "create" && !out.andApproveAs) {
    problems.push("--allow-outgoing-signer on create only pairs with --and-approve-as=<the outgoing seat's role>");
  }
  return out;
}

// --------------------------------------------------------------------------- plan

/**
 * Validate the swap against LIVE membership before anything is built. The new
 * member gets EXACTLY the old member's live mask; the threshold is untouched.
 *
 * @param {{threshold: number, members: Array<{key: string, mask: number}>}} ms
 * @param {{old: string, new: string}} pair
 * @returns {{problems: string[], threshold: number, mask: number|undefined, before: string[], after: string[]}}
 */
function planRotation(ms, pair) {
  const problems = [];
  const oldKey = pair && pair.old;
  const newKey = pair && pair.new;
  if (!oldKey || !newKey) problems.push("the plan needs both --old and --new");
  const members = (ms && Array.isArray(ms.members) ? ms.members : []).map((m) => ({
    key: String(m.key),
    mask: Number(m.mask),
  }));
  const threshold = Number(ms && ms.threshold);
  const keys = members.map((m) => m.key);
  const old = members.find((m) => m.key === oldKey);

  if (oldKey && !old) problems.push(`the outgoing key ${oldKey} is NOT a member — nothing to rotate`);
  if (old && !(old.mask > 0 && old.mask <= ALL_PERMISSIONS)) {
    problems.push(`the outgoing key holds mask ${old.mask}, which is not a Squads permission set`);
  }
  if (newKey && keys.includes(newKey)) problems.push(`the new key ${newKey} is ALREADY a member — add would fail`);
  if (!Number.isInteger(threshold) || threshold < 1) problems.push(`threshold ${ms && ms.threshold} is not usable`);

  const after = keys.filter((k) => k !== oldKey).concat(old ? [newKey] : []);
  if (Number.isInteger(threshold) && threshold > after.length) {
    problems.push(`threshold ${threshold} exceeds the ${after.length} members left after the swap`);
  }
  return { problems, threshold, mask: old ? old.mask : undefined, before: keys, after };
}

/**
 * The actions the transaction carries, in the order the program applies them.
 * Plain data; the ceremony script maps it onto SDK action objects.
 */
function plannedActions({ old, new: newKey, mask }) {
  return [
    { kind: "RemoveMember", key: old },
    { kind: "AddMember", key: newKey, mask },
  ];
}

/**
 * Compare the actions READ BACK from the on-chain ConfigTransaction with the
 * plan. Approving or executing a config transaction you have not read back is
 * how a multisig gets captured, so any difference — an extra action, a changed
 * threshold, another key, another mask, another order — is a refusal.
 *
 * @param {Array<{kind: string, key?: string, mask?: number, threshold?: number}>} actions
 * @param {{old: string, new: string, mask: number}} plan
 * @returns {string[]} problems; empty means an exact match
 */
function checkReadBack(actions, plan) {
  const want = plannedActions(plan);
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
    else if (w.kind === "AddMember" && Number(g.mask) !== Number(w.mask)) {
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

/**
 * May an agent execute the rotation? Only once the THRESHOLD is met on chain
 * (status Approved and the approvals counted), and on mainnet only once one of
 * Mr. McRitchie's seats has approved: agents queue and vote, he gives the last
 * click, and only then does an agent execute (his ruling of 2026-10-12, the
 * same rule `vault-transfer.js` executeGate enforces for vault transactions).
 *
 * @returns {string[]} problems; empty means execute may proceed
 */
function executeProblems({ cluster, status, approved, threshold, operatorKeys }) {
  const problems = [];
  const got = Array.isArray(approved) ? approved : [];
  if (status === "Executed") problems.push("the proposal is already Executed; nothing to do");
  else if (status !== "Approved") problems.push(`the proposal is ${status}, not Approved; it has not reached threshold`);
  if (got.length < Number(threshold)) {
    problems.push(`${got.length} approval(s) on chain, the threshold is ${threshold}`);
  }
  if (cluster === "mainnet-beta" && !got.some((k) => (operatorKeys || []).includes(k))) {
    problems.push(
      "no approval from Mr. McRitchie's seats is on chain. On mainnet an agent executes only after one of " +
        "his seats has approved; agent votes alone never change the Squad"
    );
  }
  return problems;
}

/**
 * The outgoing key signing. It may cast ONE kind of signature: an APPROVAL of
 * its own removal, and only when the run says so with --allow-outgoing-signer.
 * It never creates, pays for or executes the swap.
 *
 *   - devnet, 2026-10-09 10:50 MDT: no Squads UI reaches devnet for Mr.
 *     McRitchie's wallets, so BLSBw8 cast devnet #19's third vote.
 *   - mainnet, 2026-10-12 / 2026-10-14: agents queue the proposal and cast the
 *     two agent votes, the outgoing seat's among them while it is still a
 *     member; he gives the third with one click.
 *
 * `allowOutgoing` is the flag AS IT APPLIES TO THIS SIGNER: the caller passes
 * false for the creator and the executor, whatever the command line said.
 *
 * @param {{seatPubkey: string, old: string, allowOutgoing: boolean, step: "create"|"approve"|"execute"}} p
 * @returns {string[]} problems; empty means `seatPubkey` may sign this step
 */
function outgoingSignerProblems({ seatPubkey, old, allowOutgoing, step }) {
  if (seatPubkey !== old) {
    return allowOutgoing && step === "approve"
      ? [`--allow-outgoing-signer is for the outgoing seat's vote; ${seatPubkey} is not ${old}`]
      : [];
  }
  if (step === "create") return [`${old} is the key being rotated out; it never creates or pays for its own removal`];
  if (step === "execute") return [`${old} is the key being rotated out; it never executes its own removal`];
  if (!allowOutgoing) return [`${old} is the key being rotated out; its approval needs --allow-outgoing-signer`];
  return [];
}

const OUTGOING_SIGNER_NOTICE =
  "NOTICE: the outgoing key approves its own removal (--allow-outgoing-signer). It creates nothing and executes nothing.";

// --------------------------------------------------------------------------- output

/** "RemoveMember X" style line for one flattened action. */
function describeAction(a) {
  if (a.kind === "RemoveMember") return `- removeMember ${a.key}  (${memberName(a.key)})`;
  if (a.kind === "AddMember") return `+ addMember    ${a.key}  mask ${a.mask}  (${memberName(a.key)})`;
  if (a.kind === "ChangeThreshold") return `~ changeThreshold -> ${a.threshold}`;
  return `? ${a.kind}`;
}

/**
 * The plan block a dry run prints. Pure, so the exact wording is tested.
 *
 * @param {{index: bigint|number, creator: {role: string}, plan: object, pair: {old, new},
 *          open: Array<{index: bigint|number, status: string}>}} p
 * @returns {string[]}
 */
function formatPlan({ index, creator, plan, pair, open }) {
  const out = [];
  out.push(`  PLAN — ONE atomic config transaction at #${index}, creator ${creator.role}:`);
  plannedActions({ old: pair.old, new: pair.new, mask: plan.mask }).forEach((a) => out.push(`    ${describeAction(a)}`));
  out.push(`    the new member gets the outgoing member's mask ${plan.mask}; threshold stays ${plan.threshold}`);
  out.push(`  AFTER (predicted): threshold ${plan.threshold} of ${plan.after.length}`);
  plan.after.forEach((k) => out.push(`    ${k}  ${memberName(k)}`));
  out.push("");
  out.push(`  ${STALE_NOTICE}`);
  const live = Array.isArray(open) ? open : [];
  if (live.length) {
    out.push(`  OPEN NOW — ${live.length} proposal(s) this rotation would stale:`);
    live.forEach((p) => out.push(`    #${p.index}  ${p.status}`));
    out.push("  Land or cancel them first; --send refuses while any is open.");
  } else {
    out.push("  OPEN NOW — none; nothing would be staled if it executed today.");
  }
  return out;
}

/** The on-chain memo: names both keys, so the Squads app shows what it is. */
function rotationMemo({ old, new: newKey }) {
  return `rotate Squad seat ${old.slice(0, 6)} -> ${newKey.slice(0, 6)} (squad-seat-rotation)`;
}

module.exports = {
  ALL_PERMISSIONS,
  EXECUTE,
  EXPOSED_KEYS,
  INITIATE,
  OUTGOING_SIGNER_NOTICE,
  ROTATION_2026_10_09,
  STALE_NOTICE,
  VOTE,
  base58Decode,
  checkReadBack,
  describeAction,
  executeProblems,
  formatPlan,
  outgoingSignerProblems,
  parseRotationArgs,
  planRotation,
  plannedActions,
  proposalProblems,
  pubkeyProblem,
  rotationMemo,
};
