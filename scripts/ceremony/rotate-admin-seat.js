#!/usr/bin/env node
/**
 * CEREMONY — swap ONE member of a Squads V4 multisig for another.
 * 2026-10-08, task rotate-mainnet-admin-key (BLSBw8 -> 4bKN, hard-coded).
 * 2026-10-14, task squad-seat-rotation-any-pair: the pair is --old / --new,
 * both REQUIRED, with no default.
 *
 * ONE atomic config transaction per cluster:
 *     removeMember(<old>)  +  addMember(<new>, <old's live mask>)   threshold unchanged
 * The cluster's clean agent seat (`system` on mainnet, `system.devnet` on
 * devnet) creates, pays rent, approves once and, once the threshold is met on
 * chain, executes. The outgoing key never creates or executes; it may cast an
 * APPROVAL of its own removal only under --allow-outgoing-signer.
 *
 * DRY RUN BY DEFAULT, in every mode. --send arms it. --cluster, --old and --new
 * are REQUIRED in every mode, because approve and execute read the on-chain
 * transaction back against the same plan.
 *
 *   # 1. plan (read-only): validates the keys and live membership, prints the
 *   #    plan and the stale-proposal warning
 *   node scripts/ceremony/rotate-admin-seat.js --cluster=mainnet --old=<pk> --new=<pk>
 *   # 2. create + propose + the creator's vote [+ a second agent vote]
 *   node scripts/ceremony/rotate-admin-seat.js --cluster=mainnet --old=<pk> --new=<pk> --send \
 *        [--and-approve-as=<role> [--allow-outgoing-signer]]
 *   #    (or a later vote on its own)
 *   node scripts/ceremony/rotate-admin-seat.js ... --approve --index=<n> --as=<role> [--allow-outgoing-signer] --send
 *   # 3. execute: refuses until the proposal is Approved, the approvals meet the
 *   #    threshold and, on mainnet, one of Mr. McRitchie's seats has approved
 *   node scripts/ceremony/rotate-admin-seat.js ... --execute --index=<n> --send
 *
 * Every mode re-reads the on-chain ConfigTransaction and refuses unless its
 * actions are EXACTLY the plan (scripts/lib/admin-seat-rotation.js). Keys come
 * from 1Password at run time, per seat vault (squad-clusters.js
 * seatSecretSource), never from argv and never to disk; only public addresses
 * are printed.
 *
 * Once executed, approve and execute refuse with "live membership no longer
 * matches the plan": the old key is gone, which is the success signal.
 */
"use strict";

const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } = require("@solana/web3.js");
const multisig = require("@sqds/multisig");
const bs58m = require("bs58");
const { execFileSync } = require("child_process");

const {
  GENESIS,
  MAINNET_FORBIDDEN_SIGNERS,
  OPERATOR_KEYS,
  memberName,
  resolveCluster,
  seatSecretSource,
  seatsForMembers,
  squadsTransactionsUrl,
} = require("../lib/squad-clusters");
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
const OPEN_STATUSES = ["Draft", "Active", "Approved", "Executing"];

// --------------------------------------------------------------------------- args
function fail(msg, code = 1) {
  console.error(`\nREFUSED — ${msg}`);
  process.exit(code);
}

const A = R.parseRotationArgs(process.argv.slice(2));
if (A.problems.length) fail(`arguments:\n  - ${A.problems.join("\n  - ")}`, 2);
const { mode: MODE, send: SEND } = A;
const PAIR = { old: A.old, new: A.new };

let cfg;
try {
  cfg = resolveCluster(A.cluster);
} catch (e) {
  fail(e.message, 2);
}
if (cfg.multisigPda !== EXPECTED_MULTISIG[cfg.cluster]) {
  fail(`squad.json names multisig ${cfg.multisigPda} for ${cfg.cluster}; this ceremony expects ${EXPECTED_MULTISIG[cfg.cluster]}.`, 2);
}
if (!PublicKey.isOnCurve(new PublicKey(PAIR.new).toBytes())) {
  fail(`--new ${PAIR.new} is off the ed25519 curve (a PDA); no key can sign for it.`, 2);
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
  if (cfg.cluster === "mainnet-beta" && MAINNET_FORBIDDEN_SIGNERS[seat.pubkey]) {
    throw new Error(`${seat.pubkey} (${MAINNET_FORBIDDEN_SIGNERS[seat.pubkey]}) never signs on mainnet.`);
  }
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

async function readIndex(conn, msPda, index) {
  const [txPda] = multisig.getTransactionPda({ multisigPda: msPda, index });
  const [prPda] = multisig.getProposalPda({ multisigPda: msPda, transactionIndex: index });
  // An index may hold a VAULT transaction (an upgrade); decoding that as a
  // ConfigTransaction throws "Discriminant … out of range". Check the tag first.
  const txInfo = await conn.getAccountInfo(txPda);
  const isConfig =
    !!txInfo && txInfo.data.subarray(0, 8).equals(Buffer.from(multisig.accounts.configTransactionDiscriminator));
  const tx = isConfig ? multisig.accounts.ConfigTransaction.fromAccountInfo(txInfo)[0] : null;
  const pr = (await conn.getAccountInfo(prPda)) ? await multisig.accounts.Proposal.fromAccountAddress(conn, prPda) : null;
  return { txPda, prPda, tx, pr, exists: !!txInfo, isConfig };
}

/** Proposals between the stale line and the latest index that can still move. */
async function openProposals(conn, msPda, stale, txIndex, skip) {
  const open = [];
  for (let i = stale + 1n; i <= txIndex; i += 1n) {
    if (skip !== undefined && i === skip) continue;
    const { pr } = await readIndex(conn, msPda, i);
    if (pr && OPEN_STATUSES.includes(pr.status.__kind)) open.push({ index: i, status: pr.status.__kind });
  }
  return open;
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
    console.log(`  WARNING ${msg}`);
  }
}

function readBackOrFail(tx, label, plan) {
  if (!tx) fail(`no config transaction at ${label} (empty, or a vault transaction).`);
  const actions = flatActions(tx.actions);
  console.log(`\n  on-chain actions at ${label} (read back):`);
  actions.forEach((a) => console.log(`    ${R.describeAction(a)}`));
  const problems = R.checkReadBack(actions, { ...PAIR, mask: plan.mask });
  if (problems.length) fail(`on-chain actions differ from the plan:\n  - ${problems.join("\n  - ")}`);
  console.log(`  OK exactly the plan: remove ${PAIR.old}, add ${PAIR.new} at mask ${plan.mask}, threshold untouched`);
}

/** A voting seat from the roster, checked against the outgoing-key rule and live Vote permission. */
function voterOrFail(role, roster, liveMask, allowOutgoing) {
  const seat = roster.find((s) => s.role === role);
  if (!seat) fail(`no seat with role ${role} on ${cfg.cluster}; roster roles: ${roster.map((s) => s.role).join(", ")}.`);
  const op = R.outgoingSignerProblems({ seatPubkey: seat.pubkey, old: PAIR.old, allowOutgoing, step: "approve" });
  if (op.length) fail(op.join("; "), 2);
  const mask = liveMask(seat.pubkey);
  if (mask === undefined || !(mask & R.VOTE)) fail(`${seat.role} ${seat.pubkey} is not a live member with Vote.`);
  return seat;
}

async function approveAs(conn, msPda, index, seat, threshold) {
  if (seat.pubkey === PAIR.old) console.log(`\n  ${R.OUTGOING_SIGNER_NOTICE}`);
  const kp = loadSeat(seat);
  const sig = await multisig.rpc.proposalApprove({ connection: conn, multisigPda: msPda, transactionIndex: index, feePayer: kp, member: kp });
  console.log(`   approve (${seat.role})  ${sig}`);
  await settle(`${seat.role}'s approval`, async () => {
    const r = await readIndex(conn, msPda, index);
    return r.pr && r.pr.approved.some((k) => k.toBase58() === seat.pubkey);
  });
  printProposal((await readIndex(conn, msPda, index)).pr, threshold);
}

function operatorHandoff(index) {
  if (cfg.cluster !== "mainnet-beta") return;
  console.log(`\n  HANDOFF — Mr. McRitchie approves #${index} from one of his seats (${OPERATOR_KEYS.map((k) => k.slice(0, 4)).join(", ")}):`);
  console.log(`    ${squadsTransactionsUrl(cfg.vaultPda)}`);
  console.log(`  Then: --execute --index=${index} (refuses until his approval is on chain).`);
}

// --------------------------------------------------------------------------- main
(async () => {
  const conn = new Connection(cfg.rpcUrl, "confirmed");
  const genesis = await conn.getGenesisHash();
  if (genesis !== cfg.genesisHash) fail(`${cfg.cluster} genesis mismatch (got ${genesis}).`, 2);
  if (genesis !== GENESIS[cfg.cluster]) fail(`genesis ${genesis} is not ${cfg.cluster}.`, 2);

  const msPda = new PublicKey(cfg.multisigPda);
  const ms = await multisig.accounts.Multisig.fromAccountAddress(conn, msPda);
  const members = flatMembers(ms);
  const txIndex = big(ms.transactionIndex);
  const stale = big(ms.staleTransactionIndex);

  console.log(`\n${cfg.cluster.toUpperCase()}  multisig ${cfg.multisigPda}   genesis OK   mode ${MODE}${SEND ? "  ARMED (--send)" : "  dry run"}`);
  console.log(`  swap: OUT ${PAIR.old} (${memberName(PAIR.old)})`);
  console.log(`         IN ${PAIR.new} (${memberName(PAIR.new)})`);
  console.log(`  threshold ${ms.threshold} of ${members.length}   txIndex ${txIndex}   staleTransactionIndex ${stale}`);
  members.forEach((m) => console.log(`    mask ${m.mask}  ${m.key}  ${memberName(m.key)}`));

  const liveMask = (k) => (members.find((m) => m.key === k) || {}).mask;
  // Before the swap the governance role is 4bKN, after it 3LTL: read from chain.
  let roster;
  try {
    roster = seatsForMembers(cfg.cluster, members.map((m) => m.key), cfg.agentSeats);
  } catch (e) {
    fail(e.message);
  }
  const creator = roster.find((s) => s.role === CREATOR_ROLE[cfg.cluster]);
  if (!creator) fail(`no ${CREATOR_ROLE[cfg.cluster]} seat in the roster.`);
  const cMask = liveMask(creator.pubkey);
  if (cMask === undefined) fail(`${creator.role} ${creator.pubkey} is not a live member.`);
  const plan = R.planRotation({ threshold: ms.threshold, members }, PAIR);

  // ============================================================== create
  if (MODE === "create") {
    const cp = R.outgoingSignerProblems({ seatPubkey: creator.pubkey, old: PAIR.old, allowOutgoing: false, step: "create" });
    if (cp.length) fail(cp.join("; "), 2);
    if ((cMask & (R.INITIATE | R.VOTE)) !== (R.INITIATE | R.VOTE)) fail(`${creator.role} cannot Initiate and Vote (mask ${cMask}).`);
    if (plan.problems.length) fail(`plan does not match live state:\n  - ${plan.problems.join("\n  - ")}`);
    const coVoter = A.andApproveAs ? voterOrFail(A.andApproveAs, roster, liveMask, A.allowOutgoing) : null;
    if (coVoter && coVoter.pubkey === creator.pubkey) fail(`--and-approve-as names the creator ${creator.role}; it already votes.`, 2);

    const open = await openProposals(conn, msPda, stale, txIndex);
    const index = txIndex + 1n;
    if ((await readIndex(conn, msPda, index)).exists) fail(`a transaction already exists at #${index}.`);

    console.log("");
    R.formatPlan({ index, creator, plan, pair: PAIR, open }).forEach((l) => console.log(l));
    console.log(`\n  VOTES — ${creator.role} creates and approves${coVoter ? `; ${coVoter.role} approves` : ""}.`);
    await balanceGate(conn, creator, MIN_LAMPORTS.create, SEND);
    if (coVoter) await balanceGate(conn, coVoter, MIN_LAMPORTS.vote, SEND);
    if (SEND && open.length) fail(`${open.length} open proposal(s) would be staled (${open.map((p) => `#${p.index}`).join(", ")}) — land or cancel them first.`);
    if (!SEND) return console.log("\n  DRY RUN — nothing sent. Re-run with --send to create, propose and vote.\n");

    const kp = loadSeat(creator);
    console.log(`  ${creator.role} key loaded and verified`);
    const { Permission, Permissions } = multisig.types;
    const perms = Permissions.fromPermissions(
      [Permission.Initiate, Permission.Vote, Permission.Execute].filter((bit) => plan.mask & bit)
    );
    if (Number(perms.mask) !== plan.mask) fail(`SDK built mask ${perms.mask}, the plan needs ${plan.mask}.`);
    const actions = [
      { __kind: "RemoveMember", oldMember: new PublicKey(PAIR.old) },
      { __kind: "AddMember", newMember: { key: new PublicKey(PAIR.new), permissions: perms } },
    ];
    const common = { connection: conn, multisigPda: msPda, transactionIndex: index, sendOptions: { skipPreflight: false } };

    let sig = await multisig.rpc.configTransactionCreate({
      ...common, feePayer: kp, creator: kp.publicKey, rentPayer: kp.publicKey, actions, memo: R.rotationMemo(PAIR),
    });
    console.log(`   1/3 configTransactionCreate  ${sig}`);
    await settle("config transaction account", async () => !!(await readIndex(conn, msPda, index)).tx);
    readBackOrFail((await readIndex(conn, msPda, index)).tx, `#${index}`, plan);

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
    if (coVoter) await approveAs(conn, msPda, index, coVoter, ms.threshold);

    const after = await readIndex(conn, msPda, index);
    readBackOrFail(after.tx, `#${index}`, plan);
    printProposal(after.pr, ms.threshold);
    console.log(`\n  TRANSACTION INDEX ${index} on ${cfg.cluster}. Nothing executed.`);
    operatorHandoff(index);
    console.log("");
    return;
  }

  // ============================================================== approve / execute
  const index = BigInt(A.index);
  const { tx, pr } = await readIndex(conn, msPda, index);
  if (plan.problems.length) fail(`live membership no longer matches the plan:\n  - ${plan.problems.join("\n  - ")}`);
  readBackOrFail(tx, `#${index}`, plan);
  printProposal(pr, ms.threshold);
  if (!pr) fail(`no proposal at #${index}.`);

  if (MODE === "approve") {
    const seat = voterOrFail(A.as, roster, liveMask, A.allowOutgoing);
    const pp = R.proposalProblems({ index, staleTransactionIndex: stale, status: pr.status.__kind, want: "Active" });
    if (pp.length) fail(pp.join("; "));
    if (pr.approved.some((k) => k.toBase58() === seat.pubkey)) {
      console.log(`\n  ${seat.role} has already approved #${index}; nothing to do.\n`);
      return;
    }
    await balanceGate(conn, seat, MIN_LAMPORTS.vote, SEND);
    if (!SEND) return console.log(`\n  DRY RUN — ${seat.role} would approve #${index}. Re-run with --send.\n`);
    await approveAs(conn, msPda, index, seat, ms.threshold);
    operatorHandoff(index);
    console.log("");
    return;
  }

  // execute
  const ep = R.outgoingSignerProblems({ seatPubkey: creator.pubkey, old: PAIR.old, allowOutgoing: false, step: "execute" });
  if (ep.length) fail(ep.join("; "), 2);
  if (!(cMask & R.EXECUTE)) fail(`${creator.role} cannot Execute (mask ${cMask}).`);
  const sp = R.proposalProblems({ index, staleTransactionIndex: stale, status: pr.status.__kind });
  if (sp.length) fail(sp.join("; "));
  const gate = R.executeProblems({
    cluster: cfg.cluster,
    status: pr.status.__kind,
    approved: pr.approved.map((k) => k.toBase58()),
    threshold: ms.threshold,
    operatorKeys: OPERATOR_KEYS,
  });
  if (gate.length) fail(`not executable yet:\n  - ${gate.join("\n  - ")}`);
  const others = await openProposals(conn, msPda, stale, txIndex, index);
  if (others.length) {
    console.log(`\n  ${R.STALE_NOTICE}`);
    console.log(`  Executing #${index} stales: ${others.map((p) => `#${p.index} (${p.status})`).join(", ")}`);
  }
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
    return a.includes(PAIR.new) && !a.includes(PAIR.old);
  }, 60, 2000);
  const after = await multisig.accounts.Multisig.fromAccountAddress(fin, msPda);
  console.log(`\n  AFTER (read back at finalized): threshold ${after.threshold} of ${after.members.length}`);
  flatMembers(after).forEach((m) => console.log(`    mask ${m.mask}  ${m.key}  ${memberName(m.key)}`));
  console.log("");
})().catch((e) => {
  console.error("\nFAILED:", e.message);
  process.exit(1);
});
