#!/usr/bin/env node
"use strict";

/**
 * OPERATOR CEREMONY — retune ONE action's signature threshold on the turf-vault
 * DEVNET governance table (v0.26 `set_action_threshold`).
 *
 * DRY RUN BY DEFAULT. Nothing is signed or sent without `--send`.
 * DEVNET ONLY, like `rotate-devnet-signers.js`: the program id is pinned, the
 * cluster's genesis hash is checked before anything is read, and `--cluster`
 * or `--mainnet` is refused by name. A mainnet retune is a separate, deliberate
 * act; it is not a flag on this script.
 *
 * WHY IT EXISTS. Devnet carries no money, and the QA contest rehearsal has to
 * settle with no human tap: the QA server key plus one devnet-only agent key.
 * The shipped default for `settle_contest` is 3, so devnet retunes it to 2
 * (card devnet-v026-upgrade, 2026-10-12). Mainnet keeps the default.
 *
 * AUTHORIZATION. `set_action_threshold` is authorized as SET_GOVERNANCE, whose
 * floor is 3, so it takes three current signers. The first is the fee payer and
 * the named `admin`; the rest ride as leading remaining accounts. The program
 * refuses a value under the action's floor (GovernanceFloorViolation) and one
 * the live signer set cannot satisfy; both are re-checked here so a refusal
 * reads as a sentence, not an error number.
 *
 * Usage:
 *   node scripts/set-devnet-threshold.js --action settle_contest --value 2 \
 *     --signer a.json --signer b.json --signer c.json [--send]
 *
 * Keys are Solana CLI keypair JSON files; nothing secret is ever printed.
 */

const fs = require("fs");
const path = require("path");
const { readSignerSlots, ACCOUNT_LEN } = require(path.join(
  __dirname,
  "lib",
  "vault-layout.js"
));

const RPC = "https://api.devnet.solana.com";
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const PROGRAM_ID = "EQGFJAcABtDb6VXtiijTjZ6cE2UqdvhnqJvoharJbpMJ"; // DEVNET
const MAINNET_ID = "DaFv83yokwTz8msP9CzJ13eazSGk15NuUTxjkfzJzxMM"; // never

// From target/idl/turf_vault.json (v0.26): sha256("global:set_action_threshold")[0..8].
const DISCRIMINATOR = Buffer.from([172, 231, 121, 221, 140, 97, 56, 206]);

// programs/turf_vault/src/state.rs `gov_action` — the table index per action.
const ACTIONS = {
  settle_contest: 0,
  cancel_contest: 1,
  sweep_operator_revenue: 2,
  register_currency: 3,
  deactivate_currency: 4,
  pause: 5,
  unpause: 6,
  update_signers: 7,
  create_season: 8,
  close_contest: 9,
  set_contest_lock_time: 10,
  set_contest_conclusion_time: 11,
  mint_entry_token: 12,
  mint_entry_token_over_cap: 13,
  burn_entry_token: 14,
  grant_seeds: 15,
  set_governance: 16,
  admin_username: 17,
  create_contest: 18,
  enter_contest: 19,
  set_contest_lock_time_reopen: 20,
  set_contest_conclusion_time_amend: 21,
  overwrite_username: 22,
  reserve_username: 23,
  release_username: 24,
};
// state.rs THRESHOLD_FLOORS: the actions floored at 3 (every other floor is 1).
// This script refuses to touch a floored action at all; the unit test parses
// state.rs so this list and ACTIONS cannot drift from the program.
const FLOORED = new Set([
  "update_signers",
  "unpause",
  "set_governance",
  "overwrite_username",
  "reserve_username",
  "release_username",
]);
const SET_GOVERNANCE_REQUIRED = 3;
// GovernanceConfig: 8-byte discriminator, then `thresholds: [u8; 32]`.
const THRESHOLDS_OFFSET = 8;

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
  return argv.flatMap((a, i) =>
    a === name && argv[i + 1] ? [argv[i + 1]] : []
  );
}

/** Pure argument check, exported for the unit test. Returns {action, code, value}. */
function parsePlan(actionName, valueArg) {
  if (!actionName || !(actionName in ACTIONS)) {
    throw new Error(
      `--action must be one of: ${Object.keys(ACTIONS).join(", ")}`
    );
  }
  if (FLOORED.has(actionName)) {
    throw new Error(
      `${actionName} is floored by the program; this script does not retune floored actions`
    );
  }
  const value = Number(valueArg);
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    throw new Error("--value must be an integer from 1 to 5");
  }
  return { action: actionName, code: ACTIONS[actionName], value };
}

async function main() {
  // The runtime guard is the genesis hash checked below. That the pinned id is
  // not mainnet's is a fact about two constants, so the unit test asserts it.
  if (argv.includes("--mainnet") || argv.includes("--cluster")) {
    die(
      "REFUSING: this script is devnet-only by construction. A mainnet retune is a separate act."
    );
  }

  let plan;
  try {
    plan = parsePlan(flag("--action"), flag("--value"));
  } catch (e) {
    die(e.message);
  }

  const web3 = require(path.join(
    __dirname,
    "..",
    "node_modules",
    "@solana/web3.js"
  ));
  const bs58 = require(path.join(__dirname, "..", "node_modules", "bs58"));
  const encode = bs58.encode || (bs58.default && bs58.default.encode);
  const {
    Connection,
    Keypair,
    PublicKey,
    Transaction,
    TransactionInstruction,
  } = web3;

  const files = flagAll("--signer");
  if (files.length < SET_GOVERNANCE_REQUIRED) {
    die(
      `set_action_threshold is authorized as set_governance: pass --signer ${SET_GOVERNANCE_REQUIRED} times`
    );
  }
  const signers = files.map((f) => {
    if (!fs.existsSync(f)) die(`no such keypair file: ${f}`);
    const raw = JSON.parse(fs.readFileSync(f, "utf8"));
    if (!Array.isArray(raw) || raw.length !== 64)
      die(`${f} is not a 64-byte keypair JSON array`);
    return Keypair.fromSecretKey(Uint8Array.from(raw));
  });

  const conn = new Connection(RPC, "confirmed");
  const genesis = await conn.getGenesisHash();
  if (genesis !== DEVNET_GENESIS)
    die(`the RPC's genesis hash ${genesis} is not devnet's — refusing`);

  const program = new PublicKey(PROGRAM_ID);
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault")],
    program
  );
  const [govPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("governance")],
    program
  );

  const vault = await conn.getAccountInfo(vaultPda);
  if (!vault || vault.data.length !== ACCOUNT_LEN)
    die("vault_state missing or not the expected size");
  const seated = readSignerSlots(vault.data, encode)
    .filter((s) => !s.empty)
    .map((s) => s.base58);
  const gov = await conn.getAccountInfo(govPda);
  if (!gov)
    die("the governance account does not exist — run init_governance first");

  const before = gov.data[THRESHOLDS_OFFSET + plan.code];
  console.log(
    "\n  turf-vault DEVNET threshold retune" +
      (SEND ? "  —  LIVE, WILL SEND" : "  —  DRY RUN (no --send)")
  );
  console.log("  " + "─".repeat(70));
  console.log("  cluster      devnet (genesis checked)");
  console.log("  program      " + PROGRAM_ID);
  console.log("  governance   " + govPda.toBase58());
  console.log(`  action       ${plan.action} (#${plan.code})`);
  console.log(
    `  stored now   ${
      before === 0 ? "0 (unset: the shipped default applies)" : before
    }`
  );
  console.log(`  new value    ${plan.value}`);
  console.log(`  seated keys  ${seated.length}`);

  if (plan.value > seated.length)
    die(
      `${plan.value} exceeds the ${seated.length} seated signers — it would brick the action`
    );
  const keys = signers.map((k) => k.publicKey.toBase58());
  if (new Set(keys).size !== keys.length) die("the same key was passed twice");
  for (const k of keys)
    if (!seated.includes(k))
      die(`${k} is not a seated devnet signer (Unauthorized 6000)`);

  const ix = new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: signers[0].publicKey, isSigner: true, isWritable: true },
      { pubkey: vaultPda, isSigner: false, isWritable: false },
      { pubkey: govPda, isSigner: false, isWritable: true },
      ...signers
        .slice(1)
        .map((k) => ({
          pubkey: k.publicKey,
          isSigner: true,
          isWritable: false,
        })),
    ],
    data: Buffer.concat([DISCRIMINATOR, Buffer.from([plan.code, plan.value])]),
  });

  if (!SEND) {
    console.log(
      "\n  DRY RUN — nothing signed, nothing sent. Re-run with --send.\n"
    );
    return;
  }
  const sig = await web3.sendAndConfirmTransaction(
    conn,
    new Transaction().add(ix),
    signers,
    {
      commitment: "confirmed",
    }
  );
  console.log("\n  ✓ sent: " + sig);
  console.log("    https://explorer.solana.com/tx/" + sig + "?cluster=devnet");
  const after = (await conn.getAccountInfo(govPda)).data[
    THRESHOLDS_OFFSET + plan.code
  ];
  if (after !== plan.value)
    die(`READ-BACK FAILED: wrote ${plan.value}, chain holds ${after}`);
  console.log(
    `  ✓ read-back: ${plan.action} = ${after} on devnet. Mainnet untouched.\n`
  );
}

module.exports = { parsePlan, ACTIONS, FLOORED, PROGRAM_ID, MAINNET_ID, DEVNET_GENESIS };
if (require.main === module) main().catch((e) => die(e.message || String(e)));
