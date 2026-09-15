#!/usr/bin/env node
"use strict";

/**
 * DEPLOY STEP — create the v0.26 `GovernanceConfig` account.
 *
 * DRY RUN BY DEFAULT. Nothing is signed or sent without `--send`.
 *
 * ── WHY THIS IS A SCRIPT AND NOT A LINE IN THE RUNBOOK ────────────────────
 *
 * v0.26 moved the per-action signature thresholds into a PDA at
 * `[b"governance"]`, and EVERY vault-authorized instruction requires it —
 * `pause` included. Between the program upgrade landing and this call, the
 * platform's brake does not work: those instructions return
 * `AccountNotInitialized` (3012).
 *
 * That window is measured in minutes only if the command is ready to run. The
 * runbook used to say "run init_governance IMMEDIATELY" and give no command,
 * which is the shape of instruction that turns a two-minute window into
 * however long it takes to write one under pressure.
 *
 * ── WHY TWO SIGNATURES IS SAFE HERE ───────────────────────────────────────
 *
 * `init_governance` TAKES NO ARGUMENTS. It can write exactly one thing: the
 * defaults compiled into the program. So the party that bootstraps cannot
 * choose weak numbers, and the worst an unwanted call achieves is installing
 * the safe table earlier than planned. Retuning anything afterwards costs
 * three signatures and is floored. `init` collides on a second call, so a
 * table that has since been retuned cannot be reset by re-running this.
 *
 * Usage:
 *   node scripts/init-governance.js --cluster devnet \
 *     --signer a.json --signer b.json [--send]
 */

const fs = require("fs");
const path = require("path");

// `init_governance`, read from target/idl/turf_vault.json after the v0.26
// build. Anchor derives it from the instruction NAME.
const DISCRIMINATOR = Buffer.from([23, 241, 166, 67, 20, 30, 182, 32]);

// `BOOTSTRAP_THRESHOLD` in programs/turf_vault/src/instructions/governance.rs,
// restated so a refusal is readable rather than arriving as 6046 from chain.
const REQUIRED = 2;

const CLUSTERS = {
  devnet: {
    rpc: "https://api.devnet.solana.com",
    programId: "EQGFJAcABtDb6VXtiijTjZ6cE2UqdvhnqJvoharJbpMJ",
  },
  mainnet: {
    rpc: "https://api.mainnet-beta.solana.com",
    programId: "DaFv83yokwTz8msP9CzJ13eazSGk15NuUTxjkfzJzxMM",
  },
};

const argv = process.argv.slice(2);
const SEND = argv.includes("--send");

function die(msg) {
  console.error("\n  ✗ " + msg + "\n");
  process.exit(1);
}
function flag(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}
function flagAll(name) {
  const out = [];
  argv.forEach((a, i) => {
    if (a === name && argv[i + 1]) out.push(argv[i + 1]);
  });
  return out;
}

async function main() {
  let web3;
  let bs58;
  try {
    web3 = require(path.join(__dirname, "..", "node_modules", "@solana/web3.js"));
    bs58 = require(path.join(__dirname, "..", "node_modules", "bs58"));
  } catch (e) {
    die("node_modules is missing — run `yarn install` first. (" + e.message + ")");
  }
  const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } = web3;
  const encode = bs58.encode || (bs58.default && bs58.default.encode);
  const { readSignerSlots, ACCOUNT_LEN } = require(path.join(
    __dirname,
    "lib",
    "vault-layout.js"
  ));

  // NO DEFAULT CLUSTER. This one legitimately runs on mainnet, so it must be
  // named rather than assumed — the mistake this guards against is running a
  // deploy step against the wrong chain because a default was convenient.
  const cluster = flag("--cluster");
  if (!cluster || !CLUSTERS[cluster]) {
    die("--cluster is REQUIRED and takes `devnet` or `mainnet`");
  }
  const { rpc, programId } = CLUSTERS[cluster];

  const files = flagAll("--signer");
  if (files.length < REQUIRED) {
    die(
      `init_governance needs ${REQUIRED} signatures — pass --signer <keypair.json> ` +
        `${REQUIRED} times (got ${files.length}).`
    );
  }
  const signers = files.map((f) => {
    if (!fs.existsSync(f)) die(`no such keypair file: ${f}`);
    const raw = JSON.parse(fs.readFileSync(f, "utf8"));
    if (!Array.isArray(raw) || raw.length !== 64) {
      die(`${f} is not a 64-byte Solana keypair JSON array`);
    }
    return Keypair.fromSecretKey(Uint8Array.from(raw));
  });

  const program = new PublicKey(programId);
  const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from("vault")], program);
  const [governancePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("governance")],
    program
  );

  console.log(
    "\n  turf-vault governance bootstrap" +
      (SEND ? "  —  LIVE, WILL SEND" : "  —  DRY RUN (no --send)")
  );
  console.log("  " + "─".repeat(70));
  console.log("  cluster      " + cluster + "  (" + rpc + ")");
  console.log("  program      " + programId);
  console.log("  vault_state  " + vaultPda.toBase58());
  console.log("  governance   " + governancePda.toBase58());

  const conn = new Connection(rpc, "confirmed");

  if (await conn.getAccountInfo(governancePda)) {
    die(
      "the governance account ALREADY EXISTS. `init` would collide, and that is\n" +
        "    deliberate — a table that has since been retuned must not be resettable\n" +
        "    by re-running the bootstrap. Nothing to do."
    );
  }

  const info = await conn.getAccountInfo(vaultPda);
  if (!info) die("vault_state not found — has `initialize` run on this cluster?");
  if (info.data.length !== ACCOUNT_LEN) {
    die(
      `vault_state is ${info.data.length} bytes; expected ${ACCOUNT_LEN}. Either the ` +
        "program is not v0.26 or the account was reallocated. STOP."
    );
  }

  const slots = readSignerSlots(info.data, encode);
  const active = slots.filter((s) => !s.empty).map((s) => s.base58);
  console.log("\n  active signer set (" + active.length + " slots):");
  for (const s of slots) {
    console.log(`    [${s.index}] ${s.empty ? "·" : "✓"}  ${s.empty ? "(empty)" : s.base58}`);
  }

  const keys = signers.map((k) => k.publicKey.toBase58());
  if (new Set(keys).size !== keys.length) {
    die("the same key was passed twice — two signatures from one keypair is one signature");
  }
  for (const k of keys) {
    if (!active.includes(k)) {
      die(`${k} is not in the active signer set — it cannot authorize (Unauthorized 6000)`);
    }
  }
  console.log(
    "\n  ✓ " + keys.length + " distinct active signer(s) signing (need " + REQUIRED + ")"
  );
  console.log("  ✓ takes no arguments — it can only write the program's shipped defaults");

  const ix = new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: signers[0].publicKey, isSigner: true, isWritable: true },
      { pubkey: vaultPda, isSigner: false, isWritable: false },
      { pubkey: governancePda, isSigner: false, isWritable: true },
      { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
      // Signatures beyond the named `admin` ride as LEADING remaining accounts.
      ...signers.slice(1).map((k) => ({
        pubkey: k.publicKey,
        isSigner: true,
        isWritable: false,
      })),
    ],
    data: DISCRIMINATOR,
  });

  if (!SEND) {
    console.log("\n  DRY RUN — nothing signed, nothing sent.");
    console.log("  Re-run with --send to execute.\n");
    return;
  }

  const sig = await web3.sendAndConfirmTransaction(conn, new Transaction().add(ix), signers, {
    commitment: "confirmed",
  });
  console.log("\n  ✓ sent: " + sig);
  const suffix = cluster === "devnet" ? "?cluster=devnet" : "";
  console.log("    https://explorer.solana.com/tx/" + sig + suffix);

  const after = await conn.getAccountInfo(governancePda);
  if (!after) die("READ-BACK FAILED: the governance account does not exist.");
  console.log(
    "\n  ✓ governance account created, " + after.data.length + " bytes. " +
      "Vault-authorized instructions work again.\n"
  );
}

main().catch((e) => die(e.message || String(e)));
