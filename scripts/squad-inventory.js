#!/usr/bin/env node
/**
 * squad-inventory — READ-ONLY. Who is on each Squads multisig right now, what
 * each seat can do, how many of those seats the agent holds, and whether that
 * reaches the threshold.
 *
 * WHY IT IS A COMMITTED SCRIPT AND NOT A NOTE. The membership changed TWICE on
 * 2026-09-15, and the stale copy of it — in a task record, in `squad.json`'s
 * comment, in an agent's head — was wrong within hours each time. Every written
 * statement of who is on these multisigs is a snapshot decaying from the moment
 * it is written. This reads the chain, so it cannot be stale.
 *
 * THE LINE THAT MATTERS is the last one per multisig: whether the agent can act
 * ALONE. Devnet is meant to be able to (it runs unattended); mainnet is meant
 * not to be (it needs Mr. McRitchie). Anything else is a finding, in either
 * direction — mainnet crossing the threshold is a governance regression, and
 * devnet falling under it is a broken automation lane.
 *
 * "Agent-held" is decided by the seat roster in scripts/lib/squad-clusters.js
 * intersected with live membership, which is the same measurement
 * `squad-upgrade.js` branches on — so this is the cheapest way to predict which
 * mode an upgrade will take before writing a buffer.
 *
 * No keys, no writes, no signatures.
 *
 *   node scripts/squad-inventory.js                 # both clusters
 *   node scripts/squad-inventory.js --cluster=devnet
 */

"use strict";

const { Connection, PublicKey } = require("@solana/web3.js");
const multisig = require("@sqds/multisig");

const { canonicalCluster, memberName, resolveCluster } = require("./lib/squad-clusters");
const { SquadRoleError, describeMask, planUpgrade } = require("./lib/squad-roles");

const BPF_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

async function report(clusterName) {
  const cfg = resolveCluster(clusterName);
  const connection = new Connection(cfg.rpcUrl, "confirmed");

  console.log(`\n${"=".repeat(72)}`);
  console.log(`${cfg.cluster}`);
  console.log(`${"=".repeat(72)}`);

  const genesis = await connection.getGenesisHash();
  if (genesis !== cfg.genesisHash) {
    console.log(`  GENESIS MISMATCH — ${cfg.rpcUrl} answered ${genesis}. Skipping.`);
    return;
  }

  const multisigPda = new PublicKey(cfg.multisigPda);
  const account = await multisig.accounts.Multisig.fromAccountAddress(connection, multisigPda);
  const [derivedVault] = multisig.getVaultPda({ multisigPda, index: 0 });

  console.log(`  multisig    : ${cfg.multisigPda}`);
  console.log(`  vault (idx 0): ${derivedVault.toBase58()}`);
  if (derivedVault.toBase58() !== cfg.vaultPda) {
    console.log(`    ✗ squad.json records ${cfg.vaultPda} — THE CONFIG AND THE DERIVATION DISAGREE`);
  }
  console.log(`  program     : ${cfg.programId}`);
  console.log(`  threshold   : ${account.threshold} of ${account.members.length}`);
  console.log(`  txIndex     : ${account.transactionIndex}`);

  // The program's upgrade authority must BE this vault, or the multisig on
  // screen governs nothing.
  const [programData] = PublicKey.findProgramAddressSync(
    [new PublicKey(cfg.programId).toBuffer()],
    BPF_LOADER
  );
  const programDataInfo = await connection.getAccountInfo(programData);
  const authority = programDataInfo
    ? new PublicKey(programDataInfo.data.slice(13, 45)).toBase58()
    : null;
  console.log(
    `  upgrade authority: ${authority || "(programData not found)"}` +
      (authority === derivedVault.toBase58() ? "  ✓ this vault" : "  ✗ NOT this vault")
  );

  const members = account.members.map((m) => ({
    key: m.key.toBase58(),
    mask: Number(m.permissions.mask),
  }));
  console.log(`\n  members:`);
  members.forEach((m) =>
    console.log(`    ${m.key}  ${describeMask(m.mask).padEnd(26)} ${memberName(m.key)}`)
  );

  try {
    const plan = planUpgrade({
      multisig: { threshold: Number(account.threshold), members },
      seats: cfg.agentSeats,
    });
    console.log(
      `\n  agent-held: ${plan.seated.length} of ${members.length}, ` +
        `${plan.approvalsAvailable} able to Vote vs threshold ${plan.threshold}`
    );
    plan.unseated.forEach((s) =>
      console.log(`    roster seat ${s.role} ${s.pubkey} is NOT a member`)
    );
    console.log(
      `  an upgrade from here would run: ${plan.mode.toUpperCase()}` +
        (plan.mode === "handoff"
          ? ` — ${plan.shortfall} approval(s) owed to a human.`
          : ` — ⚠ THE AGENT CAN UPGRADE ALONE.`)
    );
  } catch (error) {
    if (!(error instanceof SquadRoleError)) throw error;
    console.log(`\n  agent-held: NONE USABLE — ${error.message.split("\n")[0]}`);
  }
}

(async () => {
  const requested = (process.argv.find((a) => a.startsWith("--cluster=")) || "").split("=")[1];
  const clusters = requested ? [requested] : ["devnet", "mainnet"];
  for (const name of clusters) {
    if (!canonicalCluster(name)) {
      console.error(`unknown cluster ${JSON.stringify(name)} — use devnet or mainnet`);
      process.exit(2);
    }
    await report(name);
  }
  console.log("");
})().catch((error) => {
  console.error("\nFAILED:", error.message);
  process.exit(1);
});
