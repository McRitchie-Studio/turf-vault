/**
 * upgrade-instruction — the BPF `Upgrade` instruction an upgrade wraps, the
 * ProgramData size arithmetic around it, and — the part that matters most —
 * the READ-BACK that refuses to approve a vault transaction whose on-chain
 * contents are not the plan.
 *
 * WHY THE READ-BACK EXISTS. A Squads approval is a signature over "whatever is
 * at transaction index N", not over anything the approving script computed. The
 * script that builds the plan and the account that gets approved are two
 * different objects, and between them sits an RPC, a retry, a resumed run with
 * a hand-typed `--index`, and — the case worth designing against — anybody else
 * who can Initiate on this multisig. Approving a transaction you have not
 * decoded is how a multisig gets captured: the attacker does not need your key,
 * only your approval on their index.
 *
 * So the flow reads the VaultTransaction BACK off the chain after creating it
 * and BEFORE the first approval, decodes the single inner instruction, and
 * refuses unless it is exactly: the BPF upgradeable loader, the `Upgrade`
 * discriminator, and the seven accounts in the order the loader defines, each
 * the address this run intends. The refusal names the first field that differs.
 *
 * This is `squad-finish.js`'s property from the 2026-09-15 membership ceremony,
 * carried from a CONFIG transaction (where the actions decode as a typed list)
 * to a VAULT transaction (where they decode as a compiled message that has to
 * be resolved through its own account-key table).
 *
 * PURE ON PURPOSE. Everything here takes and returns plain data — base58
 * strings and byte arrays — so there is no network, no SDK and no key material,
 * and every branch is graded in scripts/tests/upgrade-instruction.test.js.
 */

"use strict";

const BPF_LOADER_ID = "BPFLoaderUpgradeab1e11111111111111111111111";
const SYSVAR_RENT_ID = "SysvarRent111111111111111111111111111111111";
const SYSVAR_CLOCK_ID = "SysvarC1ock11111111111111111111111111111111";
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

/** UpgradeableLoaderInstruction variants, little-endian u32. */
const UPGRADE_DISCRIMINATOR = 3;
const EXTEND_PROGRAM_DISCRIMINATOR = 6;

/**
 * Serialized `UpgradeableLoaderState` overheads. A buffer account is 37 bytes
 * of header then the ELF; a ProgramData account is 45 bytes then the ELF. They
 * differ, so the "does it fit?" question is arithmetic, not a comparison of the
 * two account sizes.
 */
const BUFFER_HEADER = 37;
const PROGRAMDATA_HEADER = 45;

/** Slack added on top of an extend so the NEXT upgrade need not extend again. */
const EXTEND_MARGIN_BYTES = 1024;

/** The seven accounts of `Upgrade`, in the order the loader defines them. */
const UPGRADE_ACCOUNT_ROLES = [
  "programData",
  "program",
  "buffer",
  "spill",
  "rentSysvar",
  "clockSysvar",
  "authority",
];

class UpgradeReadbackError extends Error {
  constructor(message) {
    super(message);
    this.name = "UpgradeReadbackError";
  }
}

function short(key) {
  return typeof key === "string" && key.length > 12
    ? `${key.slice(0, 4)}…${key.slice(-4)}`
    : String(key);
}

/** Little-endian u32 pair — `Upgrade` carries no arguments beyond its variant. */
function u32le(value) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value, 0);
  return b;
}

/**
 * Describe the `Upgrade` instruction as plain data. The caller wraps it in a
 * `TransactionInstruction`; keeping the description separate is what lets the
 * same object be compared against what comes back off the chain.
 *
 * @param {{programId, programData, buffer, spill, authority}} addresses base58
 * @returns {{programId: string, accounts: Array<{role, pubkey, isSigner, isWritable}>, data: Buffer}}
 */
function buildUpgradeInstruction({ programId, programData, buffer, spill, authority }) {
  const missing = Object.entries({ programId, programData, buffer, spill, authority })
    .filter(([, v]) => typeof v !== "string" || v.length === 0)
    .map(([k]) => k);
  if (missing.length) {
    throw new UpgradeReadbackError(
      `cannot build the upgrade instruction: missing ${missing.join(", ")}`
    );
  }
  return {
    programId: BPF_LOADER_ID,
    accounts: [
      { role: "programData", pubkey: programData, isSigner: false, isWritable: true },
      { role: "program", pubkey: programId, isSigner: false, isWritable: true },
      { role: "buffer", pubkey: buffer, isSigner: false, isWritable: true },
      // The buffer's rent refund lands here. On mainnet that is ~2.76 SOL, so
      // it is an argument, never an assumption.
      { role: "spill", pubkey: spill, isSigner: false, isWritable: true },
      { role: "rentSysvar", pubkey: SYSVAR_RENT_ID, isSigner: false, isWritable: false },
      { role: "clockSysvar", pubkey: SYSVAR_CLOCK_ID, isSigner: false, isWritable: false },
      // The Squads vault PDA. The vault signs this via CPI at execute time.
      { role: "authority", pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: u32le(UPGRADE_DISCRIMINATOR),
  };
}

/**
 * Describe the permissionless `ExtendProgram` instruction.
 *
 * The Squad upgrade runs only the BPF `Upgrade` instruction, which — unlike
 * `solana program deploy` — does NOT grow ProgramData. So a larger binary needs
 * an extend first, and because ExtendProgram takes no authority it is done
 * directly by the fee payer rather than through the multisig.
 */
function buildExtendInstruction({ programId, programData, payer, additionalBytes }) {
  if (!Number.isInteger(additionalBytes) || additionalBytes <= 0) {
    throw new UpgradeReadbackError(
      `extend needs a positive byte count, got ${additionalBytes}`
    );
  }
  return {
    programId: BPF_LOADER_ID,
    accounts: [
      { role: "programData", pubkey: programData, isSigner: false, isWritable: true },
      { role: "program", pubkey: programId, isSigner: false, isWritable: true },
      { role: "systemProgram", pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { role: "payer", pubkey: payer, isSigner: true, isWritable: true },
    ],
    data: Buffer.concat([
      u32le(EXTEND_PROGRAM_DISCRIMINATOR),
      u32le(additionalBytes),
    ]),
  };
}

/**
 * Does the new binary fit in the ProgramData account as it stands?
 *
 * @param {number} bufferAccountBytes   the buffer ACCOUNT's data length (header included)
 * @param {number} programDataAccountBytes the ProgramData ACCOUNT's data length
 * @returns {{elfBytes, requiredBytes, currentBytes, headroomBytes,
 *            needsExtend: boolean, additionalBytes: number}}
 */
function planProgramDataExtend(bufferAccountBytes, programDataAccountBytes) {
  const elfBytes = bufferAccountBytes - BUFFER_HEADER;
  const requiredBytes = elfBytes + PROGRAMDATA_HEADER;
  const headroomBytes = programDataAccountBytes - requiredBytes;
  const needsExtend = headroomBytes < 0;
  return {
    elfBytes,
    requiredBytes,
    currentBytes: programDataAccountBytes,
    headroomBytes,
    needsExtend,
    additionalBytes: needsExtend ? -headroomBytes + EXTEND_MARGIN_BYTES : 0,
  };
}

/**
 * REFUSE unless the account at the transaction index is a VaultTransaction.
 *
 * WHY THIS IS ITS OWN CHECK, ahead of any decode. Squads stores config
 * transactions, vault transactions and batches at the SAME index space, behind
 * the same PDA derivation. Handing a ConfigTransaction to the VaultTransaction
 * deserializer does not produce a useful error — measured against devnet index
 * 11 on 2026-09-15, it produces `The value of "offset" is out of range. It must
 * be >= 0 and <= 148. Received 1811939418`, which names nothing and looks like a
 * bug in this script rather than a refusal.
 *
 * And a CONFIG transaction is the case that most deserves a legible refusal: it
 * changes who governs. An operator told "this is an upgrade" who approves a
 * config transaction has approved a membership change.
 *
 * @param {number[]|Uint8Array} actual  first 8 bytes of the account
 * @param {{vault: number[], config: number[], batch?: number[]}} known
 */
function assertIsVaultTransaction(actual, known) {
  const got = Array.from(actual).slice(0, 8);
  const same = (other) =>
    Array.isArray(other) && other.length === 8 && other.every((b, i) => b === got[i]);

  if (same(known.vault)) return true;
  if (same(known.config)) {
    throw new UpgradeReadbackError(
      `the account at this index is a CONFIG transaction, not a vault transaction. ` +
        `A config transaction changes the multisig's MEMBERSHIP or THRESHOLD — approving one ` +
        `believing it is an upgrade is how a multisig gets captured. Refusing.`
    );
  }
  if (same(known.batch)) {
    throw new UpgradeReadbackError(
      `the account at this index is a BATCH, not a vault transaction. A batch carries several ` +
        `transactions this script cannot decode; refusing to approve what it cannot read back.`
    );
  }
  throw new UpgradeReadbackError(
    `the account at this index is not a Squads transaction this script recognises ` +
      `(discriminator [${got}]). Refusing to approve it.`
  );
}

/**
 * Resolve a Squads `VaultTransactionMessage` down to its single instruction, in
 * the same plain shape `buildUpgradeInstruction` returns.
 *
 * The message stores indexes into its own `accountKeys` table, so a decode that
 * skipped this step would be comparing numbers, not addresses.
 *
 * @param {{accountKeys: string[], instructions: Array<{programIdIndex, accountIndexes, data}>}} message
 */
function decodeVaultMessage(message) {
  if (!message || !Array.isArray(message.accountKeys)) {
    throw new UpgradeReadbackError(
      "the vault transaction has no account-key table — it did not decode as a Squads message"
    );
  }
  const instructions = Array.isArray(message.instructions) ? message.instructions : [];
  if (instructions.length !== 1) {
    throw new UpgradeReadbackError(
      `the vault transaction carries ${instructions.length} instruction(s); an upgrade is exactly one. ` +
        `Refusing to approve a transaction that does more than it claims.`
    );
  }
  if (Array.isArray(message.addressTableLookups) && message.addressTableLookups.length) {
    throw new UpgradeReadbackError(
      `the vault transaction uses ${message.addressTableLookups.length} address-table lookup(s), so its ` +
        `accounts cannot be read from the message alone. Refusing to approve what cannot be decoded here.`
    );
  }

  const ix = instructions[0];
  const at = (i) => {
    const key = message.accountKeys[i];
    if (key === undefined) {
      throw new UpgradeReadbackError(
        `the vault transaction indexes account ${i}, past the end of its ${message.accountKeys.length}-key table`
      );
    }
    return key;
  };

  return {
    programId: at(ix.programIdIndex),
    accounts: Array.from(ix.accountIndexes || []).map((i) => at(i)),
    data: Buffer.from(ix.data || []),
  };
}

/**
 * REFUSE unless the transaction read back off the chain is exactly the upgrade
 * this run intends.
 *
 * @param {object} expected the result of `buildUpgradeInstruction`
 * @param {object} onchain  the result of `decodeVaultMessage`
 * @throws {UpgradeReadbackError} naming the FIRST field that differs
 */
function verifyUpgradeReadback(expected, onchain) {
  if (onchain.programId !== expected.programId) {
    throw new UpgradeReadbackError(
      `on-chain transaction calls ${short(onchain.programId)}, not the BPF upgradeable loader ` +
        `${short(expected.programId)}. This is not an upgrade.`
    );
  }

  const expectedData = Buffer.from(expected.data);
  if (!expectedData.equals(onchain.data)) {
    throw new UpgradeReadbackError(
      `on-chain instruction data is [${Array.from(onchain.data)}], expected [${Array.from(expectedData)}] ` +
        `(the \`Upgrade\` variant). A different loader instruction is a different act.`
    );
  }

  if (onchain.accounts.length !== expected.accounts.length) {
    throw new UpgradeReadbackError(
      `on-chain instruction names ${onchain.accounts.length} account(s); \`Upgrade\` takes ` +
        `${expected.accounts.length}.`
    );
  }

  for (let i = 0; i < expected.accounts.length; i += 1) {
    const want = expected.accounts[i];
    const got = onchain.accounts[i];
    if (got !== want.pubkey) {
      throw new UpgradeReadbackError(
        `on-chain ${want.role} is ${got}, expected ${want.pubkey}. ` +
          `Refusing to approve an upgrade whose ${want.role} is not the one planned.`
      );
    }
  }

  return true;
}

/** One human-readable line per account, for the block a human approves from. */
function describeUpgradeInstruction(ix) {
  return [
    `program:  ${ix.programId}  (BPF upgradeable loader)`,
    `data:     [${Array.from(ix.data)}]  (Upgrade)`,
    ...ix.accounts.map(
      (a) =>
        `  ${a.role.padEnd(12)} ${a.pubkey}` +
        `${a.isSigner ? "  [signer]" : ""}${a.isWritable ? "  [writable]" : ""}`
    ),
  ];
}

module.exports = {
  BPF_LOADER_ID,
  BUFFER_HEADER,
  EXTEND_MARGIN_BYTES,
  EXTEND_PROGRAM_DISCRIMINATOR,
  PROGRAMDATA_HEADER,
  SYSTEM_PROGRAM_ID,
  SYSVAR_CLOCK_ID,
  SYSVAR_RENT_ID,
  UPGRADE_ACCOUNT_ROLES,
  UPGRADE_DISCRIMINATOR,
  UpgradeReadbackError,
  assertIsVaultTransaction,
  buildExtendInstruction,
  buildUpgradeInstruction,
  decodeVaultMessage,
  describeUpgradeInstruction,
  planProgramDataExtend,
  verifyUpgradeReadback,
};
