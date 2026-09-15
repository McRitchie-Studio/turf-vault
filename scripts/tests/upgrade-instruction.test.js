/**
 * Regression suite for scripts/lib/upgrade-instruction.js — THE READ-BACK, and
 * the ProgramData arithmetic around it.
 *
 * WHAT IT PROTECTS. A Squads approval signs "whatever is at transaction index
 * N", not what the approving script computed. Between the build and the
 * approval sit an RPC, a retry, a resumed run with a hand-typed `--index`, and
 * anybody else who can Initiate on the multisig. So `squad-upgrade.js` fetches
 * the transaction BACK off the chain after creating it and BEFORE its first
 * approval, and refuses unless every field matches. Every way that comparison
 * could pass when it should fail is a way a multisig gets captured, so each one
 * is a test here.
 *
 * The refusals are graded on WHAT THEY SAY as well as that they fire: a
 * ceremony refusal read under pressure has to name the field that differs.
 *
 * Pure data in, pure data out — no network, no SDK, no keys.
 *
 *   npm run test:scripts
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  BPF_LOADER_ID,
  BUFFER_HEADER,
  EXTEND_MARGIN_BYTES,
  PROGRAMDATA_HEADER,
  SYSVAR_CLOCK_ID,
  SYSVAR_RENT_ID,
  UPGRADE_ACCOUNT_ROLES,
  UpgradeReadbackError,
  assertIsVaultTransaction,
  buildExtendInstruction,
  buildUpgradeInstruction,
  decodeVaultMessage,
  planProgramDataExtend,
  verifyUpgradeReadback,
} = require("../lib/upgrade-instruction");

// The real devnet upgrade at Squads transaction index 13 — decoded off chain on
// 2026-09-15 and used here as a fixture, so this suite grades the decoder
// against something the chain actually produced rather than against itself.
const PLAN = {
  programId: "EQGFJAcABtDb6VXtiijTjZ6cE2UqdvhnqJvoharJbpMJ",
  programData: "EgVvLhPSXEdUHRiNdRcd7RZjwuGhtTvrkAoZimy2Lcm",
  buffer: "BAGqkbHMwMxxCEhSJHbYCTuHA1KXZuEBZ3Dca2TR3xCt",
  spill: "8K81w4e6UcB7TiANhM9N8sAgijJvTxxybRi8AENRaRYd",
  authority: "BW13kgfiG2koFn3WRkte21NW9TFygsD1ge2fNJdjH6kC",
};

const VAULT_DISCRIMINATOR = [168, 250, 162, 100, 81, 14, 162, 207];
const CONFIG_DISCRIMINATOR = [94, 8, 4, 35, 113, 139, 139, 112];
const BATCH_DISCRIMINATOR = [156, 194, 70, 44, 22, 88, 137, 44];
const KNOWN = {
  vault: VAULT_DISCRIMINATOR,
  config: CONFIG_DISCRIMINATOR,
  batch: BATCH_DISCRIMINATOR,
};

/**
 * A Squads `VaultTransactionMessage` carrying one instruction, built the way
 * the chain stores one: an account-key TABLE plus indexes into it. Decoding
 * that resolution is the part a naive comparison would skip.
 */
function messageFor(accounts, { programId = BPF_LOADER_ID, data = [3, 0, 0, 0] } = {}) {
  const accountKeys = [programId, ...accounts];
  return {
    accountKeys,
    instructions: [
      {
        programIdIndex: 0,
        accountIndexes: Uint8Array.from(accounts.map((_, i) => i + 1)),
        data: Uint8Array.from(data),
      },
    ],
    addressTableLookups: [],
  };
}

const PLANNED_ACCOUNTS = [
  PLAN.programData,
  PLAN.programId,
  PLAN.buffer,
  PLAN.spill,
  SYSVAR_RENT_ID,
  SYSVAR_CLOCK_ID,
  PLAN.authority,
];

// --- the instruction itself -------------------------------------------------

test("the upgrade instruction is the loader's seven accounts, in order", () => {
  const ix = buildUpgradeInstruction(PLAN);

  assert.equal(ix.programId, BPF_LOADER_ID);
  assert.deepEqual(Array.from(ix.data), [3, 0, 0, 0], "the `Upgrade` variant, LE u32");
  assert.deepEqual(ix.accounts.map((a) => a.role), UPGRADE_ACCOUNT_ROLES);
  assert.deepEqual(ix.accounts.map((a) => a.pubkey), PLANNED_ACCOUNTS);

  const authority = ix.accounts.find((a) => a.role === "authority");
  assert.equal(authority.isSigner, true, "the vault PDA signs via CPI at execute time");
  assert.equal(authority.pubkey, PLAN.authority);
});

test("building without every address REFUSES rather than emitting a hole", () => {
  assert.throws(
    () => buildUpgradeInstruction({ ...PLAN, buffer: undefined, spill: "" }),
    (error) => {
      assert.ok(error instanceof UpgradeReadbackError);
      assert.match(error.message, /buffer/);
      assert.match(error.message, /spill/);
      return true;
    }
  );
});

test("the extend instruction carries the variant AND the byte count", () => {
  const ix = buildExtendInstruction({
    programId: PLAN.programId,
    programData: PLAN.programData,
    payer: PLAN.spill,
    additionalBytes: 2048,
  });

  assert.equal(ix.programId, BPF_LOADER_ID);
  assert.deepEqual(Array.from(ix.data.slice(0, 4)), [6, 0, 0, 0], "ExtendProgram");
  assert.equal(ix.data.readUInt32LE(4), 2048);
  assert.equal(
    ix.accounts.find((a) => a.role === "payer").isSigner,
    true,
    "ExtendProgram takes no authority — only a payer"
  );
  assert.throws(() => buildExtendInstruction({ ...PLAN, payer: PLAN.spill, additionalBytes: 0 }));
});

// --- the sizing arithmetic --------------------------------------------------

test("the two account headers differ, so fit is arithmetic and not a comparison", () => {
  // A buffer whose ACCOUNT is smaller than the ProgramData ACCOUNT can still
  // hold an ELF that does not fit, because the headers are 37 and 45 bytes.
  // Comparing the two account sizes directly would get this wrong.
  const elf = 1000;
  const plan = planProgramDataExtend(elf + BUFFER_HEADER, elf + PROGRAMDATA_HEADER);

  assert.equal(plan.elfBytes, elf);
  assert.equal(plan.requiredBytes, elf + PROGRAMDATA_HEADER);
  assert.equal(plan.headroomBytes, 0);
  assert.equal(plan.needsExtend, false, "an exact fit is a fit");
  assert.equal(plan.additionalBytes, 0);
});

test("the live mainnet numbers say no extend is needed", () => {
  // Measured on chain 2026-09-15: ProgramData 545,973 bytes against a 543,608
  // -byte program, i.e. 2,320 bytes of headroom. This is why the coming mainnet
  // upgrade needs ~2.76 SOL of buffer and not the 5.52 a fresh deploy costs.
  const plan = planProgramDataExtend(543_608 + BUFFER_HEADER, 545_973);

  assert.equal(plan.needsExtend, false);
  assert.equal(plan.headroomBytes, 545_973 - (543_608 + PROGRAMDATA_HEADER));
  assert.equal(plan.headroomBytes, 2320);
});

test("a binary one byte too large extends, with margin for the next one", () => {
  const elf = 1000;
  const plan = planProgramDataExtend(elf + BUFFER_HEADER, elf + PROGRAMDATA_HEADER - 1);

  assert.equal(plan.needsExtend, true);
  assert.equal(plan.headroomBytes, -1);
  assert.equal(plan.additionalBytes, 1 + EXTEND_MARGIN_BYTES);
});

// --- the decode -------------------------------------------------------------

test("decoding resolves account INDEXES through the message's own key table", () => {
  const decoded = decodeVaultMessage(messageFor(PLANNED_ACCOUNTS));

  assert.equal(decoded.programId, BPF_LOADER_ID);
  assert.deepEqual(decoded.accounts, PLANNED_ACCOUNTS);
  assert.deepEqual(Array.from(decoded.data), [3, 0, 0, 0]);
});

test("a transaction that does MORE than one thing is refused", () => {
  const message = messageFor(PLANNED_ACCOUNTS);
  message.instructions.push({ ...message.instructions[0] });

  assert.throws(
    () => decodeVaultMessage(message),
    (error) => {
      assert.match(error.message, /2 instruction\(s\)/);
      assert.match(error.message, /more than it claims/);
      return true;
    }
  );
});

test("address-table lookups are refused, because they hide the accounts", () => {
  const message = messageFor(PLANNED_ACCOUNTS);
  message.addressTableLookups = [{ accountKey: "x", writableIndexes: [], readonlyIndexes: [] }];

  assert.throws(() => decodeVaultMessage(message), /cannot be decoded here/);
});

test("an index past the end of the key table is refused, not read as undefined", () => {
  const message = messageFor(PLANNED_ACCOUNTS);
  message.instructions[0].accountIndexes = Uint8Array.from([99]);

  assert.throws(() => decodeVaultMessage(message), /past the end of its/);
});

// --- the refusal, field by field -------------------------------------------

test("the honest case passes: the on-chain transaction IS the plan", () => {
  assert.equal(
    verifyUpgradeReadback(
      buildUpgradeInstruction(PLAN),
      decodeVaultMessage(messageFor(PLANNED_ACCOUNTS))
    ),
    true
  );
});

test("a different program called is refused as `not an upgrade`", () => {
  assert.throws(
    () =>
      verifyUpgradeReadback(
        buildUpgradeInstruction(PLAN),
        decodeVaultMessage(
          messageFor(PLANNED_ACCOUNTS, { programId: "11111111111111111111111111111111" })
        )
      ),
    /not the BPF upgradeable loader/
  );
});

test("a different loader instruction is refused — `Close` is not `Upgrade`", () => {
  assert.throws(
    () =>
      verifyUpgradeReadback(
        buildUpgradeInstruction(PLAN),
        decodeVaultMessage(messageFor(PLANNED_ACCOUNTS, { data: [5, 0, 0, 0] }))
      ),
    /a different loader instruction is a different act/i
  );
});

test("EVERY account position is checked, and the refusal names the role", () => {
  const evil = "EviL1111111111111111111111111111111111111111";

  for (const [i, role] of UPGRADE_ACCOUNT_ROLES.entries()) {
    const tampered = PLANNED_ACCOUNTS.slice();
    tampered[i] = evil;

    assert.throws(
      () =>
        verifyUpgradeReadback(
          buildUpgradeInstruction(PLAN),
          decodeVaultMessage(messageFor(tampered))
        ),
      (error) => {
        assert.ok(error instanceof UpgradeReadbackError);
        assert.match(
          error.message,
          new RegExp(`on-chain ${role} is ${evil}`),
          `position ${i} (${role}) must be checked and named`
        );
        return true;
      },
      `tampering with ${role} must be refused`
    );
  }
});

test("a swapped PROGRAM is refused — the capture this exists to stop", () => {
  // The accounts are all legitimate addresses; only `program` points somewhere
  // else. An approver reading a base58 list under pressure would not catch it.
  const swapped = PLANNED_ACCOUNTS.slice();
  swapped[1] = "DaFv83yokwTz8msP9CzJ13eazSGk15NuUTxjkfzJzxMM"; // the OTHER cluster's program

  assert.throws(
    () =>
      verifyUpgradeReadback(
        buildUpgradeInstruction(PLAN),
        decodeVaultMessage(messageFor(swapped))
      ),
    /on-chain program is DaFv83yok/
  );
});

test("a short account list is refused before any position is compared", () => {
  assert.throws(
    () =>
      verifyUpgradeReadback(
        buildUpgradeInstruction(PLAN),
        decodeVaultMessage(messageFor(PLANNED_ACCOUNTS.slice(0, 5)))
      ),
    /names 5 account\(s\); `Upgrade` takes 7/
  );
});

// --- the account KIND, before any decode ------------------------------------

test("a config transaction at the index is refused in words, not a beet error", () => {
  // Measured against devnet index 11 on 2026-09-15: handing a ConfigTransaction
  // to the VaultTransaction deserializer yields `The value of "offset" is out of
  // range… Received 1811939418`, which names nothing and reads like a bug here.
  assert.throws(
    () => assertIsVaultTransaction(Uint8Array.from(CONFIG_DISCRIMINATOR), KNOWN),
    (error) => {
      assert.ok(error instanceof UpgradeReadbackError);
      assert.match(error.message, /CONFIG transaction/);
      assert.match(error.message, /MEMBERSHIP or THRESHOLD/);
      return true;
    }
  );
});

test("a batch is refused, and an unknown discriminator prints itself", () => {
  assert.throws(
    () => assertIsVaultTransaction(Uint8Array.from(BATCH_DISCRIMINATOR), KNOWN),
    /BATCH/
  );
  assert.throws(
    () => assertIsVaultTransaction(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]), KNOWN),
    /discriminator \[1,2,3,4,5,6,7,8\]/
  );
});

test("a vault transaction passes, and only its first 8 bytes are consulted", () => {
  assert.equal(
    assertIsVaultTransaction(Uint8Array.from([...VAULT_DISCRIMINATOR, 9, 9, 9]), KNOWN),
    true
  );
});
