#!/usr/bin/env node
/**
 * squad-upgrade — deploy a turf-vault upgrade THROUGH the Squads V4 multisig
 * that holds the program's upgrade authority. `anchor deploy` does not work for
 * an already-deployed program under Squads authority; this is the path.
 *
 * ONE SCRIPT, TWO BEHAVIOURS, CHOSEN BY MEASURING THE CHAIN
 * =========================================================
 * The 2026-09-15 rotation left the two clusters deliberately asymmetric:
 *
 *   devnet   7nRuVw3V…   threshold 3 of 5 — THREE seats are agent-held
 *   mainnet  4H3fP3ot…   threshold 3 of 5 — TWO seats are agent-held
 *
 * Devnet is meant to run unattended. Mainnet is meant to need Mr. McRitchie. So
 * this script reads the live membership and its own seat roster, counts, and
 * branches:
 *
 *   AUTONOMOUS  it can reach threshold and holds Execute →
 *               create → propose → approve → execute, end to end.
 *   HANDOFF     it cannot →
 *               create → propose → cast every approval it CAN → STOP, and
 *               print the transaction index, the on-chain actions read back
 *               from the chain, and exactly who must approve next.
 *
 * There is no flag for which one. A flag is a claim about the chain that
 * somebody has to remember to update; membership changed twice in one morning.
 *
 * WHAT THIS REPLACES. The previous version loaded `ALEX_BOT_KEY` as creator,
 * approver #1 and fee payer, and `MASON_KEY` as approver #2. Both keys
 * (`8K81w4e6…` Xan, `CytJS23p…` Mason) were removed from both multisigs at
 * 09:41 on 2026-09-15, so the script could not create, approve or execute on
 * EITHER cluster. The capability was never gone — only the tooling pointed at
 * retired seats. It also assumed TWO agent-held keys could drive an upgrade
 * unattended, which is precisely the property the rotation removed on purpose
 * for mainnet.
 *
 * DRY RUN IS THE DEFAULT. `--send` arms it. A dry run reads the chain, measures
 * the membership, classifies the mode, checks the fee payer's balance and
 * prints the whole plan — and it touches NO key material at all, because the
 * roster carries public keys and only `--send` reads a secret.
 *
 * THREE THINGS THE 2026-09-15 CEREMONY LEARNED, ENCODED HERE
 * ==========================================================
 * 1. EVERY STEP RACES THE NEXT. The account or status a call needs is not yet
 *    visible to the node when the following call builds its transaction. Devnet
 *    needed four attempts by hand; the run went clean once it polled between
 *    steps. `settle()` is that fix, and it is used after every write.
 * 2. THE SDK IS INCONSISTENT ABOUT PublicKey vs Signer. `vaultTransactionCreate`
 *    takes `creator` as a PublicKey; `proposalCreate` and `proposalApprove` take
 *    Signers. Passing the wrong one fails at BUILD time with
 *    `pubkey.toBase58 is not a function`, which names nothing useful — so each
 *    call below says which it wants. It is inconsistent about SIGNING too, and
 *    that half is quieter: `vaultTransactionCreate` signs `[feePayer,
 *    ...signers]` while marking `creator` and `rentPayer` as signer ACCOUNTS, so
 *    a creator that is not the fee payer builds a transaction missing a required
 *    signature — no build-time error, just a rejected send. This script gives one
 *    seat all three roles for that reason.
 * 3. A SIGNER WITH NO SOL FAILS AS `Attempt to debit an account but found no
 *    record of a prior credit`, which also names nothing useful. The fee payer's
 *    balance is checked BEFORE anything is built.
 *
 * AND ONE FROM `squad-finish.js`, WHICH IS THE POINT
 * ==================================================
 * NEVER APPROVE A TRANSACTION YOU HAVE NOT READ BACK. An approval signs
 * "whatever is at index N", not what this script computed. After creating the
 * vault transaction and BEFORE the first approval, the transaction is fetched
 * from the chain, decoded, and compared field by field against the intended
 * upgrade. A mismatch refuses. See scripts/lib/upgrade-instruction.js.
 *
 * USAGE
 * =====
 *   1. anchor build
 *   2. solana program write-buffer target/deploy/turf_vault.so --url <cluster>
 *        → prints "Buffer: <ADDR>"
 *   3. solana program set-buffer-authority <BUFFER> \
 *        --new-buffer-authority <vaultPda> --url <cluster>
 *   4. node scripts/squad-upgrade.js --cluster=devnet <BUFFER>            # dry run
 *      node scripts/squad-upgrade.js --cluster=devnet <BUFFER> --send     # armed
 *
 *   --cluster=devnet|mainnet   REQUIRED. No default: a convenient default is how
 *                              a ceremony step hits the wrong chain. Guarded by
 *                              the cluster's genesis hash, which cannot be faked
 *                              by a mistyped RPC URL.
 *   --send                     arm it. Without this nothing is signed or sent.
 *   --index=<n>                resume an existing transaction instead of creating
 *                              one — for a run interrupted after create.
 *   --spill=<pubkey>           where the buffer's rent refund lands. Defaults to
 *                              the fee payer. On mainnet that refund is ~2.76 SOL,
 *                              so it is printed loudly either way.
 *
 * KEYS. Never argv — argv leaks in `ps`. Each seat in the roster
 * (scripts/lib/squad-clusters.js) names a 1Password item, and an env override:
 * `SQUAD_KEY_SYSTEM`, `SQUAD_KEY_ADMIN`, `SQUAD_KEY_XAN` (base58 or a JSON byte
 * array). A loaded secret that does not derive to the roster's public key is
 * REFUSED.
 */

"use strict";

const {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} = require("@solana/web3.js");
const multisig = require("@sqds/multisig");
const bs58 = require("bs58");
const { execFileSync } = require("child_process");

const { ClusterError, memberName, resolveCluster } = require("./lib/squad-clusters");
const { INITIATE, SquadRoleError, describeMask, planUpgrade } = require("./lib/squad-roles");
const {
  BPF_LOADER_ID,
  UpgradeReadbackError,
  assertIsVaultTransaction,
  buildExtendInstruction,
  buildUpgradeInstruction,
  decodeVaultMessage,
  describeUpgradeInstruction,
  planProgramDataExtend,
  verifyUpgradeReadback,
} = require("./lib/upgrade-instruction");

const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * Head-room the fee payer must hold on top of any extend rent: the
 * VaultTransaction and Proposal accounts' rent, plus signatures for create,
 * propose, up to three approvals and an execute.
 *
 * DELIBERATELY GENEROUS, and not a measurement of one particular run. The
 * transaction account's size follows the message it holds, so its rent is not
 * knowable before the account exists — and the failure this prevents surfaces
 * as `Attempt to debit an account but found no record of a prior credit`, mid
 * ceremony, after money has already moved. Over-reserving costs a refusal that
 * names the number; under-reserving costs a half-finished upgrade.
 */
const FEE_PAYER_RESERVE_LAMPORTS = 30_000_000; // 0.03 SOL

const SOL = (lamports) => `${(lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL`;

function fail(message) {
  console.error(`\nREFUSED: ${message}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const flag = (name) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit === undefined ? null : hit.slice(name.length + 3);
  };
  const positional = argv.filter((a) => !a.startsWith("--"));
  return {
    buffer: positional[0] || null,
    cluster: flag("cluster"),
    send: argv.includes("--send"),
    index: flag("index"),
    spill: flag("spill"),
  };
}

// ---------------------------------------------------------------------------
// keys
// ---------------------------------------------------------------------------

/** base58 (88 chars) or a JSON byte array — both shapes are in the vault. */
function keypairFrom(raw, source) {
  const text = String(raw).trim();
  let secret = null;
  if (text.startsWith("[")) {
    secret = Uint8Array.from(JSON.parse(text));
  } else {
    const decoded = (bs58.default || bs58).decode(text);
    if (decoded.length === 64) secret = decoded;
  }
  if (!secret) throw new Error(`${source} did not parse as a 64-byte secret key`);
  return Keypair.fromSecretKey(secret);
}

/**
 * Load one seat's secret: env override first, then 1Password.
 *
 * The vault name resolves the same way mcritchie-studio's OpVaults does —
 * `MCR_OP_VAULT_AGENT` with a `studio-agents` default — so a machine whose
 * vaults are named differently overrides instead of forking this script.
 */
function loadSeatKeypair(seat) {
  const override = seat.env ? process.env[seat.env] : null;
  const vault = process.env.MCR_OP_VAULT_AGENT || "studio-agents";
  const source = override ? `$${seat.env}` : `op://${vault}/${seat.item}/${seat.secretField}`;

  let raw;
  if (override) {
    raw = override;
  } else {
    try {
      raw = execFileSync("op", ["read", `op://${vault}/${seat.item}/${seat.secretField}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const detail = (error.stderr || "").toString().trim().split("\n")[0] || error.message;
      throw new Error(`could not read ${source} — ${detail}`);
    }
  }

  const keypair = keypairFrom(raw, source);
  if (keypair.publicKey.toBase58() !== seat.pubkey) {
    // Never print the secret, and never print what it DID derive to either —
    // that is a live address this run has no business advertising.
    throw new Error(
      `${source} does not derive to ${seat.role}'s recorded key ${seat.pubkey}. ` +
        `Either the vault item moved or the roster in scripts/lib/squad-clusters.js is stale. Refusing.`
    );
  }
  return keypair;
}

// ---------------------------------------------------------------------------
// chain helpers
// ---------------------------------------------------------------------------

/**
 * Poll until a condition holds.
 *
 * Every step of a Squads flow races the next: the account or status the
 * following call needs is not yet visible to the node when it builds. Errors
 * inside the probe are swallowed on purpose — "not found yet" and a public-RPC
 * 429 both arrive as exceptions and both simply mean "not yet".
 */
async function settle(label, probe, tries = 30, delayMs = 1000) {
  for (let i = 0; i < tries; i += 1) {
    try {
      if (await probe()) return;
    } catch (_) {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`timed out waiting for ${label} (${tries}s)`);
}

function toInstruction(described) {
  return new TransactionInstruction({
    programId: new PublicKey(described.programId),
    keys: described.accounts.map((a) => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    })),
    data: described.data,
  });
}

async function sendAndConfirm(connection, instructions, signers, label) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const message = new TransactionMessage({
    payerKey: signers[0].publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign(signers);
  try {
    const signature = await connection.sendTransaction(tx, { skipPreflight: false });
    await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed"
    );
    console.log(`   ${label.padEnd(26)} ${signature}`);
    return signature;
  } catch (error) {
    console.error(`   ${label} FAILED: ${error.message}`);
    const sim = await connection.simulateTransaction(tx, { sigVerify: false }).catch(() => null);
    if (sim?.value?.logs) {
      console.error("   --- logs ---");
      sim.value.logs.forEach((l) => console.error("   " + l));
    }
    throw error;
  }
}

async function confirmSignature(connection, signature, label) {
  const sig = typeof signature === "string" ? signature : signature.signature;
  const blockhash = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature: sig, ...blockhash }, "confirmed");
  console.log(`   ${label.padEnd(26)} ${sig}`);
  return sig;
}

function explorerUrl(address, cluster) {
  const suffix = cluster === "devnet" ? "?cluster=devnet" : "";
  return `https://explorer.solana.com/address/${address}${suffix}`;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

(async () => {
  const args = parseArgs(process.argv.slice(2));

  if (!args.buffer) {
    fail(
      "usage: node scripts/squad-upgrade.js --cluster=devnet|mainnet <BUFFER_ADDRESS> [--send] " +
        "[--index=<n>] [--spill=<pubkey>]"
    );
  }

  let cfg;
  try {
    cfg = resolveCluster(args.cluster);
  } catch (error) {
    if (error instanceof ClusterError) fail(error.message);
    throw error;
  }

  const connection = new Connection(cfg.rpcUrl, "confirmed");

  // --- the cluster guard, before anything is read or spent ------------------
  // An RPC URL is a claim; the genesis hash is proof. They disagree exactly when
  // it matters most.
  const genesis = await connection.getGenesisHash();
  if (genesis !== cfg.genesisHash) {
    fail(
      `${cfg.cluster} genesis mismatch — ${cfg.rpcUrl} answered ${genesis}, expected ${cfg.genesisHash}. ` +
        `That RPC is not the cluster you named.`
    );
  }

  const programId = new PublicKey(cfg.programId);
  const multisigPda = new PublicKey(cfg.multisigPda);
  const vaultPda = new PublicKey(cfg.vaultPda);
  const buffer = new PublicKey(args.buffer);
  const [programData] = PublicKey.findProgramAddressSync(
    [programId.toBuffer()],
    new PublicKey(BPF_LOADER_ID)
  );

  console.log(`\nturf-vault Squad upgrade — ${cfg.cluster}`);
  console.log(`  rpc         : ${cfg.rpcUrl.replace(/api-key=[^&]+/, "api-key=***")}  (genesis OK)`);
  console.log(`  program     : ${programId.toBase58()}`);
  console.log(`  programData : ${programData.toBase58()}`);
  console.log(`  buffer      : ${buffer.toBase58()}`);
  console.log(`  multisig    : ${multisigPda.toBase58()}`);
  console.log(`  squad vault : ${vaultPda.toBase58()}   (the upgrade authority)`);

  // --- the upgrade authority must actually be this vault --------------------
  const programDataInfo = await connection.getAccountInfo(programData);
  if (!programDataInfo) fail(`programData ${programData.toBase58()} not found on ${cfg.cluster}`);
  const liveAuthority = new PublicKey(programDataInfo.data.slice(13, 45)).toBase58();
  if (liveAuthority !== vaultPda.toBase58()) {
    fail(
      `${cfg.cluster} upgrade authority is ${liveAuthority}, not the vault ${vaultPda.toBase58()} ` +
        `this script would propose through. An upgrade routed through the wrong vault can never execute.`
    );
  }

  // A buffer that is not on chain yet is FATAL under --send and a WARNING in a
  // dry run. Writing a mainnet buffer costs ~2.76 SOL, so "plan it first, pay
  // for it second" is the order the money wants; demanding the buffer to print
  // the plan would invert that.
  const bufferInfo = await connection.getAccountInfo(buffer);
  if (!bufferInfo && args.send) {
    fail(`buffer ${buffer.toBase58()} not found — did write-buffer succeed?`);
  }

  // --- MEASURE the multisig, then branch ------------------------------------
  const multisigAccount = await multisig.accounts.Multisig.fromAccountAddress(
    connection,
    multisigPda
  );
  const liveMembers = multisigAccount.members.map((m) => ({
    key: m.key.toBase58(),
    mask: Number(m.permissions.mask),
  }));

  console.log(
    `\n  live membership: threshold ${multisigAccount.threshold} of ${liveMembers.length}`
  );
  liveMembers.forEach((m) =>
    console.log(`    ${m.key}  ${describeMask(m.mask).padEnd(26)} ${memberName(m.key)}`)
  );

  let plan;
  try {
    plan = planUpgrade({
      multisig: { threshold: Number(multisigAccount.threshold), members: liveMembers },
      seats: cfg.agentSeats,
    });
  } catch (error) {
    if (error instanceof SquadRoleError) fail(error.message);
    throw error;
  }

  console.log(`\n  seats this run holds: ${plan.seated.length} of ${liveMembers.length}`);
  plan.seated.forEach((s) =>
    console.log(`    ${s.pubkey}  ${describeMask(s.mask).padEnd(26)} ${s.role}`)
  );
  plan.unseated.forEach((s) =>
    console.log(`    ${s.pubkey}  NOT A MEMBER — dropped from this run  (${s.role})`)
  );
  console.log(
    `\n  MODE: ${plan.mode.toUpperCase()} — ${plan.approvalsAvailable} approval(s) available ` +
      `vs threshold ${plan.threshold}` +
      (plan.mode === "autonomous"
        ? `, and ${plan.executor.role} can Execute.`
        : `; ${plan.shortfall} more needed from a key this run does not hold.`)
  );

  // --- fee payer: the best-funded seat that can also INITIATE ---------------
  //
  // ONE SEAT CREATES, PAYS AND RENT-PAYS, and that is forced by the SDK rather
  // than chosen for tidiness. `vaultTransactionCreate`'s instruction marks BOTH
  // `creator` and `rentPayer` as signer accounts, but `multisig.rpc
  // .vaultTransactionCreate` signs only `[feePayer, ...signers]` — so a creator
  // that is not the fee payer produces a transaction missing a required
  // signature. (`proposalCreate` differs again: it signs `[feePayer, creator,
  // rentPayer]` itself, and its instruction's rent payer falls back to the
  // CREATOR, not the fee payer.) Collapsing the two roles onto one key makes
  // every call correct by construction and means one balance to check.
  const balances = new Map();
  for (const seat of plan.seated) {
    balances.set(seat.pubkey, await connection.getBalance(new PublicKey(seat.pubkey)));
  }
  const feePayerSeat = plan.seated
    .filter((s) => s.mask & INITIATE)
    .sort((a, b) => balances.get(b.pubkey) - balances.get(a.pubkey))[0];
  // planUpgrade guarantees at least one seated key can Initiate, so this holds.
  const initiatorSeat = feePayerSeat;

  const extend = bufferInfo
    ? planProgramDataExtend(bufferInfo.data.length, programDataInfo.data.length)
    : { needsExtend: false, additionalBytes: 0, currentBytes: programDataInfo.data.length };
  const extendRent =
    extend.needsExtend && extend.additionalBytes > 0
      ? await connection.getMinimumBalanceForRentExemption(extend.additionalBytes)
      : 0;
  const needed = extendRent + FEE_PAYER_RESERVE_LAMPORTS;

  console.log(`\n  ProgramData sizing`);
  if (!bufferInfo) {
    console.log(`    buffer ${buffer.toBase58()} is NOT on chain yet —`);
    console.log(`    sizing, the extend decision and the rent refund cannot be computed.`);
    console.log(`    programData now  : ${programDataInfo.data.length} bytes`);
  } else {
    console.log(`    buffer account   : ${bufferInfo.data.length} bytes  (ELF ${extend.elfBytes})`);
    console.log(`    programData now  : ${extend.currentBytes} bytes`);
    console.log(
      `    programData needs: ${extend.requiredBytes} bytes  (headroom ${extend.headroomBytes})`
    );
    console.log(
      extend.needsExtend
        ? `    EXTEND REQUIRED  : +${extend.additionalBytes} bytes, rent ${SOL(extendRent)}, paid outside the multisig`
        : `    no extend needed — the new binary fits.`
    );
  }

  console.log(
    `\n  fee payer AND creator: ${feePayerSeat.role} ${feePayerSeat.pubkey}` +
      `\n    (one seat does both — the SDK signs vaultTransactionCreate with the fee payer alone)`
  );
  plan.seated.forEach((s) =>
    console.log(`    ${SOL(balances.get(s.pubkey)).padStart(12)}  ${s.role}`)
  );
  if (balances.get(feePayerSeat.pubkey) < needed) {
    fail(
      `fee payer ${feePayerSeat.role} ${feePayerSeat.pubkey} holds ${SOL(
        balances.get(feePayerSeat.pubkey)
      )}, and this run needs at least ${SOL(needed)} ` +
        `(${SOL(extendRent)} extend rent + ${SOL(FEE_PAYER_RESERVE_LAMPORTS)} for the Squads accounts and fees). ` +
        `It is the best-funded seat that can Initiate, and it must create as well as pay. ` +
        `Fund it before arming — an under-funded signer fails mid-ceremony as ` +
        `"Attempt to debit an account but found no record of a prior credit", which names nothing useful.`
    );
  }

  // --- the instruction the multisig will hold -------------------------------
  const spill = args.spill || feePayerSeat.pubkey;
  const upgrade = buildUpgradeInstruction({
    programId: programId.toBase58(),
    programData: programData.toBase58(),
    buffer: buffer.toBase58(),
    spill,
    authority: vaultPda.toBase58(),
  });

  console.log(`\n  the vault transaction's single instruction:`);
  describeUpgradeInstruction(upgrade).forEach((line) => console.log(`    ${line}`));
  console.log(
    `\n  SPILL: the buffer's rent (${bufferInfo ? SOL(bufferInfo.lamports) : "buffer not on chain yet"}) ` +
      `refunds to ${spill}` +
      `${args.spill ? " (--spill)" : ` — the fee payer, by default. Override with --spill=<pubkey>.`}`
  );

  // --- the steps, named before any of them runs -----------------------------
  const resumeIndex = args.index ? BigInt(args.index) : null;
  const transactionIndex =
    resumeIndex ?? multisig.utils.toBigInt(multisigAccount.transactionIndex) + 1n;
  const [transactionPda] = multisig.getTransactionPda({
    multisigPda,
    index: transactionIndex,
  });
  const [proposalPda] = multisig.getProposalPda({ multisigPda, transactionIndex });

  console.log(`\n  transaction index: ${transactionIndex}${resumeIndex ? "  (resumed via --index)" : ""}`);
  console.log(`    transaction pda: ${transactionPda.toBase58()}`);
  console.log(`    proposal pda   : ${proposalPda.toBase58()}`);
  console.log(`\n  steps this run would take:`);
  if (!resumeIndex) console.log(`    1. vaultTransactionCreate   by ${initiatorSeat.role}`);
  console.log(`    2. proposalCreate           by ${initiatorSeat.role}`);
  console.log(`    3. READ BACK from chain and refuse unless it matches the instruction above`);
  plan.voters.forEach((v, i) => console.log(`    ${4 + i}. approve                   by ${v.role}`));
  if (plan.mode === "autonomous") {
    console.log(`    ${4 + plan.voters.length}. vaultTransactionExecute   by ${plan.executor.role}`);
  } else {
    console.log(`    ${4 + plan.voters.length}. STOP — ${plan.shortfall} approval(s) and the execute belong to:`);
    plan.outsideVoters.forEach((m) =>
      console.log(`         ${m.pubkey}  ${memberName(m.pubkey)}`)
    );
  }

  /**
   * Fetch the transaction at `transactionIndex`, decode its single instruction,
   * and compare it field by field against `upgrade`.
   *
   * @returns {"absent"|"match"} or throws UpgradeReadbackError naming the first
   *          field that differs.
   */
  async function readBack() {
    const info = await connection.getAccountInfo(transactionPda);
    if (!info) return "absent";
    // What KIND of account is it, before any decode. A ConfigTransaction handed
    // to the VaultTransaction deserializer produces a beet offset error that
    // names nothing.
    assertIsVaultTransaction(info.data, {
      vault: multisig.accounts.vaultTransactionDiscriminator,
      config: multisig.accounts.configTransactionDiscriminator,
      batch: multisig.accounts.batchDiscriminator,
    });
    const onChain = await multisig.accounts.VaultTransaction.fromAccountAddress(
      connection,
      transactionPda
    );
    verifyUpgradeReadback(
      upgrade,
      decodeVaultMessage({
        accountKeys: onChain.message.accountKeys.map((k) => k.toBase58()),
        instructions: onChain.message.instructions,
        addressTableLookups: onChain.message.addressTableLookups,
      })
    );
    return "match";
  }

  if (!args.send) {
    // A dry run with --index is an AUDIT: decode what is really at that index
    // and say whether it is the upgrade being described above. This is the same
    // comparison an armed run makes before its first approval, run read-only.
    if (resumeIndex) {
      console.log(`\n  read-back audit of index ${transactionIndex}:`);
      try {
        const verdict = await readBack();
        console.log(
          verdict === "absent"
            ? `    no transaction at that index on ${cfg.cluster} — nothing to compare.`
            : `    ✓ the on-chain instruction matches the plan above exactly.`
        );
      } catch (error) {
        if (!(error instanceof UpgradeReadbackError)) throw error;
        console.log(`    ✗ MISMATCH — an armed run would refuse here:`);
        console.log(`      ${error.message}`);
      }
    }
    console.log(
      `\n  DRY RUN — nothing signed, nothing sent, no key material read.\n` +
        `  Arm with:  node scripts/squad-upgrade.js --cluster=${args.cluster} ${buffer.toBase58()} --send\n`
    );
    return;
  }

  // ==========================================================================
  // ARMED from here. Keys are read for the first time.
  // ==========================================================================
  console.log(`\n  --send: loading ${plan.seated.length} seat key(s)…`);
  const keypairs = new Map();
  for (const seat of plan.seated) {
    const roster = cfg.agentSeats.find((s) => s.pubkey === seat.pubkey);
    try {
      keypairs.set(seat.pubkey, loadSeatKeypair(roster));
      console.log(`    ${seat.role.padEnd(16)} loaded and verified`);
    } catch (error) {
      fail(error.message);
    }
  }
  const feePayer = keypairs.get(feePayerSeat.pubkey);
  const initiator = keypairs.get(initiatorSeat.pubkey); // the same key, by construction

  // --- extend, if the new binary does not fit -------------------------------
  // Permissionless, so it happens directly rather than through the multisig —
  // and it must happen even in HANDOFF mode, or the human's execute would fail.
  if (extend.needsExtend) {
    console.log(`\n  extending ProgramData by ${extend.additionalBytes} bytes…`);
    await sendAndConfirm(
      connection,
      [
        toInstruction(
          buildExtendInstruction({
            programId: programId.toBase58(),
            programData: programData.toBase58(),
            payer: feePayer.publicKey.toBase58(),
            additionalBytes: extend.additionalBytes,
          })
        ),
      ],
      [feePayer],
      "extendProgram"
    );
    await settle("ProgramData to grow", async () => {
      const info = await connection.getAccountInfo(programData);
      return info && info.data.length >= extend.requiredBytes;
    });
  }

  console.log(`\n  Squads flow at index ${transactionIndex}:`);

  // --- create ---------------------------------------------------------------
  const existing = await connection.getAccountInfo(transactionPda);
  if (existing) {
    console.log(`   vaultTransactionCreate     already on chain — skipped`);
  } else {
    if (resumeIndex) {
      fail(
        `--index=${transactionIndex} names no transaction on ${cfg.cluster}. ` +
          `Drop --index to create the next one (${multisig.utils.toBigInt(multisigAccount.transactionIndex) + 1n}).`
      );
    }
    const innerMessage = new TransactionMessage({
      payerKey: vaultPda,
      recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
      instructions: [toInstruction(upgrade)],
    });
    // `creator` here is a PublicKey. `proposalCreate` and `proposalApprove`
    // below want Signers. Passing the wrong one dies at build time with
    // "pubkey.toBase58 is not a function".
    await confirmSignature(
      connection,
      await multisig.rpc.vaultTransactionCreate({
        connection,
        feePayer,
        multisigPda,
        transactionIndex,
        creator: initiator.publicKey,
        rentPayer: feePayer.publicKey,
        vaultIndex: 0,
        ephemeralSigners: 0,
        transactionMessage: innerMessage,
      }),
      "vaultTransactionCreate"
    );
    await settle("the transaction account", async () =>
      Boolean(await connection.getAccountInfo(transactionPda))
    );
  }

  // --- READ BACK BEFORE APPROVING ------------------------------------------
  // The one property worth more than every other line in this file.
  try {
    const verdict = await readBack();
    if (verdict === "absent") fail("the transaction account vanished between create and read-back");
    console.log(`   read-back                  ✓ on-chain instruction matches the plan exactly`);
  } catch (error) {
    if (error instanceof UpgradeReadbackError) fail(error.message);
    throw error;
  }

  // --- propose --------------------------------------------------------------
  if (await connection.getAccountInfo(proposalPda)) {
    console.log(`   proposalCreate             already on chain — skipped`);
  } else {
    // `creator` is a SIGNER here. See the note at vaultTransactionCreate.
    await confirmSignature(
      connection,
      await multisig.rpc.proposalCreate({
        connection,
        feePayer,
        multisigPda,
        transactionIndex,
        creator: initiator,
        rentPayer: feePayer,
      }),
      "proposalCreate"
    );
    await settle("the proposal account", async () =>
      Boolean(await connection.getAccountInfo(proposalPda))
    );
  }

  // --- approve with every seat this run holds -------------------------------
  for (const voter of plan.voters) {
    const proposal = await multisig.accounts.Proposal.fromAccountAddress(connection, proposalPda);
    const already = proposal.approved.map((k) => k.toBase58());
    if (already.includes(voter.pubkey)) {
      console.log(`   approve (${voter.role.padEnd(14)})  already approved — skipped`);
      continue;
    }
    // `member` is a SIGNER.
    await confirmSignature(
      connection,
      await multisig.rpc.proposalApprove({
        connection,
        feePayer,
        multisigPda,
        transactionIndex,
        member: keypairs.get(voter.pubkey),
      }),
      `approve (${voter.role})`
    );
    await settle(`${voter.role}'s approval to register`, async () => {
      const p = await multisig.accounts.Proposal.fromAccountAddress(connection, proposalPda);
      return p.approved.map((k) => k.toBase58()).includes(voter.pubkey);
    });
  }

  const proposal = await multisig.accounts.Proposal.fromAccountAddress(connection, proposalPda);
  const approved = proposal.approved.map((k) => k.toBase58());

  // --- HANDOFF: stop here, and say exactly what is owed ---------------------
  if (plan.mode === "handoff") {
    const remaining = Math.max(0, plan.threshold - approved.length);
    console.log(`\n${"=".repeat(72)}`);
    console.log(`HANDOFF — this run cannot reach quorum on ${cfg.cluster}. Nothing further is signed.`);
    console.log(`${"=".repeat(72)}`);
    console.log(`\n  Squads transaction index : ${transactionIndex}`);
    console.log(`  multisig                 : ${multisigPda.toBase58()}`);
    console.log(`  transaction account      : ${transactionPda.toBase58()}`);
    console.log(`  proposal                 : ${proposal.status.__kind}, ${approved.length} of ${plan.threshold} approvals`);
    approved.forEach((k) => console.log(`      approved  ${k}  ${memberName(k)}`));
    console.log(`\n  STILL NEEDED: ${remaining} more approval(s), from any of —`);
    plan.outsideVoters.forEach((m) =>
      console.log(`      ${m.pubkey}  ${memberName(m.pubkey)}`)
    );
    console.log(`  then Execute (any member holding Execute; the vault CPI-signs the upgrade).`);
    console.log(`\n  WHAT YOU ARE APPROVING — read back from chain, not computed here:`);
    describeUpgradeInstruction(upgrade).forEach((line) => console.log(`      ${line}`));
    console.log(`\n  inspect: ${explorerUrl(transactionPda.toBase58(), cfg.cluster)}`);
    console.log(`  program: ${explorerUrl(programId.toBase58(), cfg.cluster)}\n`);
    return;
  }

  // --- AUTONOMOUS: execute --------------------------------------------------
  await settle("the proposal to reach Approved", async () => {
    const p = await multisig.accounts.Proposal.fromAccountAddress(connection, proposalPda);
    return p.status.__kind === "Approved";
  });

  // Built then sent by hand, rather than multisig.rpc.vaultTransactionExecute,
  // so an on-chain failure surfaces real logs (web3.js's error wrapping
  // swallows them behind the rpc helper).
  const { instruction: execIx, lookupTableAccounts } =
    await multisig.instructions.vaultTransactionExecute({
      connection,
      multisigPda,
      transactionIndex,
      member: keypairs.get(plan.executor.pubkey).publicKey,
    });
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const execMessage = new TransactionMessage({
    payerKey: feePayer.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5_000 }),
      execIx,
    ],
  }).compileToV0Message(lookupTableAccounts);
  const execTx = new VersionedTransaction(execMessage);
  const executorKeypair = keypairs.get(plan.executor.pubkey);
  execTx.sign(
    feePayer.publicKey.equals(executorKeypair.publicKey)
      ? [feePayer]
      : [feePayer, executorKeypair]
  );
  try {
    const signature = await connection.sendTransaction(execTx, { skipPreflight: false });
    await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed"
    );
    console.log(`   vaultTransactionExecute    ${signature}`);
  } catch (error) {
    console.error(`   execute FAILED: ${error.message}`);
    const sim = await connection.simulateTransaction(execTx, { sigVerify: false }).catch(() => null);
    if (sim?.value?.logs) {
      console.error("   --- logs ---");
      sim.value.logs.forEach((l) => console.error("   " + l));
    }
    process.exit(1);
  }

  console.log(`\nUpgrade executed on ${cfg.cluster}. Verify:`);
  console.log(`  solana program show ${programId.toBase58()} --url ${cfg.cluster}`);
  console.log(
    `  then RE-PIN EXPECTED_IDL_HASH from the freshly BUILT IDL — a Squads deploy does not ` +
      `update the on-chain IDL, so \`anchor idl fetch\` is not the source.\n`
  );
})().catch((error) => {
  console.error("\nFAILED:", error.message);
  process.exit(1);
});
