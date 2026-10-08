#!/usr/bin/env node
/**
 * CEREMONY — rotate the exposed agent admin seat out of a Squads V4 multisig.
 * 2026-10-08, task rotate-mainnet-admin-key. Modeled on squad-membership.js.
 *
 * ONE atomic config transaction per cluster:
 *     removeMember(BLSBw8…)  +  addMember(4bKN…, mask 7)      threshold unchanged
 * BLSBw8 (`solana.turf.admin`) NEVER signs anything here. The clean agent seat
 * of the cluster (`system` on mainnet, `system.devnet` on devnet) creates, pays
 * rent, approves once and — after the humans' approvals — executes.
 *
 * DRY RUN BY DEFAULT, in every mode. --send arms it. --cluster is REQUIRED.
 *
 *   node scripts/ceremony/rotate-admin-seat.js --cluster=devnet               # plan, read-only
 *   node scripts/ceremony/rotate-admin-seat.js --cluster=devnet --send        # create + propose + 1 vote
 *   node scripts/ceremony/rotate-admin-seat.js --cluster=devnet --approve --index=19 --as=xan [--send]
 *   node scripts/ceremony/rotate-admin-seat.js --cluster=devnet --execute --index=19 [--send]
 *
 * Every mode re-reads the on-chain ConfigTransaction and refuses unless its
 * actions are EXACTLY the plan (scripts/lib/admin-seat-rotation.js). Keys come
 * from 1Password at run time, per seat vault (squad-clusters.js
 * seatSecretSource), never from argv and never to disk; only public addresses
 * are printed.
 *
 * Like the 2026-09-15 scripts beside it, this one refuses on the chain it
 * leaves behind: once executed, BLSBw8 is not a member and every mode says so.
 */
"use strict";

const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } = require("@solana/web3.js");
const multisig = require("@sqds/multisig");
const bs58m = require("bs58");
const { execFileSync } = require("child_process");

const { memberName, resolveCluster, seatSecretSource } = require("../lib/squad-clusters");
const R = require("../lib/admin-seat-rotation");

const bs58 = bs58m.default || bs58m;

// The multisigs this ceremony may touch — a cross-check on squad.json.
const EXPECTED_MULTISIG = {
  "mainnet-beta": "4H3fP3otjMtupk1DQDjKXYY1dWjT6LNM4H4ZWZ1XcKSX",
  devnet: "7nRuVw3VZFC6z85tYVDitPnaUHZCkqLpJRSTBNtPmtZB",
};
const CREATOR_ROLE = { "mainnet-beta": "system", devnet: "system.devnet" };
// Rent for a two-action ConfigTransaction plus a Proposal is ~0.004 SOL; keep headroom.
const MIN_LAMPORTS = { create: 0.02 * LAMPORTS_PER_SOL, vote: 0.001 * LAMPORTS_PER_SOL };
const MEMO = "rotate exposed admin seat BLSBw8 -> 4bKN (rotate-mainnet-admin-key)";
const VOTE = 0b010;
const EXECUTE = 0b100;
const INITIATE = 0b001;

// --------------------------------------------------------------------------- args
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const value = (n) => (argv.find((a) => a.startsWith(`${n}=`)) || "").split("=")[1];
const SEND = flag("--send");
const MODE = flag("--execute") && flag("--approve") ? "both" : flag("--execute") ? "execute" : flag("--approve") ? "approve" : "create";

function fail(msg, code = 1) {
  console.error(`\nREFUSED — ${msg}`);
  process.exit(code);
}
if (MODE === "both") fail("--approve and --execute are separate steps; pass one.", 2);
const indexArg = value("--index");
if (MODE !== "create" && !/^\d+$/.test(indexArg || "")) fail(`--${MODE} needs --index=<n>.`, 2);
if (MODE === "create" && indexArg) fail("create takes no --index: the next index is read from chain.", 2);
if (MODE === "approve" && !value("--as")) fail("--approve needs --as=<roster role>, e.g. --as=xan.", 2);

let cfg;
try {
  cfg = resolveCluster(value("--cluster"));
} catch (e) {
  fail(e.message, 2);
}
if (cfg.multisigPda !== EXPECTED_MULTISIG[cfg.cluster]) {
  fail(`squad.json names multisig ${cfg.multisigPda} for ${cfg.cluster}; this ceremony expects ${EXPECTED_MULTISIG[cfg.cluster]}.`, 2);
}

// --------------------------------------------------------------------------- helpers
async function settle(label, probe, tries = 40, delayMs = 1500) {
  for (let i = 0; i < tries; i += 1) {
    try {
      if (await probe()) return;
    } catch (_) {
      /* not visible yet, or a 429: both mean "not yet" */
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function loadSeat(seat) {
  const old = R.refuseOldSigner(seat.pubkey);
  if (old.length) throw new Error(old[0]);
  const spec = seatSecretSource(seat);
  let raw;
  try {
    raw = execFileSync("op", ["read", spec.ref], { encoding: "utf8", env: spec.childEnv, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    throw new Error(`could not read ${spec.ref} — ${(e.stderr || "").toString().trim().split("\n")[0] || e.message}`);
  }
  const text = raw.trim();
  const secret = text.startsWith("[") ? Uint8Array.from(JSON.parse(text)) : bs58.decode(text);
  if (secret.length !== 64) throw new Error(`${spec.ref} did not parse as a 64-byte secret key`);
  const kp = Keypair.fromSecretKey(secret);
  if (kp.publicKey.toBase58() !== seat.pubkey) {
    throw new Error(`${spec.ref} does not derive to ${seat.role}'s recorded key ${seat.pubkey}. Refusing.`);
  }
  return kp;
}

const flatMembers = (ms) => ms.members.map((m) => ({ key: m.key.toBase58(), mask: Number(m.permissions.mask) }));
const big = (n) => BigInt(n.toString());

function flatActions(actions) {
  return actions.map((a) => {
    if (a.__kind === "AddMember") return { kind: a.__kind, key: a.newMember.key.toBase58(), mask: Number(a.newMember.permissions.mask) };
    if (a.__kind === "RemoveMember") return { kind: a.__kind, key: a.oldMember.toBase58() };
    if (a.__kind === "ChangeThreshold") return { kind: a.__kind, threshold: Number(a.newThreshold) };
    return { kind: a.__kind };
  });
}

function describeAction(a) {
  if (a.kind === "RemoveMember") return `- removeMember ${a.key}  (${memberName(a.key)})`;
  if (a.kind === "AddMember") return `+ addMember    ${a.key}  mask ${a.mask}  (${memberName(a.key)})`;
  if (a.kind === "ChangeThreshold") return `~ changeThreshold -> ${a.threshold}`;
  return `? ${a.kind}`;
}

async function readIndex(conn, msPda, index) {
  const [txPda] = multisig.getTransactionPda({ multisigPda: msPda, index });
  const [prPda] = multisig.getProposalPda({ multisigPda: msPda, transactionIndex: index });
  const tx = (await conn.getAccountInfo(txPda)) ? await multisig.accounts.ConfigTransaction.fromAccountAddress(conn, txPda) : null;
  const pr = (await conn.getAccountInfo(prPda)) ? await multisig.accounts.Proposal.fromAccountAddress(conn, prPda) : null;
  return { txPda, prPda, tx, pr };
}

function printProposal(pr, threshold) {
  if (!pr) return console.log("  proposal: (none)");
  const approved = pr.approved.map((k) => k.toBase58());
  console.log(`  proposal: ${pr.status.__kind}   approvals ${approved.length}/${threshold}`);
  approved.forEach((k) => console.log(`    approved by ${k}  (${memberName(k)})`));
}

async function balanceGate(conn, seat, need, armed) {
  const lamports = await conn.getBalance(new PublicKey(seat.pubkey), "confirmed");
  const sol = (x) => (x / LAMPORTS_PER_SOL).toFixed(6);
  console.log(`  fee payer ${seat.role} ${seat.pubkey}: ${sol(lamports)} SOL (needs >= ${sol(need)})`);
  if (lamports < need) {
    const msg = `fee payer ${seat.role} holds ${sol(lamports)} SOL, short by ${sol(need - lamports)} SOL. Fund ${seat.pubkey}.`;
    if (armed) fail(msg);
    console.log(`  ⚠ ${msg}`);
  }
}

function readBackOrFail(tx, label) {
  if (!tx) fail(`no config transaction at ${label}.`);
  const actions = flatActions(tx.actions);
  console.log(`\n  on-chain actions at ${label} (read back):`);
  actions.forEach((a) => console.log(`    ${describeAction(a)}`));
  const problems = R.checkReadBack(actions);
  if (problems.length) fail(`on-chain actions differ from the plan:\n  - ${problems.join("\n  - ")}`);
  console.log("  ✓ exactly the plan: one remove, one add at mask 7, threshold untouched");
}

// --------------------------------------------------------------------------- main
(async () => {
  const conn = new Connection(cfg.rpcUrl, "confirmed");
  const genesis = await conn.getGenesisHash();
  if (genesis !== cfg.genesisHash) fail(`${cfg.cluster} genesis mismatch (got ${genesis}).`, 2);

  const msPda = new PublicKey(cfg.multisigPda);
  const ms = await multisig.accounts.Multisig.fromAccountAddress(conn, msPda);
  const members = flatMembers(ms);
  const txIndex = big(ms.transactionIndex);
  const stale = big(ms.staleTransactionIndex);

  console.log(`\n${cfg.cluster.toUpperCase()}  multisig ${cfg.multisigPda}   genesis OK   mode ${MODE}${SEND ? "  ARMED (--send)" : "  dry run"}`);
  console.log(`  threshold ${ms.threshold} of ${members.length}   txIndex ${txIndex}   staleTransactionIndex ${stale}`);
  members.forEach((m) => console.log(`    mask ${m.mask}  ${m.key}  ${memberName(m.key)}`));

  const liveMask = (k) => (members.find((m) => m.key === k) || {}).mask;
  const creator = cfg.agentSeats.find((s) => s.role === CREATOR_ROLE[cfg.cluster]);
  if (!creator) fail(`no ${CREATOR_ROLE[cfg.cluster]} seat in the roster.`);
  const cMask = liveMask(creator.pubkey);
  if (cMask === undefined) fail(`${creator.role} ${creator.pubkey} is not a live member.`);

  // ============================================================== create
  if (MODE === "create") {
    if ((cMask & (INITIATE | VOTE)) !== (INITIATE | VOTE)) fail(`${creator.role} cannot Initiate and Vote (mask ${cMask}).`);
    const plan = R.planRotation({ threshold: ms.threshold, members });
    if (plan.problems.length) fail(`plan does not match live state:\n  - ${plan.problems.join("\n  - ")}`);

    // An open, non-stale proposal must be landed or cancelled first.
    for (let i = stale + 1n; i <= txIndex; i += 1n) {
      const { pr } = await readIndex(conn, msPda, i);
      if (pr && ["Draft", "Active", "Approved", "Executing"].includes(pr.status.__kind)) {
        fail(`proposal #${i} is ${pr.status.__kind} and not stale — land or cancel it first.`);
      }
    }
    const index = txIndex + 1n;
    if ((await readIndex(conn, msPda, index)).tx) fail(`a transaction already exists at #${index}.`);

    console.log(`\n  PLAN — ONE atomic config transaction at #${index}, creator ${creator.role}:`);
    R.plannedActions().forEach((a) => console.log(`    ${describeAction(a)}`));
    console.log(`    threshold stays ${ms.threshold}`);
    console.log(`  AFTER (predicted): threshold ${ms.threshold} of ${plan.after.length}`);
    plan.after.forEach((k) => console.log(`    ${k}  ${memberName(k)}`));
    await balanceGate(conn, creator, MIN_LAMPORTS.create, SEND);
    if (!SEND) return console.log("\n  DRY RUN — nothing sent. Re-run with --send to create, propose and cast one vote.\n");

    const kp = loadSeat(creator);
    console.log(`  ${creator.role} key loaded and verified`);
    const allPerm = multisig.types.Permissions.all();
    if (Number(allPerm.mask) !== R.SEAT_MASK) fail(`SDK Permissions.all() is mask ${allPerm.mask}, not ${R.SEAT_MASK}.`);
    const actions = [
      { __kind: "RemoveMember", oldMember: new PublicKey(R.OLD_SEAT) },
      { __kind: "AddMember", newMember: { key: new PublicKey(R.NEW_SEAT), permissions: allPerm } },
    ];
    const common = { connection: conn, multisigPda: msPda, transactionIndex: index, sendOptions: { skipPreflight: false } };

    let sig = await multisig.rpc.configTransactionCreate({
      ...common, feePayer: kp, creator: kp.publicKey, rentPayer: kp.publicKey, actions, memo: MEMO,
    });
    console.log(`   1/3 configTransactionCreate  ${sig}`);
    await settle("config transaction account", async () => !!(await readIndex(conn, msPda, index)).tx);
    readBackOrFail((await readIndex(conn, msPda, index)).tx, `#${index}`);

    sig = await multisig.rpc.proposalCreate({ ...common, feePayer: kp, creator: kp });
    console.log(`   2/3 proposalCreate           ${sig}`);
    await settle("proposal to read Active", async () => {
      const { pr } = await readIndex(conn, msPda, index);
      return pr && pr.status.__kind === "Active";
    });

    sig = await multisig.rpc.proposalApprove({ ...common, feePayer: kp, member: kp });
    console.log(`   3/3 approve (${creator.role})     ${sig}`);
    await settle(`${creator.role}'s approval`, async () => {
      const { pr } = await readIndex(conn, msPda, index);
      return pr && pr.approved.some((k) => k.toBase58() === creator.pubkey);
    });

    const after = await readIndex(conn, msPda, index);
    readBackOrFail(after.tx, `#${index}`);
    printProposal(after.pr, ms.threshold);
    console.log(`\n  TRANSACTION INDEX ${index} on ${cfg.cluster}. Nothing executed.\n`);
    return;
  }

  // ============================================================== approve / execute
  const index = BigInt(indexArg);
  const { tx, pr } = await readIndex(conn, msPda, index);
  readBackOrFail(tx, `#${index}`);
  printProposal(pr, ms.threshold);
  if (!pr) fail(`no proposal at #${index}.`);
  const plan = R.planRotation({ threshold: ms.threshold, members });
  if (plan.problems.length) fail(`live membership no longer matches the plan:\n  - ${plan.problems.join("\n  - ")}`);

  if (MODE === "approve") {
    const seat = cfg.agentSeats.find((s) => s.role === value("--as"));
    if (!seat) fail(`no seat with role ${value("--as")} on ${cfg.cluster}.`);
    const old = R.refuseOldSigner(seat.pubkey);
    if (old.length) fail(old[0]);
    const mask = liveMask(seat.pubkey);
    if (mask === undefined || !(mask & VOTE)) fail(`${seat.role} ${seat.pubkey} is not a live member with Vote.`);
    const pp = R.proposalProblems({ index, staleTransactionIndex: stale, status: pr.status.__kind, want: "Active" });
    if (pp.length) fail(pp.join("; "));
    if (pr.approved.some((k) => k.toBase58() === seat.pubkey)) {
      console.log(`\n  ${seat.role} has already approved #${index}; nothing to do.\n`);
      return;
    }
    await balanceGate(conn, seat, MIN_LAMPORTS.vote, SEND);
    if (!SEND) return console.log(`\n  DRY RUN — ${seat.role} would approve #${index}. Re-run with --send.\n`);
    const kp = loadSeat(seat);
    const sig = await multisig.rpc.proposalApprove({ connection: conn, multisigPda: msPda, transactionIndex: index, feePayer: kp, member: kp });
    console.log(`   approve (${seat.role})  ${sig}`);
    await settle(`${seat.role}'s approval`, async () => {
      const r = await readIndex(conn, msPda, index);
      return r.pr && r.pr.approved.some((k) => k.toBase58() === seat.pubkey);
    });
    printProposal((await readIndex(conn, msPda, index)).pr, ms.threshold);
    console.log("");
    return;
  }

  // execute
  if (!(cMask & EXECUTE)) fail(`${creator.role} cannot Execute (mask ${cMask}).`);
  const pp = R.proposalProblems({ index, staleTransactionIndex: stale, status: pr.status.__kind, want: "Approved" });
  if (pp.length) fail(pp.join("; "));
  await balanceGate(conn, creator, MIN_LAMPORTS.vote, SEND);
  if (!SEND) return console.log(`\n  DRY RUN — #${index} is Approved and matches the plan; ${creator.role} would execute. Re-run with --send.\n`);
  const kp = loadSeat(creator);
  const sig = await multisig.rpc.configTransactionExecute({
    connection: conn, multisigPda: msPda, transactionIndex: index, feePayer: kp, member: kp, rentPayer: kp,
    sendOptions: { skipPreflight: false },
  });
  console.log(`   execute (${creator.role})  ${sig}`);
  const fin = new Connection(cfg.rpcUrl, "finalized");
  await settle("membership change at finalized", async () => {
    const a = flatMembers(await multisig.accounts.Multisig.fromAccountAddress(fin, msPda)).map((m) => m.key);
    return a.includes(R.NEW_SEAT) && !a.includes(R.OLD_SEAT);
  }, 60, 2000);
  const after = await multisig.accounts.Multisig.fromAccountAddress(fin, msPda);
  console.log(`\n  AFTER (read back at finalized): threshold ${after.threshold} of ${after.members.length}`);
  flatMembers(after).forEach((m) => console.log(`    mask ${m.mask}  ${m.key}  ${memberName(m.key)}`));
  console.log("");
})().catch((e) => {
  console.error("\nFAILED:", e.message);
  process.exit(1);
});
