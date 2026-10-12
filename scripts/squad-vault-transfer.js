#!/usr/bin/env node
/**
 * squad-vault-transfer — queue a transfer OUT of a Squads vault the way
 * Mr. McRitchie asked for it on 2026-10-12: the agent creates the transaction,
 * double-signs it with its two seats, and hands him one link to approve and
 * execute. Steffon's `squad-vault-ops` SOP (mcritchie-studio
 * docs/agents/agents/steffon/sops/squad-vault-ops.md) is the procedure; this is
 * its tool. The decisions live in scripts/lib/vault-transfer.js, tested.
 *
 * MODES
 *   plan      read-only. Reads the multisig, the vault balance and the agent
 *             seats, and prints the `send` command with the current index.
 *   send      creates the vault transaction + proposal (system seat), reads the
 *             transaction BACK from chain, then approves with every agent seat.
 *             Prints the hand-back: the Squads link and one line.
 *   approve   casts any agent approval still owed on --index (a retry after a
 *             partial send). Reads back first.
 *   execute   executes --index with the system seat. On mainnet it REFUSES
 *             unless one of Mr. McRitchie's seats has approved on chain.
 *
 *   node scripts/squad-vault-transfer.js plan    --cluster=mainnet --to=<wallet> --sol=6.2 [--memo=...]
 *   node scripts/squad-vault-transfer.js send    --cluster=mainnet --to=<wallet> --sol=6.2 --expect-index=<n>
 *   node scripts/squad-vault-transfer.js approve --cluster=mainnet --to=<wallet> --sol=6.2 --index=<n>
 *   node scripts/squad-vault-transfer.js execute --cluster=mainnet --to=<wallet> --sol=6.2 --index=<n>
 *
 *   An SPL transfer takes --mint=<mint> --amount=<ui amount> instead of --sol.
 *   The destination's associated token account must already exist; this tool
 *   refuses rather than paying rent from the vault to create one.
 *
 * approve and execute take the SAME --to and amount as send: they verify the
 * transaction at --index against them, so an agent never signs an index it has
 * not read back.
 *
 * KEYS. Never argv. Each seat in scripts/lib/squad-clusters.js names its
 * 1Password item and an env override (SQUAD_KEY_SYSTEM, SQUAD_KEY_GOVERNANCE).
 * A loaded secret must derive to the roster's public key. Nothing is printed
 * from a secret.
 */

"use strict";

const {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} = require("@solana/web3.js");
const multisig = require("@sqds/multisig");
const bs58 = require("bs58");
const { execFileSync } = require("child_process");

const {
  ClusterError,
  MAINNET_FORBIDDEN_SIGNERS,
  OPERATOR_KEYS,
  memberName,
  resolveCluster,
  seatSecretSource,
  squadsTransactionsUrl,
} = require("./lib/squad-clusters");
const {
  SOL_DECIMALS,
  TOKEN_PROGRAM,
  TransferError,
  approvalsOwed,
  assertSignerAllowed,
  checkExpectedIndex,
  executeGate,
  formatAmount,
  handoff,
  matchesPlan,
  parseAmount,
} = require("./lib/vault-transfer");

const RENT_RESERVE_LAMPORTS = 10_000_000; // 0.01 SOL: tx + proposal rent and fees
const MODES = ["plan", "send", "approve", "execute"];

function fail(message) {
  console.error(`\nREFUSED: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const flag = (name) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit === undefined ? null : hit.slice(name.length + 3);
  };
  return {
    mode: argv.find((a) => !a.startsWith("--")) || null,
    cluster: flag("cluster"),
    to: flag("to"),
    sol: flag("sol"),
    mint: flag("mint"),
    amount: flag("amount"),
    memo: flag("memo"),
    expectIndex: flag("expect-index"),
    index: flag("index"),
  };
}

function keypairFrom(raw, source) {
  const text = String(raw).trim();
  let secret = null;
  if (text.startsWith("[")) secret = Uint8Array.from(JSON.parse(text));
  else {
    const decoded = (bs58.default || bs58).decode(text);
    if (decoded.length === 64) secret = decoded;
  }
  if (!secret) throw new Error(`${source} did not parse as a 64-byte secret key`);
  const keypair = Keypair.fromSecretKey(Uint8Array.from(secret));
  secret.fill(0);
  return keypair;
}

function loadSeat(seat, cluster) {
  assertSignerAllowed(seat.pubkey, cluster, MAINNET_FORBIDDEN_SIGNERS);
  const override = seat.env ? process.env[seat.env] : null;
  const spec = override ? null : seatSecretSource(seat);
  const source = override ? `$${seat.env}` : `${seat.item} (${spec.vault})`;
  let raw = override;
  if (!override) {
    try {
      raw = execFileSync("op", ["read", spec.ref], {
        encoding: "utf8",
        env: spec.childEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const detail = (error.stderr || "").toString().trim().split("\n")[0] || error.message;
      throw new Error(`could not read ${source} — ${detail.replace(/[1-9A-HJ-NP-Za-km-z]{60,}/g, "<redacted>")}`);
    }
  }
  const keypair = keypairFrom(raw, source);
  raw = null;
  if (keypair.publicKey.toBase58() !== seat.pubkey) {
    throw new Error(`${source} does not derive to ${seat.role}'s recorded key ${seat.pubkey}. Refusing.`);
  }
  assertSignerAllowed(keypair.publicKey.toBase58(), cluster, MAINNET_FORBIDDEN_SIGNERS);
  return keypair;
}

async function sendTx(connection, payer, signers, instructions, label) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }), ...instructions],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign(signers);
  const signature = await connection.sendTransaction(tx, { maxRetries: 10 });
  const result = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (result.value.err) throw new Error(`${label} failed: ${JSON.stringify(result.value.err)} (${signature})`);
  console.log(`   ${label.padEnd(34)} ${signature}`);
  return signature;
}

/** Poll until a probe holds: every Squads step races the next (squad-upgrade.js, lesson 1). */
async function settle(label, probe, tries = 30) {
  for (let i = 0; i < tries; i += 1) {
    try {
      if (await probe()) return;
    } catch (_) {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function pdas(multisigPda, index) {
  const [transaction] = multisig.getTransactionPda({ multisigPda, index });
  const [proposal] = multisig.getProposalPda({ multisigPda, transactionIndex: index });
  return { transaction, proposal };
}

/** Read index N back as plain data and grade it against the plan. */
async function readBack(connection, multisigPda, index, plan, quiet = false) {
  const { transaction, proposal } = pdas(multisigPda, index);
  const vt = await multisig.accounts.VaultTransaction.fromAccountAddress(connection, transaction);
  const keys = vt.message.accountKeys.map((k) => k.toBase58());
  const instructions = vt.message.instructions.map((ix) => ({
    programId: keys[ix.programIdIndex],
    accounts: [...ix.accountIndexes].map((i) => keys[i]),
    data: Buffer.from(ix.data),
  }));
  const verdict = matchesPlan(instructions, plan);
  let state = null;
  try {
    state = await multisig.accounts.Proposal.fromAccountAddress(connection, proposal);
  } catch (_) {
    /* no proposal yet */
  }
  const approved = state ? state.approved.map((k) => k.toBase58()) : [];
  const status = state ? state.status.__kind : null;
  if (quiet) return { verdict, status, approved };
  console.log(`   vault tx #${index} ${transaction.toBase58()} (vault index ${vt.vaultIndex})`);
  console.log(`   instruction: ${verdict.ok ? "EXACTLY the planned transfer" : "MISMATCH — " + verdict.reasons.join("; ")}`);
  console.log(
    `   proposal ${proposal.toBase58()}: ${state ? state.status.__kind : "NOT FOUND"}; approved ` +
      `[${approved.map((k) => `${k.slice(0, 6)} ${memberName(k)}`).join(", ")}]`
  );
  return { verdict, status, approved };
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (!MODES.includes(args.mode)) {
    fail(`mode must be one of ${MODES.join(" | ")} (see the header of this file)`);
  }

  let cfg;
  try {
    cfg = resolveCluster(args.cluster);
  } catch (error) {
    if (error instanceof ClusterError) fail(error.message);
    throw error;
  }
  if (!args.to) fail("--to=<destination wallet> is required");
  if (Boolean(args.sol) === Boolean(args.mint)) fail("give exactly one of --sol=<amount> or --mint=<mint> --amount=<amount>");

  const connection = new Connection(cfg.rpcUrl, "confirmed");
  const genesis = await connection.getGenesisHash();
  if (genesis !== cfg.genesisHash) {
    fail(`${cfg.cluster} genesis mismatch: the RPC answered ${genesis}, expected ${cfg.genesisHash}`);
  }

  const multisigPda = new PublicKey(cfg.multisigPda);
  const vault = new PublicKey(cfg.vaultPda);
  const to = new PublicKey(args.to);
  const [vaultCheck] = multisig.getVaultPda({ multisigPda, index: 0 });
  if (!vaultCheck.equals(vault)) fail(`squad.json's vaultPda is not vault 0 of ${cfg.multisigPda}`);

  // --- the plan ----------------------------------------------------------
  let plan;
  let symbol;
  let transferIx;
  try {
    if (args.sol) {
      plan = { kind: "sol", vault: vault.toBase58(), to: to.toBase58(), amount: parseAmount(args.sol, SOL_DECIMALS) };
      symbol = "SOL";
      transferIx = SystemProgram.transfer({ fromPubkey: vault, toPubkey: to, lamports: plan.amount });
    } else {
      const spl = require("@solana/spl-token");
      const mint = new PublicKey(args.mint);
      const mintInfo = await connection.getAccountInfo(mint);
      if (!mintInfo) fail(`mint ${args.mint} does not exist on ${cfg.cluster}`);
      if (mintInfo.owner.toBase58() !== TOKEN_PROGRAM) fail("only classic SPL mints are supported (not Token-2022)");
      const { decimals } = await spl.getMint(connection, mint);
      const source = spl.getAssociatedTokenAddressSync(mint, vault, true);
      const destination = spl.getAssociatedTokenAddressSync(mint, to);
      if (!(await connection.getAccountInfo(destination))) {
        fail(`${args.to} has no token account for ${args.mint}. Create it first (any wallet can); the vault does not pay rent for it.`);
      }
      plan = {
        kind: "spl",
        vault: vault.toBase58(),
        mint: mint.toBase58(),
        source: source.toBase58(),
        destination: destination.toBase58(),
        destinationOwner: to.toBase58(),
        amount: parseAmount(args.amount, decimals),
        decimals,
      };
      symbol = `of mint ${args.mint.slice(0, 6)}…`;
      transferIx = spl.createTransferCheckedInstruction(source, mint, destination, vault, plan.amount, decimals);
    }
  } catch (error) {
    if (error instanceof TransferError) fail(error.message);
    throw error;
  }
  const amountText = `${formatAmount(plan.amount, plan.kind === "sol" ? SOL_DECIMALS : plan.decimals)} ${symbol}`;

  // --- the chain ---------------------------------------------------------
  const ms = await multisig.accounts.Multisig.fromAccountAddress(connection, multisigPda);
  const current = BigInt(ms.transactionIndex.toString());
  const members = ms.members.map((m) => ({ key: m.key.toBase58(), mask: m.permissions.mask }));
  const seats = cfg.agentSeats.filter((s) => members.some((m) => m.key === s.pubkey));
  const system = seats.find((s) => s.role.startsWith("system"));
  const operatorNames = OPERATOR_KEYS.filter((k) => members.some((m) => m.key === k)).map((k) => k.slice(0, 4));

  console.log(`\n${cfg.cluster.toUpperCase()}  squad-vault-transfer ${args.mode}`);
  console.log(`   multisig ${cfg.multisigPda}  threshold ${ms.threshold} of ${members.length}  transaction_index ${current}`);
  console.log(`   vault    ${cfg.vaultPda}  ${(await connection.getBalance(vault)) / LAMPORTS_PER_SOL} SOL`);
  console.log(`   move     ${amountText} -> ${args.to}`);
  for (const m of members) console.log(`   member   ${m.key} mask ${m.mask}  ${memberName(m.key)}`);
  if (!system) fail(`no system seat of the roster is a live member of ${cfg.multisigPda}`);

  if (args.mode === "plan") {
    const next = current + 1n;
    const { transaction, proposal } = pdas(multisigPda, next);
    console.log(`\n   next index ${next}: vault tx ${transaction.toBase58()}  proposal ${proposal.toBase58()}`);
    console.log(`   agent seats seated: ${seats.map((s) => `${s.role} ${s.pubkey.slice(0, 6)}`).join(", ")}`);
    console.log(`\n   to queue it:  node scripts/squad-vault-transfer.js send ${process.argv.slice(2).filter((a) => a !== "plan").join(" ")} --expect-index=${current}\n`);
    return;
  }

  try {
    if (args.mode === "send") {
      const index = checkExpectedIndex(current, args.expectIndex);
      if (plan.kind === "sol" && BigInt(await connection.getBalance(vault)) < plan.amount) fail("the vault holds less than the amount");
      const payer = loadSeat(system, cfg.cluster);
      if ((await connection.getBalance(payer.publicKey)) < RENT_RESERVE_LAMPORTS) fail(`${system.role} holds under 0.01 SOL for rent and fees`);
      const memo = args.memo || `vault transfer ${amountText}`;
      const message = new TransactionMessage({ payerKey: vault, recentBlockhash: PublicKey.default.toBase58(), instructions: [transferIx] });
      await sendTx(connection, payer, [payer], [
        multisig.instructions.vaultTransactionCreate({
          multisigPda, transactionIndex: index, creator: payer.publicKey, rentPayer: payer.publicKey,
          vaultIndex: 0, ephemeralSigners: 0, transactionMessage: message, memo,
        }),
        multisig.instructions.proposalCreate({ multisigPda, transactionIndex: index, creator: payer.publicKey, rentPayer: payer.publicKey, isDraft: false }),
      ], `create + propose #${index}`);
      await settle("the proposal", async () => (await readBack(connection, multisigPda, index, plan, true)).status === "Active");
      args.index = index.toString();
    }

    const index = BigInt(args.index ?? -1);
    if (index < 1n || index > (args.mode === "send" ? current + 1n : current)) fail("--index=<n> must name an existing transaction");
    let rb = await readBack(connection, multisigPda, index, plan);
    if (!rb.verdict.ok) fail(`transaction #${index} is not the planned transfer; nothing signed`);

    if (args.mode === "send" || args.mode === "approve") {
      if (rb.status !== "Active") fail(`proposal #${index} is ${rb.status}, not Active`);
      const payer = loadSeat(system, cfg.cluster);
      for (const seat of approvalsOwed(rb.approved, seats, members)) {
        const member = seat.pubkey === system.pubkey ? payer : loadSeat(seat, cfg.cluster);
        const signers = member === payer ? [payer] : [payer, member];
        await sendTx(connection, payer, signers, [
          multisig.instructions.proposalApprove({ multisigPda, transactionIndex: index, member: member.publicKey }),
        ], `approve #${index} ${seat.role}`);
        await settle(`${seat.role}'s approval`, async () => (await readBack(connection, multisigPda, index, plan, true)).approved.includes(seat.pubkey));
      }
      rb = await readBack(connection, multisigPda, index, plan);
      const approvedBy = rb.approved.map((k) => k.slice(0, 6));
      const [url, line] = handoff({ url: squadsTransactionsUrl(cfg.vaultPda), index, plan, symbol, approvedBy, operatorNames });
      console.log(`\nHAND-BACK\n   ${url}\n   ${line}\n`);
      return;
    }

    // execute
    executeGate({ cluster: cfg.cluster, status: rb.status, approved: rb.approved, operatorKeys: OPERATOR_KEYS });
    const payer = loadSeat(system, cfg.cluster);
    const { instruction } = await multisig.instructions.vaultTransactionExecute({ connection, multisigPda, transactionIndex: index, member: payer.publicKey });
    await sendTx(connection, payer, [payer], [instruction], `execute #${index}`);
    await settle("execution", async () => (await readBack(connection, multisigPda, index, plan, true)).status === "Executed");
    console.log(`\n   EXECUTED #${index}: ${amountText} -> ${args.to}\n`);
  } catch (error) {
    if (error instanceof TransferError || error instanceof ClusterError) fail(error.message);
    throw error;
  }
})().catch((error) => {
  console.error(`\nERROR: ${error.message}\n`);
  process.exit(1);
});
