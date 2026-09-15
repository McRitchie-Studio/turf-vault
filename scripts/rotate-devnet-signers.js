#!/usr/bin/env node
"use strict";

/**
 * OPERATOR CEREMONY — rotate the turf-vault DEVNET signer set (v0.26, 5 slots).
 *
 * DRY RUN BY DEFAULT. Nothing is signed or sent without `--send`.
 * DEVNET ONLY. The program id is pinned below and the mainnet id is refused by
 * name, so this file is structurally unable to touch mainnet no matter what is
 * passed to it. Mainnet rotation is a separate, deliberate act with its own
 * script and its own review — it is not a flag on this one.
 *
 * ── WHAT THIS EXISTS FOR ──────────────────────────────────────────────────
 *
 * The live signer set is {Alex Bot, Alex, Mason} at what used to be a
 * structural 2-of-3. Alex Bot and Mason are not two parties: both private keys
 * sit in the `studio-agents` 1Password vault behind one service account, so any
 * agent with vault access holds two of three signatures — every governance
 * power the vault has, `update_signers` included.
 *
 * v0.26 makes the set five slots at three required. This script writes the new
 * set; it does not decide it.
 *
 * ── THE CEREMONY IS TWO STEPS, AND THE ORDER IS NOT OPTIONAL ──────────────
 *
 * `update_signers` requires `threshold` of the keys that AUTHORIZED a rotation
 * to survive it. With three slots and a threshold of three, all three
 * authorizers must survive — so the first rotation can only ADD:
 *
 *   step 1  ADD      {bot, alex, mason} → {bot, alex, mason, wallet2, cold}
 *           signed by all three current keys. Mason's key is needed ONE LAST
 *           TIME here; after step 2 it is gone.
 *
 *   step 2  EVICT    {bot, alex, mason, wallet2, cold}
 *                      → {system, xan-bot, alex, wallet2, cold}
 *           signed by alex + wallet2 + cold — three keys NO AGENT CAN REACH.
 *           This is the first moment the operator can act without the agent's
 *           cooperation, and it only exists because step 1 widened the set.
 *
 * Run `node scripts/check-signer-slots.js --cluster devnet` before and after.
 *
 * ── USAGE ─────────────────────────────────────────────────────────────────
 *
 *   node scripts/rotate-devnet-signers.js \
 *     --slots <pk1>,<pk2>,<pk3>[,<pk4>][,<pk5>] \
 *     --signer path/to/a.json --signer path/to/b.json --signer path/to/c.json \
 *     [--send]
 *
 * Signer order matters only in that the FIRST is the fee payer. Keys are read
 * from Solana CLI keypair JSON files; nothing is ever printed.
 */

const fs = require("fs");
const path = require("path");
const {
  readSignerSlots,
  isLeftPacked,
  ACCOUNT_LEN,
  MAX_SIGNERS,
  DEFAULT_PUBKEY,
} = require(path.join(__dirname, "lib", "vault-layout.js"));

const RPC = "https://api.devnet.solana.com";
const PROGRAM_ID = "EQGFJAcABtDb6VXtiijTjZ6cE2UqdvhnqJvoharJbpMJ"; // DEVNET
const MAINNET_ID = "DaFv83yokwTz8msP9CzJ13eazSGk15NuUTxjkfzJzxMM"; // never

// `update_signers`, verified against target/idl/turf_vault.json after the
// v0.26 build. Anchor derives a discriminator from the instruction NAME, so it
// is unchanged by the argument going from [Pubkey; 3] to [Pubkey; 5] — only
// the data length moved, 96 → 160.
const DISCRIMINATOR = Buffer.from([228, 82, 68, 150, 92, 66, 140, 174]);

// The floor the program enforces on `update_signers`, restated here so a
// refusal is readable instead of arriving as error 6046 from the chain.
const REQUIRED = 3;

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

function loadKeypair(Keypair, file) {
  if (!fs.existsSync(file)) die(`no such keypair file: ${file}`);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    die(`${file} is not valid JSON (${e.message})`);
  }
  if (!Array.isArray(raw) || raw.length !== 64) {
    die(`${file} is not a 64-byte Solana keypair JSON array`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function main() {
  // THE MAINNET REFUSAL, first and unconditional.
  if (PROGRAM_ID === MAINNET_ID) die("REFUSING: the pinned program id is mainnet.");
  if (argv.includes("--mainnet") || argv.includes("--cluster")) {
    die(
      "REFUSING: this script is devnet-only by construction. Mainnet rotation " +
        "is a separate deliberate act, not a flag."
    );
  }

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

  const slotArg = flag("--slots");
  if (!slotArg) die("missing --slots <pk1>,<pk2>,<pk3>[,<pk4>][,<pk5>]");
  const requested = slotArg.split(",").map((s) => s.trim()).filter(Boolean);
  if (requested.length < REQUIRED || requested.length > MAX_SIGNERS) {
    die(`--slots takes between ${REQUIRED} and ${MAX_SIGNERS} pubkeys; got ${requested.length}`);
  }
  let newSet;
  try {
    newSet = requested.map((s) => new PublicKey(s).toBase58());
  } catch (e) {
    die("--slots contains something that is not a base58 pubkey: " + e.message);
  }

  const signerFiles = flagAll("--signer");
  if (signerFiles.length < REQUIRED) {
    die(
      `update_signers needs ${REQUIRED} signatures — pass --signer <keypair.json> ` +
        `${REQUIRED} times (got ${signerFiles.length}).`
    );
  }
  const signers = signerFiles.map((f) => loadKeypair(Keypair, f));

  const program = new PublicKey(PROGRAM_ID);
  const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from("vault")], program);
  const [governancePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("governance")],
    program
  );

  console.log(
    "\n  turf-vault DEVNET signer rotation" +
      (SEND ? "  —  LIVE, WILL SEND" : "  —  DRY RUN (no --send)")
  );
  console.log("  " + "─".repeat(70));
  console.log("  cluster      devnet  (" + RPC + ")");
  console.log("  program      " + PROGRAM_ID);
  console.log("  vault_state  " + vaultPda.toBase58());
  console.log("  governance   " + governancePda.toBase58());
  console.log("  signing with " + signers.length + " key(s), fee payer " + signers[0].publicKey.toBase58());

  const conn = new Connection(RPC, "confirmed");

  const govInfo = await conn.getAccountInfo(governancePda);
  if (!govInfo) {
    die(
      "the governance account does not exist yet. Run `init_governance` first —\n" +
        "    every vault-authorized instruction requires it, update_signers included."
    );
  }

  const info = await conn.getAccountInfo(vaultPda);
  if (!info) die("vault_state not found on devnet");
  if (info.data.length !== ACCOUNT_LEN) {
    die(
      `vault_state is ${info.data.length} bytes; expected ${ACCOUNT_LEN}. The account was ` +
        "reallocated — STOP and re-read the layout before writing anything."
    );
  }

  const current = readSignerSlots(info.data, encode);
  console.log("\n  CURRENT on-chain set:");
  for (const s of current) {
    console.log(
      `    [${s.index}] ${s.empty ? "·" : "✓"}  ${(s.empty ? "(empty)" : s.base58).padEnd(45)} ${s.field}`
    );
  }

  console.log("\n  NEW set to write:");
  const padded = newSet.concat(Array(MAX_SIGNERS - newSet.length).fill(DEFAULT_PUBKEY));
  padded.forEach((pk, i) => {
    const was = current[i];
    let note = "";
    if (pk === DEFAULT_PUBKEY) note = "(empty)";
    else if (!current.some((s) => s.base58 === pk)) note = "← NEW";
    else if (was && was.base58 !== pk) note = "← moved";
    console.log(`    [${i}] ${(pk === DEFAULT_PUBKEY ? "(empty)" : pk).padEnd(45)} ${note}`);
  });

  const evicted = current.filter((s) => !s.empty && !padded.includes(s.base58));
  if (evicted.length) {
    console.log("\n  EVICTED:");
    for (const s of evicted) console.log("    ✗  " + s.base58);
  } else {
    console.log("\n  EVICTED: none — this is an ADDITIVE rotation.");
  }

  // ── The program's own guards, re-checked locally so a refusal names the
  //    problem instead of arriving as a numbered error from the chain. ─────
  const live = padded.filter((pk) => pk !== DEFAULT_PUBKEY);
  if (new Set(live).size !== live.length) die("duplicate key in the new set (program: DuplicateSigner 6014)");
  if (!isLeftPacked(padded.map((pk, i) => ({ index: i, base58: pk, empty: pk === DEFAULT_PUBKEY })))) {
    die("the new set has a GAP — a live key after an empty slot (program: SignerSetTooSmall 6052)");
  }
  if (live.length < REQUIRED) {
    die(`the new set has ${live.length} keys but live thresholds need ${REQUIRED} (program: SignerSetTooSmall 6052)`);
  }

  const currentKeys = current.filter((s) => !s.empty).map((s) => s.base58);
  for (const kp of signers) {
    if (!currentKeys.includes(kp.publicKey.toBase58())) {
      die(`${kp.publicKey.toBase58()} is not in the CURRENT signer set — it cannot authorize (program: Unauthorized 6000)`);
    }
  }
  const signerKeys = signers.map((k) => k.publicKey.toBase58());
  if (new Set(signerKeys).size !== signerKeys.length) {
    die("the same key was passed twice — N signatures from one keypair is one signature");
  }
  const surviving = signerKeys.filter((k) => live.includes(k));
  if (surviving.length < REQUIRED) {
    die(
      `CONTINUITY: only ${surviving.length} of the ${signerKeys.length} authorizing keys survive this\n` +
        `    rotation, and the program needs ${REQUIRED} (SignerContinuityRequired 6017).\n` +
        "    This is the guard that catches a fat-fingered paste — a set nobody who just\n" +
        "    signed can sign again would brick governance permanently. If you are trying\n" +
        "    to EVICT a key, sign with keys that are staying."
    );
  }

  console.log("\n  ✓ no duplicates, no gap, " + live.length + " live slots");
  console.log("  ✓ continuity: " + surviving.length + " of " + signerKeys.length + " authorizing keys survive (need " + REQUIRED + ")");

  const data = Buffer.concat([
    DISCRIMINATOR,
    ...padded.map((pk) => Buffer.from(new PublicKey(pk).toBytes())),
  ]);
  console.log(
    `\n  instruction: ${data.length} bytes (8 discriminator + ${MAX_SIGNERS} × 32 pubkeys)`
  );

  const ix = new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: signers[0].publicKey, isSigner: true, isWritable: true },
      { pubkey: signers[1].publicKey, isSigner: true, isWritable: false },
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      { pubkey: governancePda, isSigner: false, isWritable: false },
      // Signatures beyond the two NAMED ones ride as LEADING remaining
      // accounts — the wire shape `instructions::governance::authorize` reads.
      ...signers.slice(2).map((k) => ({
        pubkey: k.publicKey,
        isSigner: true,
        isWritable: false,
      })),
    ],
    data,
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
  console.log("    https://explorer.solana.com/tx/" + sig + "?cluster=devnet");

  // READ-BACK. A transaction that confirmed is not the same as a set that is
  // what you meant to write.
  const after = await conn.getAccountInfo(vaultPda);
  const slots = readSignerSlots(after.data, encode);
  console.log("\n  READ-BACK from chain:");
  for (const s of slots) {
    console.log(`    [${s.index}] ${s.empty ? "·" : "✓"}  ${s.empty ? "(empty)" : s.base58}`);
  }
  const landed = slots.map((s) => s.base58);
  for (let i = 0; i < MAX_SIGNERS; i += 1) {
    if (landed[i] !== padded[i]) {
      die(`READ-BACK FAILED at slot ${i}: wrote ${padded[i]}, chain holds ${landed[i]}`);
    }
  }
  console.log("\n  ✓ devnet signer set is now exactly what was written. Mainnet untouched.\n");
}

main().catch((e) => die(e.message || String(e)));
