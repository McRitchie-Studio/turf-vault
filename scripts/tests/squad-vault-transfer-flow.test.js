/**
 * squad-vault-transfer, EXECUTED — scripts/squad-vault-transfer.js run end to
 * end against a fake chain, graded on the ORDER of what it does.
 *
 * WHY THIS EXISTS. vault-transfer.test.js grades every decision the script
 * makes, but only as library functions. That cannot see the WIRING: a script
 * that reads the transaction back AFTER it approves, or reads it and ignores the
 * verdict, passes every library test. Carl's note on squad-vault-ops-sop
 * (activity-18011): "Script wiring (readBack before sign) is untested; only lib
 * is." This file runs the real script and asserts the sequence:
 *
 *   approve / execute   the transaction at --index is read back and graded
 *                       BEFORE any key is loaded and BEFORE any signature.
 *   send                the create is the one signature that must come first
 *                       (there is nothing to read back before it exists); every
 *                       APPROVAL comes after a graded read-back of what landed.
 *
 * and that a read-back which does NOT match the plan stops the run with nothing
 * (more) signed.
 *
 * NOTHING REAL IS TOUCHED. @solana/web3.js, @sqds/multisig and bs58 are replaced
 * in the module loader: no RPC, no signature, no transaction. The "secrets" are
 * the seats' PUBLIC keys passed through the SQUAD_KEY_* env overrides, so
 * 1Password is never consulted. The only real file read is scripts/squad.json,
 * which holds public addresses.
 *
 *   npm run test:scripts
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const Module = require("node:module");

const SCRIPT = path.join(__dirname, "..", "squad-vault-transfer.js");
const SQUAD = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "squad.json"), "utf8"));

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const VAULT = SQUAD.vaultPda;
const MULTISIG = SQUAD.multisigPda;
const SYSTEM = "7auwTLSvNniSUeAgL6v9RStMXJhWrrUhSJgwFWLpcqC";
const GOVERNANCE = "4bKNSqkrKeggSyrds16Ak7rcB4ibvGJ4ZLsKjvQgC3Vk";
const ALEX = "7ZDJp7FUHhuceAqcW9CHe81hCiaMTjgWAXfprBM59Tcr";
const ALEX_TWO = "3Qj4v9qjhXgkru6zCRCErRVhy8Q6qU3NrNpvpXLTZboA";
const ALEX_THREE = "9gACbzsCLmkYF9Yx1EBGmwMvvyfuTquJ6qs8QsoQvHXf";
const HWQC = "HwqC6Bkvp5d5V7Z4ZX6oQ8NU5viMe36EXkXM4NoPzcXP";
const LAMPORTS = 6_200_000_000n; // --sol=6.2

/** A vault transaction message carrying one SOL transfer, as the SDK decodes it. */
function solMessage(from, to, lamports) {
  const data = Buffer.alloc(12);
  data.writeUInt32LE(2, 0);
  data.writeBigUInt64LE(BigInt(lamports), 4);
  return {
    vaultIndex: 0,
    keys: [from, to, SYSTEM_PROGRAM],
    instructions: [{ programIdIndex: 2, accountIndexes: Uint8Array.from([0, 1]), data }],
  };
}

/**
 * Runs the real script under stubbed modules against a fake chain.
 *
 * `chain.transactions` / `chain.proposals` are keyed by index (a Number).
 * `tamperCreate` makes the chain store a DIFFERENT amount than the create asked
 * for — the case the post-create read-back exists to catch.
 */
async function runTransfer({ mode, extraArgs = [], current = 9, transactions = {}, proposals = {}, tamperCreate = false }) {
  const trace = [];
  let exitCode = null;
  let finished;
  const done = new Promise((resolve) => {
    finished = resolve;
  });
  const chain = {
    transactions: new Map(Object.entries(transactions).map(([k, v]) => [Number(k), v])),
    proposals: new Map(
      Object.entries(proposals).map(([k, v]) => [Number(k), { status: v.status, approved: [...v.approved] }])
    ),
  };
  const members = [SYSTEM, ALEX_TWO, ALEX, ALEX_THREE, GOVERNANCE];
  const threshold = 3;

  class FakePublicKey {
    constructor(v) {
      this.v = v instanceof FakePublicKey ? v.v : String(v);
    }
    toBase58() {
      return this.v;
    }
    toString() {
      return this.v;
    }
    equals(other) {
      return other && this.v === other.v;
    }
  }
  FakePublicKey.default = new FakePublicKey(SYSTEM_PROGRAM);
  FakePublicKey.isOnCurve = () => true;

  // A "secret" is the pubkey's UTF-8 in the first bytes of 64. The script copies
  // the decoded bytes (Uint8Array.from) and zeroes its copy AFTER deriving the
  // keypair, so the pubkey must be read out at fromSecretKey time.
  const encodeSecret = (pubkey) => {
    const bytes = new Uint8Array(64);
    bytes.set(Buffer.from(pubkey, "utf8"));
    return bytes;
  };
  const decodeSecret = (bytes) => Buffer.from(bytes).toString("utf8").replace(/\0+$/, "");

  const indexOfPda = (pda, prefix) => Number(pda.toBase58().slice(prefix.length));

  const fakeWeb3 = {
    LAMPORTS_PER_SOL: 1_000_000_000,
    PublicKey: FakePublicKey,
    Keypair: {
      fromSecretKey: (bytes) => {
        const pubkey = decodeSecret(bytes);
        trace.push({ step: "keyLoaded", pubkey });
        return { publicKey: new FakePublicKey(pubkey) };
      },
    },
    ComputeBudgetProgram: {
      setComputeUnitLimit: () => ({ kind: "cu-limit" }),
      setComputeUnitPrice: () => ({ kind: "cu-price" }),
    },
    SystemProgram: {
      transfer: ({ fromPubkey, toPubkey, lamports }) => ({
        kind: "sol-transfer",
        from: fromPubkey.toBase58(),
        to: toPubkey.toBase58(),
        lamports: BigInt(lamports),
      }),
    },
    TransactionMessage: class {
      constructor(args) {
        Object.assign(this, args);
      }
      compileToV0Message() {
        return { instructions: this.instructions };
      }
    },
    VersionedTransaction: class {
      constructor(message) {
        this.message = message;
      }
      sign(signers) {
        trace.push({
          step: "sign",
          kinds: this.message.instructions.map((ix) => ix.kind).filter((k) => !k.startsWith("cu-")),
          signers: signers.map((s) => s.publicKey.toBase58()),
        });
      }
    },
    Connection: class {
      async getGenesisHash() {
        return MAINNET_GENESIS;
      }
      async getBalance() {
        return 100 * 1_000_000_000;
      }
      async getAccountInfo() {
        return null;
      }
      async getLatestBlockhash() {
        return { blockhash: "FakeBlockhash", lastValidBlockHeight: 1 };
      }
      async sendTransaction(tx) {
        // The fake chain applies what the transaction carries.
        for (const ix of tx.message.instructions) {
          if (ix.kind === "create") {
            const t = ix.transactionMessage.instructions[0];
            chain.transactions.set(ix.index, solMessage(t.from, t.to, tamperCreate ? t.lamports + 1n : t.lamports));
          } else if (ix.kind === "propose") {
            chain.proposals.set(ix.index, { status: "Active", approved: [] });
          } else if (ix.kind === "approve") {
            const p = chain.proposals.get(ix.index);
            p.approved.push(ix.member);
            if (p.approved.length >= threshold) p.status = "Approved";
          } else if (ix.kind === "execute") {
            chain.proposals.get(ix.index).status = "Executed";
          }
        }
        trace.push({ step: "sendTransaction" });
        return "FAKE_SIG";
      }
      async confirmTransaction() {
        return { value: { err: null } };
      }
      async getSignatureStatus() {
        return { value: null };
      }
    },
  };

  const fakeMultisig = {
    getVaultPda: () => [new FakePublicKey(VAULT)],
    getTransactionPda: ({ index }) => [new FakePublicKey(`Tx${index}`)],
    getProposalPda: ({ transactionIndex }) => [new FakePublicKey(`Prop${transactionIndex}`)],
    accounts: {
      Multisig: {
        async fromAccountAddress() {
          return {
            threshold,
            transactionIndex: BigInt(current),
            members: members.map((key) => ({ key: new FakePublicKey(key), permissions: { mask: 7 } })),
          };
        },
      },
      VaultTransaction: {
        async fromAccountAddress(_connection, pda) {
          const index = indexOfPda(pda, "Tx");
          trace.push({ step: "readBack", index });
          const t = chain.transactions.get(index);
          if (!t) throw new Error(`no vault transaction at ${index}`);
          return {
            vaultIndex: t.vaultIndex,
            message: {
              accountKeys: t.keys.map((k) => new FakePublicKey(k)),
              instructions: t.instructions,
            },
          };
        },
      },
      Proposal: {
        async fromAccountAddress(_connection, pda) {
          const p = chain.proposals.get(indexOfPda(pda, "Prop"));
          if (!p) throw new Error("no proposal");
          return { status: { __kind: p.status }, approved: p.approved.map((k) => new FakePublicKey(k)) };
        },
      },
    },
    instructions: {
      vaultTransactionCreate: (args) => ({
        kind: "create",
        index: Number(args.transactionIndex),
        transactionMessage: args.transactionMessage,
      }),
      proposalCreate: (args) => ({ kind: "propose", index: Number(args.transactionIndex) }),
      proposalApprove: (args) => ({
        kind: "approve",
        index: Number(args.transactionIndex),
        member: args.member.toBase58(),
      }),
      async vaultTransactionExecute(args) {
        return { instruction: { kind: "execute", index: Number(args.transactionIndex) } };
      },
    },
  };

  const stubs = {
    "@solana/web3.js": fakeWeb3,
    "@sqds/multisig": fakeMultisig,
    bs58: (() => {
      const decode = (text) => encodeSecret(text);
      return { decode, default: { decode } };
    })(),
  };

  const originalLoad = Module._load;
  const originalArgv = process.argv;
  const originalEnv = { ...process.env };
  const originalExit = process.exit;
  const originalLog = console.log;
  const originalError = console.error;

  Module._load = function (request) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    return originalLoad.apply(this, arguments);
  };
  process.argv = ["node", SCRIPT, mode, "--cluster=mainnet", `--to=${HWQC}`, "--sol=6.2", ...extraArgs];
  process.env.SQUAD_KEY_SYSTEM = SYSTEM;
  process.env.SQUAD_KEY_GOVERNANCE = GOVERNANCE;
  delete process.env.SOLANA_RPC_URL;

  // The stubbed exit must HALT, or a refusal would run on (see
  // squad-upgrade-flow.test.js for the full reasoning).
  class Halt extends Error {}
  process.exit = (code) => {
    if (exitCode !== null) return undefined;
    exitCode = code;
    finished();
    throw new Halt("halted by the test harness");
  };
  const capture = (sink) => (...args) => {
    const line = args.join(" ");
    if (/halted by the test harness/.test(line)) return;
    trace.push({ step: sink, line });
    if (/HAND-BACK|EXECUTED #|to queue it/.test(line)) finished();
  };
  console.log = capture("log");
  console.error = capture("error");

  try {
    delete require.cache[require.resolve(SCRIPT)];
    require(SCRIPT);
    let timer;
    await Promise.race([
      done,
      new Promise((r) => {
        timer = setTimeout(r, 8000);
        timer.unref();
      }),
    ]);
    clearTimeout(timer);
    await new Promise((r) => setImmediate(r));
  } finally {
    Module._load = originalLoad;
    process.argv = originalArgv;
    process.env = originalEnv;
    process.exit = originalExit;
    console.log = originalLog;
    console.error = originalError;
    delete require.cache[require.resolve(SCRIPT)];
  }

  return { trace, exitCode, chain };
}

const steps = (trace, step) => trace.filter((t) => t.step === step);
const first = (trace, pred) => trace.findIndex(pred);
const lines = (trace) =>
  trace.filter((t) => t.step === "log" || t.step === "error").map((t) => t.line).join("\n");
/** The graded (non-quiet) read-back prints this line, with its verdict. */
const isVerdict = (t) => t.step === "log" && /^ {3}instruction: /.test(t.line);
const isMatchVerdict = (t) => isVerdict(t) && /EXACTLY the planned transfer/.test(t.line);
const isSign = (t) => t.step === "sign";
const signsOf = (trace, kind) => steps(trace, "sign").filter((t) => t.kinds.includes(kind));

const HONEST_9 = { 9: solMessage(VAULT, HWQC, LAMPORTS) };
const TAMPERED_9 = { 9: solMessage(VAULT, HWQC, LAMPORTS + 1n) };

// --- approve -----------------------------------------------------------------

test("APPROVE reads the transaction back and grades it before any key or signature", async () => {
  const { trace, exitCode } = await runTransfer({
    mode: "approve",
    extraArgs: ["--index=9"],
    transactions: HONEST_9,
    proposals: { 9: { status: "Active", approved: [] } },
  });

  assert.equal(exitCode, null, lines(trace));
  const verdict = first(trace, isMatchVerdict);
  const firstKey = first(trace, (t) => t.step === "keyLoaded");
  const firstSign = first(trace, isSign);
  assert.ok(verdict > -1, `the run must grade the read-back:\n${lines(trace)}`);
  assert.ok(firstSign > -1, "and then approve");
  assert.ok(verdict < firstKey, "no key is read before the read-back is graded");
  assert.ok(verdict < firstSign, "no signature before the read-back is graded");
  assert.deepEqual(
    signsOf(trace, "approve").map((t) => t.signers[t.signers.length - 1]),
    [SYSTEM, GOVERNANCE],
    "both agent seats approve"
  );
  assert.match(lines(trace), /HAND-BACK/);
});

test("APPROVE of an index that is NOT the planned transfer signs nothing and reads no key", async () => {
  const { trace, exitCode } = await runTransfer({
    mode: "approve",
    extraArgs: ["--index=9"],
    transactions: TAMPERED_9,
    proposals: { 9: { status: "Active", approved: [] } },
  });

  assert.equal(exitCode, 1);
  assert.match(lines(trace), /MISMATCH — amount/);
  assert.match(lines(trace), /is not the planned transfer; nothing signed/);
  assert.equal(steps(trace, "sign").length, 0, "nothing is signed");
  assert.equal(steps(trace, "sendTransaction").length, 0);
  assert.equal(steps(trace, "keyLoaded").length, 0, "no key material is even read");
});

test("APPROVE of a proposal that is not Active is refused, with nothing signed and no key read", async () => {
  // Carl's surviving mutant on squad-tools-hardening (activity-18036): deleting
  // this check passed the suite, because Squads also rejects an approve on a
  // non-Active proposal on chain. The script refuses first, so an Approved or
  // Executed proposal never costs a fee or a signature from an agent seat.
  for (const status of ["Approved", "Executed", "Rejected", "Cancelled", "Draft"]) {
    const { trace, exitCode } = await runTransfer({
      mode: "approve",
      extraArgs: ["--index=9"],
      transactions: HONEST_9,
      proposals: { 9: { status, approved: status === "Approved" ? [SYSTEM, GOVERNANCE, ALEX] : [] } },
    });
    assert.equal(exitCode, 1, `${status}:\n${lines(trace)}`);
    assert.match(lines(trace), new RegExp(`proposal #9 is ${status}, not Active`));
    assert.equal(steps(trace, "sign").length, 0, `${status}: nothing is signed`);
    assert.equal(steps(trace, "keyLoaded").length, 0, `${status}: no key is read`);
  }

  // A transaction with no proposal account at all is refused the same way.
  const none = await runTransfer({ mode: "approve", extraArgs: ["--index=9"], transactions: HONEST_9 });
  assert.equal(none.exitCode, 1);
  assert.match(lines(none.trace), /proposal #9 is null, not Active/);
  assert.equal(steps(none.trace, "sign").length, 0);
});

// --- execute -----------------------------------------------------------------

test("EXECUTE reads the transaction back and grades it before any key or signature", async () => {
  const { trace, exitCode, chain } = await runTransfer({
    mode: "execute",
    extraArgs: ["--index=9"],
    transactions: HONEST_9,
    proposals: { 9: { status: "Approved", approved: [SYSTEM, GOVERNANCE, ALEX] } },
  });

  assert.equal(exitCode, null, lines(trace));
  const verdict = first(trace, isMatchVerdict);
  assert.ok(verdict > -1);
  assert.ok(verdict < first(trace, (t) => t.step === "keyLoaded"), "no key before the read-back");
  assert.ok(verdict < first(trace, isSign), "no signature before the read-back");
  assert.equal(signsOf(trace, "execute").length, 1);
  assert.equal(chain.proposals.get(9).status, "Executed");
});

test("EXECUTE of an index that is NOT the planned transfer signs nothing", async () => {
  const { trace, exitCode, chain } = await runTransfer({
    mode: "execute",
    extraArgs: ["--index=9"],
    transactions: TAMPERED_9,
    proposals: { 9: { status: "Approved", approved: [SYSTEM, GOVERNANCE, ALEX] } },
  });

  assert.equal(exitCode, 1);
  assert.equal(steps(trace, "sign").length, 0);
  assert.equal(steps(trace, "keyLoaded").length, 0);
  assert.equal(chain.proposals.get(9).status, "Approved", "nothing executed");
});

test("EXECUTE with only agent approvals on mainnet signs nothing (the gate is wired in)", async () => {
  const { trace, exitCode } = await runTransfer({
    mode: "execute",
    extraArgs: ["--index=9"],
    transactions: HONEST_9,
    // Approved by threshold, but the third vote is not one of his seats.
    proposals: { 9: { status: "Approved", approved: [SYSTEM, GOVERNANCE, "ThirdNonOperatorMember11111111111111111111"] } },
  });

  assert.equal(exitCode, 1);
  assert.match(lines(trace), /no approval from Mr\. McRitchie's seats/);
  assert.equal(steps(trace, "sign").length, 0);
  assert.equal(steps(trace, "keyLoaded").length, 0);
});

// --- send --------------------------------------------------------------------

test("SEND: the create signs first, and every APPROVAL follows a graded read-back of what landed", async () => {
  const { trace, exitCode, chain } = await runTransfer({ mode: "send", extraArgs: ["--expect-index=9"] });

  assert.equal(exitCode, null, lines(trace));
  const create = first(trace, (t) => isSign(t) && t.kinds.includes("create"));
  const verdict = first(trace, isMatchVerdict);
  const firstApprove = first(trace, (t) => isSign(t) && t.kinds.includes("approve"));
  assert.ok(create > -1 && verdict > -1 && firstApprove > -1, lines(trace));
  assert.ok(create < verdict, "the read-back reads what the create landed");
  assert.ok(verdict < firstApprove, "an approval signs whatever is at the index: read it back first");
  assert.ok(
    trace.slice(create + 1, verdict).every((t) => !isSign(t)),
    "no signature between the create and the graded read-back"
  );
  assert.deepEqual(chain.proposals.get(10).approved, [SYSTEM, GOVERNANCE]);
});

test("SEND whose created transaction reads back DIFFERENT signs no approval", async () => {
  const { trace, exitCode, chain } = await runTransfer({
    mode: "send",
    extraArgs: ["--expect-index=9"],
    tamperCreate: true,
  });

  assert.equal(exitCode, 1);
  assert.match(lines(trace), /MISMATCH — amount/);
  assert.equal(signsOf(trace, "create").length, 1, "the create is the only signature");
  assert.equal(signsOf(trace, "approve").length, 0, "nothing is approved");
  assert.deepEqual(chain.proposals.get(10).approved, []);
});
