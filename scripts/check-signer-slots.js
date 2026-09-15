#!/usr/bin/env node
"use strict";

/**
 * PRE-FLIGHT AND POST-FLIGHT FOR THE SIGNER ROTATION CEREMONY.
 *
 * Read-only. Sends nothing, signs nothing, needs no key.
 *
 * ── WHAT IT ASKS, AND WHY IT IS THE SAME QUESTION AS BEFORE ───────────────
 *
 * Before v0.26 this check asked: "are `VaultState`'s 64 reserved bytes all
 * zero on both clusters?" That answer is the foundation the whole migration
 * rests on — it is what made appending `signers_ext` into those bytes safe,
 * because a vault that has never written them decodes the two new slots as
 * `Pubkey::default()`, which the program already treats as EMPTY.
 *
 * Those bytes are now the slots, so the question became: "are slots 4 and 5
 * still empty?" It is the same assertion pointed at the same 64 bytes.
 *
 *   BEFORE a rotation  — expect UNROTATED. Three occupied slots, two empty.
 *                        Proves the upgrade changed nothing and the operator
 *                        is starting from the state the plan assumed.
 *   AFTER a rotation   — expect ROTATED. Proves the write landed, and (with
 *                        --expect) turns that into an EXIT CODE rather than
 *                        something a tired operator has to eyeball at 2am.
 *
 * Usage:
 *   node scripts/check-signer-slots.js                    # both clusters
 *   node scripts/check-signer-slots.js --cluster devnet
 *   node scripts/check-signer-slots.js --expect unrotated # exit 1 on mismatch
 *   node scripts/check-signer-slots.js --expect rotated
 */

const path = require("path");
const {
  readSignerSlots,
  isUnrotated,
  isLeftPacked,
  ACCOUNT_LEN,
  BASE_SLOTS,
} = require(path.join(__dirname, "lib", "vault-layout.js"));

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

function flag(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

function die(msg) {
  console.error("\n  ✗ " + msg + "\n");
  process.exit(1);
}

async function main() {
  let web3;
  let bs58;
  try {
    web3 = require(path.join(__dirname, "..", "node_modules", "@solana/web3.js"));
    bs58 = require(path.join(__dirname, "..", "node_modules", "bs58"));
  } catch (e) {
    die(
      "node_modules is missing — run `yarn install` in turf-vault first.\n" +
        "    (" + e.message + ")"
    );
  }
  const encode = bs58.encode || (bs58.default && bs58.default.encode);

  const expect = flag("--expect");
  if (expect && !["unrotated", "rotated"].includes(expect)) {
    die("--expect takes `unrotated` or `rotated`");
  }
  const only = flag("--cluster");
  if (only && !CLUSTERS[only]) die("--cluster takes `devnet` or `mainnet`");
  const targets = only ? [only] : Object.keys(CLUSTERS);

  let failed = false;

  for (const name of targets) {
    const { rpc, programId } = CLUSTERS[name];
    const program = new web3.PublicKey(programId);
    const [pda] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault")],
      program
    );

    console.log("\n  " + name.toUpperCase());
    console.log("  " + "─".repeat(70));
    console.log("  program      " + programId);
    console.log("  vault_state  " + pda.toBase58());

    const info = await new web3.Connection(rpc, "confirmed").getAccountInfo(pda);
    if (!info) {
      console.log("  ✗ account NOT FOUND");
      failed = true;
      continue;
    }

    // THE SIZE CHECK IS PART OF THE PROOF, not a formality. v0.26 appended
    // into existing reserved bytes precisely so this number would NOT change;
    // if it ever does, the account was reallocated and every offset below is
    // suspect.
    console.log(
      "  size         " +
        info.data.length +
        " bytes " +
        (info.data.length === ACCOUNT_LEN
          ? "(unchanged by v0.26, as designed)"
          : "✗ EXPECTED " + ACCOUNT_LEN)
    );
    if (info.data.length !== ACCOUNT_LEN) {
      failed = true;
      continue;
    }

    const slots = readSignerSlots(info.data, encode);
    console.log("");
    for (const slot of slots) {
      const mark = slot.empty ? "·" : "✓";
      const label = slot.empty ? "(empty)" : slot.base58;
      console.log(
        `    [${slot.index}] ${mark}  ${label.padEnd(45)} ${slot.field}`
      );
    }

    const occupied = slots.filter((s) => !s.empty).length;
    const unrotated = isUnrotated(slots);
    const packed = isLeftPacked(slots);
    const state = unrotated ? "UNROTATED" : "ROTATED";

    console.log("");
    console.log(
      `    ${occupied} of ${slots.length} slots occupied · ${state}` +
        (packed ? "" : "  ✗ NOT LEFT-PACKED")
    );

    if (!packed) {
      console.log(
        "    A live key sits after an empty slot. The program refuses to WRITE\n" +
          "    such a set, so this state cannot have come from update_signers."
      );
      failed = true;
    }

    if (unrotated) {
      console.log(
        "    Slots 4 and 5 are untouched — the appended field still reads as it\n" +
          "    did before the upgrade, so the vault behaves exactly as v0.25 did."
      );
    }

    if (expect === "unrotated" && !unrotated) {
      console.log("    ✗ EXPECTED unrotated, found a rotated set.");
      failed = true;
    }
    if (expect === "rotated" && unrotated) {
      console.log(
        "    ✗ EXPECTED rotated, but slots 4 and 5 are still empty — the\n" +
          "      rotation did NOT land."
      );
      failed = true;
    }
    if (expect === "rotated" && occupied <= BASE_SLOTS && !unrotated) {
      console.log(
        "    note: fewer than four slots are occupied. That is a legitimate\n" +
          "      end state for the eviction step, which narrows back to three."
      );
    }
  }

  console.log("");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => die(e.message || String(e)));
