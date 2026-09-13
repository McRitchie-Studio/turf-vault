/**
 * The upgrade flow, EXECUTED — scripts/squad-upgrade.js end to end, with every
 * external boundary stubbed (narrow-bot-squads-permissions, 2026-09-13).
 *
 * WHY THIS EXISTS AND NOT ONLY THE TEXT SCAN. squad-upgrade-signers.test.js
 * reads the script and asserts which member each call names. That catches the
 * defect (an approval cast as the bot) but proves nothing about the ORDER the
 * calls actually happen in, nor that the plan is consulted at all — a planner
 * whose result is thrown away passes every text assertion. So this file RUNS
 * the real script against fakes and grades the sequence it produces:
 *
 *   1. the signer plan is computed BEFORE the ProgramData extend, which spends;
 *   2. the vault transaction is created by the BOT (its Initiate bit);
 *   3. the proposal is opened by a HUMAN, with the bot paying the rent;
 *   4. BOTH approvals are cast by HUMANS — never by the bot, which is the whole
 *      point: the bot's key is on disk and in Heroku config, so a bot vote plus
 *      one leaked human key would be quorum;
 *   5. execute is the BOT (its Execute bit).
 *
 * NOTHING REAL IS TOUCHED. @solana/web3.js, @sqds/multisig and bs58 are replaced
 * in the module loader, so there is no RPC, no signature and no transaction. The
 * "keys" are fixed non-secret strings; the only real file read is the committed
 * scripts/squad.json, which holds public addresses.
 *
 *   npm run test:scripts
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

const SCRIPT = path.join(__dirname, "..", "squad-upgrade.js");

// Fixed, worthless stand-ins for the three env keys. No secret is involved:
// the fake Keypair below ignores the bytes and keys off the string itself.
const BOT_SECRET = "TEST-BOT-KEY-NOT-A-SECRET";
const ALEX_SECRET = "TEST-ALEX-KEY-NOT-A-SECRET";
const MASON_SECRET = "TEST-MASON-KEY-NOT-A-SECRET";

const BOT = "8K81w4e6UcB7TiANhM9N8sAgijJvTxxybRi8AENRaRYd";
const ALEX = "7ZDJp7FUHhuceAqcW9CHe81hCiaMTjgWAXfprBM59Tcr";
const MASON = "CytJS23p1zCM2wvUUngiDePtbMB484ebD7bK4nDqWjrR";
const PUBKEY_FOR = {
  [BOT_SECRET]: BOT,
  [ALEX_SECRET]: ALEX,
  [MASON_SECRET]: MASON,
};

/** Runs the real script under stubbed modules; returns the call trace. */
async function runUpgrade({
  masks = { [BOT]: 5, [ALEX]: 7, [MASON]: 7 },
  threshold = 2,
} = {}) {
  const trace = [];
  let finished;
  const done = new Promise((resolve) => {
    finished = resolve;
  });

  class FakePublicKey {
    constructor(v) {
      this.v = typeof v === "object" && v !== null ? v.v : String(v);
    }
    toBase58() {
      return this.v;
    }
    toBuffer() {
      return Buffer.from(this.v);
    }
    static findProgramAddressSync() {
      return [
        new FakePublicKey("ProgramDataPda1111111111111111111111111111"),
        255,
      ];
    }
  }

  const keypair = (secret) => ({
    secret,
    publicKey: new FakePublicKey(PUBKEY_FOR[secret] || `unknown:${secret}`),
  });

  const fakeWeb3 = {
    PublicKey: FakePublicKey,
    SystemProgram: {
      programId: new FakePublicKey("11111111111111111111111111111111"),
    },
    Keypair: { fromSecretKey: (bytes) => keypair(String(bytes)) },
    Connection: class {
      async getAccountInfo() {
        // Buffer bigger than ProgramData, so the extend branch runs and spends.
        return { data: Buffer.alloc(4096) };
      }
      async getLatestBlockhash() {
        return { blockhash: "FakeBlockhash", lastValidBlockHeight: 1 };
      }
      async sendTransaction() {
        trace.push({ step: "sendTransaction" });
        return "FAKE_SIG";
      }
      async confirmTransaction() {
        return { value: { err: null } };
      }
      async getSignatureStatuses() {
        return { value: [{ confirmationStatus: "confirmed", err: null }] };
      }
      async simulateTransaction() {
        return { value: { err: null, logs: [] } };
      }
    },
    TransactionMessage: class {
      constructor(args) {
        Object.assign(this, args);
      }
      compileToV0Message() {
        return {};
      }
    },
    TransactionInstruction: class {
      constructor(args) {
        Object.assign(this, args);
      }
    },
    VersionedTransaction: class {
      constructor() {}
      sign(signers) {
        trace.push({
          step: "sign",
          signers: signers.map((s) => s.publicKey.toBase58()),
        });
      }
    },
    ComputeBudgetProgram: {
      setComputeUnitLimit: () => ({ kind: "cu-limit" }),
      setComputeUnitPrice: () => ({ kind: "cu-price" }),
    },
  };

  const fakeMultisig = {
    accounts: {
      Multisig: {
        async fromAccountAddress() {
          trace.push({ step: "readMultisig" });
          return {
            threshold,
            transactionIndex: 41,
            members: Object.entries(masks).map(([key, mask]) => ({
              key: new FakePublicKey(key),
              permissions: { mask },
            })),
          };
        },
      },
    },
    utils: { toBigInt: (v) => BigInt(v) },
    rpc: {
      async vaultTransactionCreate(args) {
        trace.push({
          step: "vaultTransactionCreate",
          member: args.creator.toBase58(),
        });
        return "SIG";
      },
      async proposalCreate(args) {
        trace.push({
          step: "proposalCreate",
          member: args.creator.publicKey.toBase58(),
          rentPayer: args.rentPayer && args.rentPayer.publicKey.toBase58(),
        });
        return "SIG";
      },
      async proposalApprove(args) {
        trace.push({
          step: "proposalApprove",
          member: args.member.publicKey.toBase58(),
        });
        return "SIG";
      },
    },
    instructions: {
      async vaultTransactionExecute(args) {
        trace.push({
          step: "vaultTransactionExecute",
          member: args.member.toBase58(),
        });
        return { instruction: { kind: "exec" }, lookupTableAccounts: [] };
      },
    },
  };

  const stubs = {
    "@solana/web3.js": fakeWeb3,
    "@sqds/multisig": fakeMultisig,
    bs58: { default: { decode: (s) => s } },
  };

  const originalLoad = Module._load;
  const originalArgv = process.argv;
  const originalEnv = { ...process.env };
  const originalExit = process.exit;
  const originalLog = console.log;
  let exitCode = null;

  Module._load = function (request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(stubs, request))
      return stubs[request];
    return originalLoad.apply(this, arguments);
  };
  process.argv = [
    "node",
    SCRIPT,
    "BufferAddr111111111111111111111111111111111",
  ];
  process.env.ALEX_BOT_KEY = BOT_SECRET;
  process.env.ALEX_KEY = ALEX_SECRET;
  process.env.MASON_KEY = MASON_SECRET;
  process.env.SOLANA_RPC_URL = "http://127.0.0.1:1/never-called";
  // Record and return — never throw. The script calls process.exit from inside
  // its own promise chain, and a throw there lands as asynchronous activity
  // after the test has ended, which node:test fails the whole FILE for.
  process.exit = (code) => {
    exitCode = code;
    finished();
  };
  console.log = (...args) => {
    const line = args.join(" ");
    trace.push({ step: "log", line });
    if (line.includes("Upgrade executed")) finished();
  };

  try {
    delete require.cache[require.resolve(SCRIPT)];
    require(SCRIPT);
    // A bounded wait: the script is an async IIFE, so `done` fires from its own
    // success log or from the stubbed process.exit. The timer is cleared either
    // way — a stray one outlives the test and node:test fails the FILE for it.
    let timer;
    await Promise.race([
      done,
      new Promise((r) => {
        timer = setTimeout(r, 5000);
        timer.unref();
      }),
    ]);
    clearTimeout(timer);
    // Let the script's own promise chain settle before the stubs come back out.
    await new Promise((r) => setImmediate(r));
  } finally {
    Module._load = originalLoad;
    process.argv = originalArgv;
    process.env = originalEnv;
    process.exit = originalExit;
    console.log = originalLog;
    delete require.cache[require.resolve(SCRIPT)];
  }

  return { trace, exitCode };
}

const steps = (trace, step) => trace.filter((t) => t.step === step);
const indexOf = (trace, step) => trace.findIndex((t) => t.step === step);

test("the executed flow: bot initiates, humans propose and approve, bot executes", async () => {
  const { trace, exitCode } = await runUpgrade();

  assert.equal(
    exitCode,
    null,
    `the script must not exit early: ${JSON.stringify(trace.slice(-3))}`
  );

  const approvals = steps(trace, "proposalApprove").map((t) => t.member);
  assert.deepEqual(
    approvals,
    [ALEX, MASON],
    "both approvals are cast by the humans, in order"
  );
  assert.ok(!approvals.includes(BOT), "no approval may be cast by the bot");

  assert.equal(
    steps(trace, "vaultTransactionCreate")[0].member,
    BOT,
    "the bot initiates the vault tx"
  );
  assert.equal(
    steps(trace, "vaultTransactionExecute")[0].member,
    BOT,
    "the bot executes"
  );

  const proposal = steps(trace, "proposalCreate")[0];
  assert.equal(proposal.member, ALEX, "a human opens the proposal");
  assert.equal(
    proposal.rentPayer,
    BOT,
    "the bot pays the proposal rent, so the humans need no SOL"
  );
});

test("the quorum is read and settled BEFORE the extend transaction spends", async () => {
  const { trace } = await runUpgrade();

  const read = indexOf(trace, "readMultisig");
  const firstSpend = indexOf(trace, "sendTransaction");

  assert.ok(read > -1, "the script must read the multisig account");
  assert.ok(
    firstSpend > -1,
    "the extend step must still spend in this fixture, or the ordering is untested"
  );
  assert.ok(
    read < firstSpend,
    "the signer plan must be settled before the first lamport is spent"
  );

  const quorumLine = trace.find(
    (t) => t.step === "log" && /quorum:/.test(t.line || "")
  );
  assert.ok(quorumLine, "the run must state its quorum");
  assert.match(quorumLine.line, /2 human approval\(s\) vs threshold 2/);
});

test("the same flow holds while the bot still carries mask 7 — this half lands first", async () => {
  const { trace } = await runUpgrade({
    masks: { [BOT]: 7, [ALEX]: 7, [MASON]: 7 },
  });

  assert.deepEqual(
    steps(trace, "proposalApprove").map((t) => t.member),
    [ALEX, MASON]
  );
});

test("a bot that lost Execute stops the run BEFORE anything is spent", async () => {
  const { trace, exitCode } = await runUpgrade({
    masks: { [BOT]: 3, [ALEX]: 7, [MASON]: 7 },
  });

  assert.equal(exitCode, 1, "a refused plan must exit non-zero");
  assert.equal(
    steps(trace, "sendTransaction").length,
    0,
    "nothing may be sent once the plan is refused"
  );
  assert.equal(steps(trace, "proposalApprove").length, 0);
  const failure = trace.find(
    (t) => t.step === "log" && /FAILED/.test(t.line || "")
  );
  assert.ok(!failure || /Execute/.test(failure.line));
});

test("a threshold the two humans cannot reach stops the run", async () => {
  const { trace, exitCode } = await runUpgrade({ threshold: 3 });

  assert.equal(exitCode, 1);
  assert.equal(steps(trace, "sendTransaction").length, 0);
});
