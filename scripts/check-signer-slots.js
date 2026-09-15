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
 *   BEFORE a rotation  — `--expect unrotated`. Three occupied slots, two empty.
 *                        Proves the upgrade changed nothing and the operator
 *                        is starting from the state the plan assumed.
 *   AFTER a rotation   — `--expect-slots <csv>`. Proves the write landed, as an
 *                        EXIT CODE rather than something a tired operator has
 *                        to eyeball at 2am.
 *
 * ── WHY THERE IS NO `--expect rotated` ────────────────────────────────────
 *
 * There was, and it was UNREACHABLE on the one day it mattered. "Rotated" was
 * computed as "not three-occupied-and-two-empty" — but that shape is also the
 * legitimate END STATE of the eviction step, which narrows a five-slot set back
 * to the three personal wallets. So the doomsday rotation would have reported
 * UNROTATED and `--expect rotated` would have exited 1 immediately after
 * succeeding.
 *
 * Occupancy cannot answer "did my rotation land?" — only the SET can. Name what
 * you wrote and the check compares it slot for slot.
 *
 * Usage:
 *   node scripts/check-signer-slots.js                      # both clusters
 *   node scripts/check-signer-slots.js --cluster devnet
 *   node scripts/check-signer-slots.js --expect unrotated    # exit 1 on mismatch
 *   node scripts/check-signer-slots.js --cluster devnet \
 *     --expect-slots <pk1>,<pk2>,<pk3>[,<pk4>][,<pk5>]
 */

const path = require("path");
const {
  readSignerSlots,
  isUnrotated,
  isLeftPacked,
  slotsMatch,
  ACCOUNT_LEN,
  DEFAULT_PUBKEY,
  MAX_SIGNERS,
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

  const only = flag("--cluster");
  if (only && !CLUSTERS[only]) die("--cluster takes `devnet` or `mainnet`");

  const expect = flag("--expect");
  if (expect === "rotated") {
    die(
      "`--expect rotated` was removed because it could not answer the question.\n" +
        "    Occupancy cannot tell a rotated set from the eviction end state, which is\n" +
        "    also three occupied slots — so it would have failed on the doomsday\n" +
        "    rotation, immediately after that rotation succeeded.\n" +
        "    Use --expect-slots <pk1>,<pk2>,... and name the set you wrote."
    );
  }
  if (expect && expect !== "unrotated") die("--expect takes `unrotated`");

  const expectSlotsArg = flag("--expect-slots");
  let expectSlots = null;
  if (expectSlotsArg) {
    expectSlots = expectSlotsArg.split(",").map((x) => x.trim()).filter(Boolean);
    if (expectSlots.length < 1 || expectSlots.length > MAX_SIGNERS) {
      die(`--expect-slots takes 1 to ${MAX_SIGNERS} pubkeys`);
    }
    try {
      expectSlots = expectSlots.map((x) => new web3.PublicKey(x).toBase58());
    } catch (e) {
      die("--expect-slots contains something that is not a base58 pubkey: " + e.message);
    }
    if (!only) die("--expect-slots needs --cluster: a signer set is per cluster");
  }

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
    if (expectSlots) {
      const padded = expectSlots
        .concat(Array(MAX_SIGNERS).fill(DEFAULT_PUBKEY))
        .slice(0, MAX_SIGNERS);
      if (slotsMatch(slots, expectSlots)) {
        console.log("    ✓ the set matches --expect-slots exactly, slot for slot.");
      } else {
        console.log("    ✗ the set does NOT match --expect-slots:");
        for (let i = 0; i < MAX_SIGNERS; i += 1) {
          if (slots[i].base58 !== padded[i]) {
            console.log(
              `        slot ${i}: expected ${padded[i]}\n` +
                `                  chain has ${slots[i].base58}`
            );
          }
        }
        failed = true;
      }
    }
  }

  console.log("");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => die(e.message || String(e)));
