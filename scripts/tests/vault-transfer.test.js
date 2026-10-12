/**
 * Regression suite for scripts/lib/vault-transfer.js — the refusals behind
 * scripts/squad-vault-transfer.js and Steffon's `squad-vault-ops` SOP.
 *
 * WHAT IT PROTECTS.
 *
 *   1. AGENT VOTES ALONE NEVER EXECUTE ON MAINNET. The Squad is 3 of 5 and the
 *      agent holds two seats, so any third member reaches threshold; the gate
 *      demands that one of Mr. McRitchie's seats is among the approvals.
 *   2. NO DUPLICATE PROPOSAL. `send` must name the transaction_index the plan
 *      read; a moved index refuses.
 *   3. NEVER SIGN WHAT WAS NOT READ BACK. The instruction at index N must be
 *      exactly the planned transfer — program, accounts, amount.
 *   4. MONEY IS INTEGER ARITHMETIC. 6.2 SOL is 6_200_000_000 lamports, never a
 *      float's neighbour.
 *
 * Pure node stdlib, so it runs in CI's guards lane. One case builds real
 * instructions with the SDK and self-skips where no dependency tree exists.
 *
 *   npm run test:scripts
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  TransferError,
  approvalsOwed,
  assertSignerAllowed,
  checkExpectedIndex,
  checkSourceFunds,
  describeInstruction,
  executeGate,
  findMatchingIndex,
  formatAmount,
  handoff,
  indexMovedAdvice,
  matchesPlan,
  parseAmount,
  secretBytesFrom,
} = require("../lib/vault-transfer");
const { MAINNET_FORBIDDEN_SIGNERS, OPERATOR_KEYS } = require("../lib/squad-clusters");

const VAULT = "Bk9sS7iiSRL18vuo2KVzkeGw7EekKqxMCjrdoyGGdJm";
const HWQC = "HwqC6Bkvp5d5V7Z4ZX6oQ8NU5viMe36EXkXM4NoPzcXP";
const SYSTEM = "7auwTLSvNniSUeAgL6v9RStMXJhWrrUhSJgwFWLpcqC";
const GOVERNANCE = "4bKNSqkrKeggSyrds16Ak7rcB4ibvGJ4ZLsKjvQgC3Vk";
const PHANTOM = "7ZDJp7FUHhuceAqcW9CHe81hCiaMTjgWAXfprBM59Tcr";
const OTHER = "3Qj4v9qjhXgkru6zCRCErRVhy8Q6qU3NrNpvpXLTZboA";

function solTransfer(from, to, lamports) {
  const data = Buffer.alloc(12);
  data.writeUInt32LE(2, 0);
  data.writeBigUInt64LE(lamports, 4);
  return { programId: SYSTEM_PROGRAM, accounts: [from, to], data };
}

function splTransferChecked(source, mint, destination, authority, amount, decimals) {
  const data = Buffer.alloc(10);
  data[0] = 12;
  data.writeBigUInt64LE(amount, 1);
  data[9] = decimals;
  return { programId: TOKEN_PROGRAM, accounts: [source, mint, destination, authority], data };
}

const SOL_PLAN = { kind: "sol", vault: VAULT, to: HWQC, amount: 6_200_000_000n };

// --- amounts ---------------------------------------------------------------

test("amounts parse with integer arithmetic, never a float", () => {
  assert.equal(parseAmount("6.2", 9), 6_200_000_000n);
  assert.equal(parseAmount("0.000000001", 9), 1n);
  assert.equal(parseAmount("1", 6), 1_000_000n);
  assert.equal(parseAmount("0.29", 6), 290_000n);
  assert.equal(formatAmount(6_200_000_000n, 9), "6.2");
  assert.equal(formatAmount(1_000_000n, 6), "1");
});

test("a malformed, zero or over-precise amount is REFUSED", () => {
  for (const bad of ["", "-1", "1e3", "0", "0.0", "1,5", "abc", undefined]) {
    assert.throws(() => parseAmount(bad, 9), TransferError, `${bad} should refuse`);
  }
  assert.throws(() => parseAmount("1.0000001", 6), /decimal places/);
});

// --- read-back -------------------------------------------------------------

test("the read-back passes ONLY the exact planned SOL transfer", () => {
  assert.deepEqual(matchesPlan([solTransfer(VAULT, HWQC, 6_200_000_000n)], SOL_PLAN), { ok: true, reasons: [] });

  const wrongAmount = matchesPlan([solTransfer(VAULT, HWQC, 6_200_000_001n)], SOL_PLAN);
  assert.equal(wrongAmount.ok, false);
  assert.match(wrongAmount.reasons.join(), /amount/);

  assert.equal(matchesPlan([solTransfer(VAULT, PHANTOM, 6_200_000_000n)], SOL_PLAN).ok, false, "wrong destination");
  assert.equal(matchesPlan([solTransfer(HWQC, HWQC, 6_200_000_000n)], SOL_PLAN).ok, false, "wrong source");
  assert.equal(
    matchesPlan([solTransfer(VAULT, HWQC, 6_200_000_000n), solTransfer(VAULT, HWQC, 1n)], SOL_PLAN).ok,
    false,
    "a second instruction rides along"
  );
  assert.equal(matchesPlan([], SOL_PLAN).ok, false);
  const extraAccount = solTransfer(VAULT, HWQC, 6_200_000_000n);
  extraAccount.accounts.push(PHANTOM);
  assert.equal(matchesPlan([extraAccount], SOL_PLAN).ok, false, "an extra account");
});

test("the read-back passes ONLY the exact planned SPL transfer", () => {
  const plan = {
    kind: "spl",
    vault: VAULT,
    mint: "MintMintMintMintMintMintMintMintMintMint111",
    source: "SourceAtaSourceAtaSourceAtaSourceAta1111111",
    destination: "DestAtaDestAtaDestAtaDestAtaDestAta11111111",
    amount: 290_000n,
    decimals: 6,
  };
  const ix = (over = {}) => {
    const p = { ...plan, ...over };
    return splTransferChecked(p.source, p.mint, p.destination, p.vault, p.amount, p.decimals);
  };
  assert.equal(matchesPlan([ix()], plan).ok, true);
  assert.equal(matchesPlan([ix({ amount: 290_001n })], plan).ok, false);
  assert.equal(matchesPlan([ix({ destination: plan.source })], plan).ok, false);
  assert.equal(matchesPlan([ix({ vault: HWQC })], plan).ok, false, "authority must be the vault");
  assert.equal(matchesPlan([ix({ decimals: 9 })], plan).ok, false);
  assert.equal(matchesPlan([solTransfer(VAULT, HWQC, 290_000n)], plan).ok, false, "kind mismatch");
});

// --- each decoder and read-back guard, one case per guard ---------------------
// Review (2026-10-12) ran 28 guard mutants against lib/vault-transfer.js and 8
// survived. Each case below fails when exactly one guard is removed.

const SPL = {
  kind: "spl",
  vault: VAULT,
  mint: "MintMintMintMintMintMintMintMintMintMint111",
  source: "SourceAtaSourceAtaSourceAtaSourceAta1111111",
  destination: "DestAtaDestAtaDestAtaDestAtaDestAta11111111",
  amount: 290_000n,
  decimals: 6,
};
const splIx = (over = {}) => {
  const p = { ...SPL, ...over };
  return splTransferChecked(p.source, p.mint, p.destination, p.vault, p.amount, p.decimals);
};

test("a SOL-transfer layout under any program but System is not a SOL transfer", () => {
  const forged = { ...solTransfer(VAULT, HWQC, 6_200_000_000n), programId: TOKEN_PROGRAM };
  assert.equal(describeInstruction(forged).kind, "other");
  assert.equal(matchesPlan([forged], SOL_PLAN).ok, false);
  const elsewhere = { ...solTransfer(VAULT, HWQC, 6_200_000_000n), programId: "AnyOtherProgram1111111111111111111111111111" };
  assert.equal(matchesPlan([elsewhere], SOL_PLAN).ok, false);
});

test("a TransferChecked layout under any program but Token is not an SPL transfer", () => {
  const forged = { ...splIx(), programId: SYSTEM_PROGRAM };
  assert.equal(describeInstruction(forged).kind, "other");
  assert.equal(matchesPlan([forged], SPL).ok, false);
  const t22 = { ...splIx(), programId: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PE6sTDAZZTF1qTX" };
  assert.equal(matchesPlan([t22], SPL).ok, false, "Token-2022 is not the classic program");
});

test("a System instruction with the wrong discriminator or length is not a transfer", () => {
  const assign = solTransfer(VAULT, HWQC, 6_200_000_000n);
  assign.data.writeUInt32LE(3, 0); // CreateAccountWithSeed's slot, same 12 bytes
  assert.equal(describeInstruction(assign).kind, "other");
  assert.equal(matchesPlan([assign], SOL_PLAN).ok, false);

  const long = solTransfer(VAULT, HWQC, 6_200_000_000n);
  long.data = Buffer.concat([long.data, Buffer.alloc(4)]);
  assert.equal(describeInstruction(long).kind, "other", "trailing bytes are not a Transfer");
});

test("a Token instruction with the wrong discriminator or length is not TransferChecked", () => {
  const approve = splIx();
  approve.data[0] = 13; // ApproveChecked: same 10-byte layout
  assert.equal(describeInstruction(approve).kind, "other");
  assert.equal(matchesPlan([approve], SPL).ok, false);

  const long = splIx();
  long.data = Buffer.concat([long.data, Buffer.alloc(1)]);
  assert.equal(describeInstruction(long).kind, "other");
});

test("the SPL read-back checks the mint, the source and the account count, each on its own", () => {
  const wrongMint = matchesPlan([splIx({ mint: "OtherMintOtherMintOtherMintOtherMint1111111" })], SPL);
  assert.equal(wrongMint.ok, false);
  assert.deepEqual(wrongMint.reasons.map((r) => r.split(":")[0]), ["mint"]);

  const wrongSource = matchesPlan([splIx({ source: "OtherSourceOtherSourceOtherSource1111111111" })], SPL);
  assert.equal(wrongSource.ok, false);
  assert.deepEqual(wrongSource.reasons.map((r) => r.split(":")[0]), ["source"]);

  const fifth = splIx();
  fifth.accounts.push(PHANTOM);
  const extra = matchesPlan([fifth], SPL);
  assert.equal(extra.ok, false, "a 5th account (a multisig signer slot) is not the planned transfer");
  assert.deepEqual(extra.reasons.map((r) => r.split(":")[0]), ["accounts"]);
});

test("a kind mismatch is refused AS a kind mismatch, before any field is compared", () => {
  const solAgainstSpl = matchesPlan([solTransfer(VAULT, HWQC, 290_000n)], SPL);
  assert.deepEqual(solAgainstSpl.reasons, ["instruction is sol, plan is spl"]);
  const splAgainstSol = matchesPlan([splIx({ amount: 6_200_000_000n })], SOL_PLAN);
  assert.deepEqual(splAgainstSol.reasons, ["instruction is spl, plan is sol"]);
});

// --- the secret never reaches output ------------------------------------------

test("a malformed secret is refused with a FIXED message that quotes none of it", () => {
  const throwsEcho = (text) => {
    throw new Error(`Non-base58 character in ${text}`);
  };
  const malformed = [
    "[12,34,56,secretTAILabcdefghij]",
    "[1,2,3",
    `[${Array(63).fill(7).join(",")}]`,
    `[${Array(64).fill(300).join(",")}]`,
    "{\"not\":\"an array of secretbytes\"}",
    "4Nd1mXYZsecretbase58notlongenough",
    "",
  ];
  for (const raw of malformed) {
    let message = null;
    try {
      secretBytesFrom(raw, throwsEcho);
    } catch (error) {
      assert.ok(error instanceof TransferError, `${JSON.stringify(raw)} should raise TransferError`);
      message = error.message;
    }
    assert.ok(message, `${JSON.stringify(raw)} should refuse`);
    assert.match(message, /^secret is not a 64-byte (JSON array|base58 string)$/);
    // No 4-character run of the secret appears in what would be printed.
    for (let i = 0; i + 4 <= raw.length; i += 1) {
      const piece = raw.slice(i, i + 4);
      if (/^(secr|ecre|cret|JSON|arra|rray|base|ase5|se58|stri|trin|ring|byte)$/.test(piece)) continue;
      assert.ok(!message.includes(piece), `the refusal leaks ${JSON.stringify(piece)} of the secret`);
    }
  }
});

test("a well-formed secret parses in both forms", () => {
  const bytes = Array.from({ length: 64 }, (_, i) => i);
  assert.deepEqual(Array.from(secretBytesFrom(JSON.stringify(bytes), () => null)), bytes);
  assert.deepEqual(Array.from(secretBytesFrom("anything", () => Uint8Array.from(bytes))), bytes);
  assert.throws(() => secretBytesFrom("short", () => new Uint8Array(32)), /64-byte base58/);
});

// --- index moved, and source funds --------------------------------------------

test("a moved index that already carries this transfer says approve, never send again", () => {
  const candidates = [
    { index: 7n, instructions: [solTransfer(VAULT, PHANTOM, 1n)], status: "Active" },
    { index: 8n, instructions: [solTransfer(VAULT, HWQC, 6_200_000_000n)], status: "Executed" },
    { index: 9n, instructions: [solTransfer(VAULT, HWQC, 6_200_000_000n)], status: "Active" },
  ];
  assert.equal(findMatchingIndex(candidates, SOL_PLAN), 9n, "an Executed match is not resumable");
  assert.equal(findMatchingIndex(candidates.slice(0, 2), SOL_PLAN), null);
  assert.equal(
    findMatchingIndex([{ index: 10n, instructions: [solTransfer(VAULT, HWQC, 6_200_000_000n)], status: "Approved" }], SOL_PLAN),
    10n
  );
  assert.match(indexMovedAdvice(9n, "--cluster=mainnet --to=x --sol=6.2"), /approve --cluster=mainnet --to=x --sol=6\.2 --index=9/);
  assert.match(indexMovedAdvice(9n, ""), /Do NOT send again/);
  assert.match(indexMovedAdvice(null, ""), /re-plan/);
});

test("the vault must hold the amount, and an SPL vault must have the token account", () => {
  assert.doesNotThrow(() => checkSourceFunds(SOL_PLAN, { exists: true, balance: 6_200_000_000n }));
  assert.throws(() => checkSourceFunds(SOL_PLAN, { exists: true, balance: 6_199_999_999n }), /less than/);
  assert.throws(() => checkSourceFunds(SPL, { exists: false, balance: 0n }), /no token account/);
  assert.throws(() => checkSourceFunds(SPL, { exists: true, balance: 289_999n }), /less than/);
  assert.doesNotThrow(() => checkSourceFunds(SPL, { exists: true, balance: 290_000n }));
});

test("an unknown instruction is described, never guessed at", () => {
  const other = describeInstruction({ programId: "SomeProgram", accounts: [], data: Buffer.from([1, 2]) });
  assert.equal(other.kind, "other");
  assert.equal(matchesPlan([{ programId: "SomeProgram", accounts: [], data: Buffer.from([1]) }], SOL_PLAN).ok, false);
});

test("the decoder agrees with the SDK's own instruction builders", (t) => {
  let web3;
  let spl;
  try {
    web3 = require("@solana/web3.js");
    spl = require("@solana/spl-token");
  } catch (_) {
    t.skip("@solana/web3.js not installed (CI guards lane) — run bin/release-check locally");
    return;
  }
  const vault = new web3.PublicKey(VAULT);
  const to = new web3.PublicKey(HWQC);
  const built = web3.SystemProgram.transfer({ fromPubkey: vault, toPubkey: to, lamports: 6_200_000_000n });
  const plain = (ix) => ({ programId: ix.programId.toBase58(), accounts: ix.keys.map((k) => k.pubkey.toBase58()), data: ix.data });
  assert.equal(matchesPlan([plain(built)], SOL_PLAN).ok, true);

  const mint = new web3.PublicKey(OTHER);
  const source = spl.getAssociatedTokenAddressSync(mint, vault, true);
  const destination = spl.getAssociatedTokenAddressSync(mint, to);
  const splIx = spl.createTransferCheckedInstruction(source, mint, destination, vault, 290_000n, 6);
  const splPlan = {
    kind: "spl",
    vault: VAULT,
    mint: mint.toBase58(),
    source: source.toBase58(),
    destination: destination.toBase58(),
    amount: 290_000n,
    decimals: 6,
  };
  assert.equal(matchesPlan([plain(splIx)], splPlan).ok, true);
});

// --- the duplicate-proposal guard -------------------------------------------

test("send needs the index the plan read, and refuses a moved one", () => {
  assert.equal(checkExpectedIndex(6n, "6"), 7n, "the new transaction takes the next index");
  assert.throws(() => checkExpectedIndex(6n, null), /Run plan first/);
  assert.throws(() => checkExpectedIndex(7n, "6"), /transaction was created since/);
  assert.throws(() => checkExpectedIndex(6n, "six"), TransferError);
});

// --- signers ---------------------------------------------------------------

test("8K81, CytJ and Mack never sign on mainnet; devnet is not this rule", () => {
  for (const key of Object.keys(MAINNET_FORBIDDEN_SIGNERS)) {
    assert.throws(() => assertSignerAllowed(key, "mainnet-beta", MAINNET_FORBIDDEN_SIGNERS), /never signs on mainnet/);
    assert.doesNotThrow(() => assertSignerAllowed(key, "devnet", MAINNET_FORBIDDEN_SIGNERS));
  }
  assert.doesNotThrow(() => assertSignerAllowed(SYSTEM, "mainnet-beta", MAINNET_FORBIDDEN_SIGNERS));
  assert.doesNotThrow(() => assertSignerAllowed(GOVERNANCE, "mainnet-beta", MAINNET_FORBIDDEN_SIGNERS));
});

test("approvals owed are the seated agent voters that have not voted", () => {
  const seats = [{ role: "system", pubkey: SYSTEM }, { role: "governance", pubkey: GOVERNANCE }];
  const members = [
    { key: SYSTEM, mask: 7 },
    { key: GOVERNANCE, mask: 7 },
    { key: PHANTOM, mask: 7 },
  ];
  assert.deepEqual(approvalsOwed([], seats, members).map((s) => s.role), ["system", "governance"]);
  assert.deepEqual(approvalsOwed([SYSTEM], seats, members).map((s) => s.role), ["governance"]);
  assert.deepEqual(approvalsOwed([SYSTEM, GOVERNANCE], seats, members), []);
  const noVote = [{ key: SYSTEM, mask: 0b101 }, { key: GOVERNANCE, mask: 7 }];
  assert.deepEqual(approvalsOwed([], seats, noVote).map((s) => s.role), ["governance"], "a seat without Vote is skipped");
  assert.deepEqual(approvalsOwed([], seats, [{ key: SYSTEM, mask: 7 }]).map((s) => s.role), ["system"], "an unseated key is skipped");
});

// --- the execute gate: the rule Mr. McRitchie set ---------------------------

test("on mainnet, agent votes alone NEVER execute", () => {
  // Threshold 3 reached by the two agent seats plus a third non-operator member
  // would satisfy the Squads program. It does not satisfy us.
  assert.throws(
    () =>
      executeGate({
        cluster: "mainnet-beta",
        status: "Approved",
        approved: [SYSTEM, GOVERNANCE, "SomeThirdMemberThatIsNotTheOperator11111111"],
        operatorKeys: OPERATOR_KEYS,
      }),
    /agent votes alone never move the vault/
  );
});

test("on mainnet, an operator approval on chain opens the gate", () => {
  for (const operator of OPERATOR_KEYS) {
    const { operatorApprovals } = executeGate({
      cluster: "mainnet-beta",
      status: "Approved",
      approved: [SYSTEM, GOVERNANCE, operator],
      operatorKeys: OPERATOR_KEYS,
    });
    assert.deepEqual(operatorApprovals, [operator]);
  }
});

test("an Active, Rejected or Executed proposal is never executed", () => {
  for (const status of ["Active", "Rejected", "Cancelled", "Draft", null]) {
    assert.throws(
      () => executeGate({ cluster: "mainnet-beta", status, approved: [SYSTEM, GOVERNANCE, PHANTOM], operatorKeys: OPERATOR_KEYS }),
      /not Approved/
    );
  }
  assert.throws(
    () => executeGate({ cluster: "mainnet-beta", status: "Executed", approved: [PHANTOM], operatorKeys: OPERATOR_KEYS }),
    /already Executed/
  );
});

test("devnet executes on threshold alone", () => {
  assert.doesNotThrow(() =>
    executeGate({ cluster: "devnet", status: "Approved", approved: [SYSTEM, GOVERNANCE, "x"], operatorKeys: OPERATOR_KEYS })
  );
});

// --- the hand-back ---------------------------------------------------------

test("the hand-back is one link and one line, with what and how much", () => {
  const lines = handoff({
    url: "https://app.squads.so/squads/Bk9sS7iiSRL18vuo2KVzkeGw7EekKqxMCjrdoyGGdJm/transactions",
    index: 7n,
    plan: SOL_PLAN,
    symbol: "SOL",
    approvedBy: ["7auwTL", "4bKNSq"],
    operatorNames: ["7ZDJ", "9gAC", "3Qj4"],
  });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /\/squads\/Bk9sS7ii.*\/transactions$/);
  assert.match(lines[1], /^Squad tx #7: send 6\.2 SOL from the vault Bk9s/);
  assert.match(lines[1], new RegExp(HWQC));
  assert.match(lines[1], /7auwTL \+ 4bKNSq/);
  assert.match(lines[1], /7ZDJ, 9gAC, 3Qj4/);
});
