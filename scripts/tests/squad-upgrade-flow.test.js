/**
 * The upgrade flow, EXECUTED — scripts/squad-upgrade.js end to end, with every
 * external boundary stubbed.
 *
 * WHY THIS EXISTS AND NOT ONLY THE TEXT SCAN. squad-upgrade-signers.test.js
 * reads the script and asserts which member each call names. That says nothing
 * about the ORDER the calls happen in, nor whether the plan is consulted at all
 * — a planner whose result is thrown away passes every text assertion. So this
 * file RUNS the real script against fakes and grades the sequence.
 *
 * AND IT IS THE ONLY PLACE THE TWO BEHAVIOURS ARE PROVEN TO BE TWO. The whole
 * point of the 2026-09-15 rewrite is that ONE script either finishes an upgrade
 * or stops for a human, decided by counting seats on the live multisig. The two
 * cases below are the SAME script, the SAME arguments, and differ only in the
 * membership the fake chain reports:
 *
 *   devnet   3 of 5, three seats agent-held  → approves three times, EXECUTES
 *   mainnet  3 of 5, two seats agent-held    → approves twice, STOPS, names who
 *
 * NOTHING REAL IS TOUCHED. @solana/web3.js, @sqds/multisig and bs58 are replaced
 * in the module loader, so there is no RPC, no signature and no transaction. The
 * "keys" are fixed non-secret strings supplied through the SQUAD_KEY_* env
 * overrides, so 1Password is never consulted either. The only real file read is
 * the committed scripts/squad.json, which holds public addresses.
 *
 *   npm run test:scripts
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

const SCRIPT = path.join(__dirname, "..", "squad-upgrade.js");
const SQUAD = JSON.parse(
  require("node:fs").readFileSync(path.join(__dirname, "..", "squad.json"), "utf8")
);

// Live public keys, used here only as distinguishable identities.
const SYSTEM = "7auwTLSvNniSUeAgL6v9RStMXJhWrrUhSJgwFWLpcqC";
const SYSTEM_DEVNET = "2eGs8G3wzhEeNQQU2Q86BmmA2xTpDbMMae3Y1bvpZfx9";
const ADMIN = "BLSBw8fXHzZc5pbaYCKMpMSsrtXBTbWXpUPVzMrXx9oo";
const XAN = "8K81w4e6UcB7TiANhM9N8sAgijJvTxxybRi8AENRaRYd";
const ALEX = "7ZDJp7FUHhuceAqcW9CHe81hCiaMTjgWAXfprBM59Tcr";
const ALEX_TWO = "3Qj4v9qjhXgkru6zCRCErRVhy8Q6qU3NrNpvpXLTZboA";
const ALEX_THREE = "9gACbzsCLmkYF9Yx1EBGmwMvvyfuTquJ6qs8QsoQvHXf";
const MASON = "CytJS23p1zCM2wvUUngiDePtbMB484ebD7bK4nDqWjrR";

const BUFFER = "BAGqkbHMwMxxCEhSJHbYCTuHA1KXZuEBZ3Dca2TR3xCt";
const PROGRAM_DATA = "ProgramDataPda11111111111111111111111111111";
const RENT = "SysvarRent111111111111111111111111111111111";
const CLOCK = "SysvarC1ock11111111111111111111111111111111";

const LIVE = {
  devnet: {
    threshold: 3,
    members: [SYSTEM_DEVNET, ALEX_TWO, ALEX, XAN, ADMIN],
    vault: SQUAD.devnet.vaultPda,
    program: SQUAD.devnet.programId,
    genesis: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  },
  mainnet: {
    threshold: 3,
    members: [SYSTEM, ALEX_TWO, ALEX, ALEX_THREE, ADMIN],
    vault: SQUAD.vaultPda,
    program: SQUAD.programId,
    genesis: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  },
};

/**
 * ProgramData's account data, with the upgrade authority at bytes 13..45 where
 * the real account carries it. The fake PublicKey reads a Buffer back as UTF-8,
 * so the authority round-trips through the same slice the script uses.
 */
function programDataBuffer(authority, size = 600_000) {
  const data = Buffer.alloc(size);
  Buffer.from(authority, "utf8").copy(data, 13);
  return data;
}

/** Runs the real script under stubbed modules; returns the trace. */
async function runUpgrade({
  cluster = "devnet",
  threshold,
  members,
  masks = {},
  balances = {},
  send = false,
  extraArgs = [],
  onChainTransaction = null, // null = index is empty, so the script creates one
  programDataSize = 600_000,
  omitCluster = false,
} = {}) {
  const live = LIVE[cluster];
  const memberKeys = members || live.members;
  const trace = [];
  let finished;
  const done = new Promise((resolve) => {
    finished = resolve;
  });
  let exitCode = null;

  // Every address this fixture can produce. The script reads the upgrade
  // authority out of ProgramData as a 32-BYTE slice, which on the real chain
  // base58-encodes back to a full 44-character address. This fixture stores
  // UTF-8 in those 32 bytes, so the slice truncates — the lookup below expands
  // it again, rather than the test asserting against a truncated address.
  const KNOWN_ADDRESSES = [
    SYSTEM, SYSTEM_DEVNET, ADMIN, XAN, ALEX, ALEX_TWO, ALEX_THREE, MASON,
    BUFFER, PROGRAM_DATA, RENT, CLOCK,
    LIVE.devnet.vault, LIVE.devnet.program, LIVE.mainnet.vault, LIVE.mainnet.program,
  ];

  class FakePublicKey {
    constructor(v) {
      if (v instanceof FakePublicKey) this.v = v.v;
      else if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
        const text = Buffer.from(v).toString("utf8").replace(/\0+$/, "");
        this.v = KNOWN_ADDRESSES.find((k) => k.startsWith(text) && text.length > 8) || text;
      } else this.v = String(v);
    }
    toBase58() {
      return this.v;
    }
    toBuffer() {
      return Buffer.from(this.v, "utf8");
    }
    equals(other) {
      return this.v === other.v;
    }
    static findProgramAddressSync() {
      return [new FakePublicKey(PROGRAM_DATA), 255];
    }
  }

  const keypair = (pubkey) => ({ publicKey: new FakePublicKey(pubkey) });

  const accountData = {
    [PROGRAM_DATA]: programDataBuffer(live.vault, programDataSize),
    [BUFFER]: Buffer.alloc(540_000),
  };

  const fakeWeb3 = {
    PublicKey: FakePublicKey,
    // bs58.decode below returns a 64-length Uint8Array tagged with the address
    // it came from, because the script checks the decoded LENGTH before handing
    // it to Keypair.fromSecretKey. A stub that returned the string unchanged
    // would fail that length check and never reach the derivation guard this
    // fixture exists to exercise.
    Keypair: { fromSecretKey: (v) => keypair(v && v.__pubkey ? v.__pubkey : String(v)) },
    ComputeBudgetProgram: {
      setComputeUnitLimit: () => ({ kind: "cu-limit" }),
      setComputeUnitPrice: () => ({ kind: "cu-price" }),
    },
    Connection: class {
      async getGenesisHash() {
        return live.genesis;
      }
      async getAccountInfo(address) {
        const key = address.toBase58();
        if (accountData[key]) {
          return { data: accountData[key], lamports: 2_800_000_000 };
        }
        if (key === "TransactionPda" && onChainTransaction) {
          return { data: Buffer.from(onChainTransaction.discriminator), lamports: 1 };
        }
        if (key === "ProposalPda" && onChainTransaction?.proposalExists) {
          return { data: Buffer.alloc(8), lamports: 1 };
        }
        // Accounts created during THIS run become visible to later reads.
        if (created.has(key)) return { data: created.get(key), lamports: 1 };
        return null;
      }
      async getBalance(address) {
        const key = address.toBase58();
        return balances[key] ?? 5 * 1_000_000_000;
      }
      async getMinimumBalanceForRentExemption(bytes) {
        return bytes * 7_000;
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
        trace.push({ step: "sign", signers: signers.map((s) => s.publicKey.toBase58()) });
      }
    },
  };

  const created = new Map();
  const VAULT_DISC = [168, 250, 162, 100, 81, 14, 162, 207];
  const CONFIG_DISC = [94, 8, 4, 35, 113, 139, 139, 112];
  let approvals = [];

  /** The message the chain would hold for the upgrade this run intends. */
  const honestMessage = (spill) => ({
    accountKeys: [
      "BPFLoaderUpgradeab1e11111111111111111111111",
      PROGRAM_DATA,
      live.program,
      BUFFER,
      spill,
      RENT,
      CLOCK,
      live.vault,
    ].map((k) => new FakePublicKey(k)),
    instructions: [
      {
        programIdIndex: 0,
        accountIndexes: Uint8Array.from([1, 2, 3, 4, 5, 6, 7]),
        data: Uint8Array.from([3, 0, 0, 0]),
      },
    ],
    addressTableLookups: [],
  });

  let storedMessage = null;

  const fakeMultisig = {
    accounts: {
      vaultTransactionDiscriminator: VAULT_DISC,
      configTransactionDiscriminator: CONFIG_DISC,
      batchDiscriminator: [156, 194, 70, 44, 22, 88, 137, 44],
      Multisig: {
        async fromAccountAddress() {
          trace.push({ step: "readMultisig" });
          return {
            threshold,
            transactionIndex: 18,
            members: memberKeys.map((key) => ({
              key: new FakePublicKey(key),
              permissions: { mask: masks[key] ?? 7 },
            })),
          };
        },
      },
      VaultTransaction: {
        async fromAccountAddress() {
          return { message: onChainTransaction?.message || storedMessage };
        },
      },
      Proposal: {
        async fromAccountAddress() {
          return {
            status: { __kind: approvals.length >= threshold ? "Approved" : "Active" },
            approved: approvals.map((k) => new FakePublicKey(k)),
          };
        },
      },
    },
    utils: { toBigInt: (v) => BigInt(v) },
    getTransactionPda: () => [new FakePublicKey("TransactionPda")],
    getProposalPda: () => [new FakePublicKey("ProposalPda")],
    rpc: {
      async vaultTransactionCreate(args) {
        trace.push({ step: "vaultTransactionCreate", member: args.creator.toBase58() });
        storedMessage = honestMessage(
          args.transactionMessage.instructions[0].keys[3].pubkey.toBase58()
        );
        created.set("TransactionPda", Buffer.from(VAULT_DISC));
        return "SIG";
      },
      async proposalCreate(args) {
        trace.push({ step: "proposalCreate", member: args.creator.publicKey.toBase58() });
        created.set("ProposalPda", Buffer.alloc(8));
        return "SIG";
      },
      async proposalApprove(args) {
        const member = args.member.publicKey.toBase58();
        trace.push({ step: "proposalApprove", member });
        approvals.push(member);
        return "SIG";
      },
    },
    instructions: {
      async vaultTransactionExecute(args) {
        trace.push({ step: "vaultTransactionExecute", member: args.member.toBase58() });
        return { instruction: { kind: "exec" }, lookupTableAccounts: [] };
      },
    },
  };

  const stubs = {
    "@solana/web3.js": fakeWeb3,
    "@sqds/multisig": fakeMultisig,
    bs58: (() => {
      const decode = (text) => {
        const bytes = new Uint8Array(64);
        bytes.__pubkey = text;
        return bytes;
      };
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
  process.argv = [
    "node",
    SCRIPT,
    BUFFER,
    ...(omitCluster ? [] : [`--cluster=${cluster}`]),
    ...(send ? ["--send"] : []),
    ...extraArgs,
  ];
  // Env overrides, so the run never shells out to `op`. The "secret" IS the
  // public key: the stubbed bs58/Keypair pair passes it straight through, and
  // the script's own derivation check then compares it to the roster.
  process.env.SQUAD_KEY_SYSTEM = cluster === "devnet" ? SYSTEM_DEVNET : SYSTEM;
  process.env.SQUAD_KEY_ADMIN = ADMIN;
  process.env.SQUAD_KEY_XAN = XAN;
  delete process.env.SOLANA_RPC_URL;

  // THE STUBBED EXIT MUST HALT, or the assertions are worthless. The real
  // process.exit stops the script dead; a stub that merely RECORDS lets
  // execution run on past a refusal, so "nothing was approved after the
  // refusal" would be testing a script that never refused at all. So the first
  // call throws a sentinel, which unwinds through the script's own trailing
  // .catch — and that catch's re-exit is swallowed, because exitCode is already
  // set. Nothing throws after the test has ended, which node:test would fail
  // the whole FILE for.
  class Halt extends Error {}
  process.exit = (code) => {
    if (exitCode !== null) return undefined;
    exitCode = code;
    finished();
    throw new Halt("halted by the test harness");
  };
  const capture = (sink) => (...args) => {
    const line = args.join(" ");
    if (/halted by the test harness/.test(line)) return; // the sentinel unwinding
    trace.push({ step: sink, line });
    if (/DRY RUN|HANDOFF —|Upgrade executed on/.test(line)) finished();
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

  return { trace, exitCode };
}

const steps = (trace, step) => trace.filter((t) => t.step === step);
const indexOf = (trace, step) => trace.findIndex((t) => t.step === step);
const lines = (trace) =>
  trace.filter((t) => t.step === "log" || t.step === "error").map((t) => t.line).join("\n");

// --- the two behaviours, from the same script and the same arguments --------

test("DEVNET reaches quorum, so the run approves three times and EXECUTES", async () => {
  const { trace, exitCode } = await runUpgrade({ cluster: "devnet", threshold: 3, send: true });

  assert.equal(exitCode, null, `the run must not exit early:\n${lines(trace)}`);
  assert.match(lines(trace), /MODE: AUTONOMOUS/);

  assert.deepEqual(
    steps(trace, "proposalApprove").map((t) => t.member),
    [SYSTEM_DEVNET, ADMIN, XAN],
    "all three agent seats vote"
  );
  assert.equal(steps(trace, "vaultTransactionExecute").length, 1, "and the run executes");
  assert.match(lines(trace), /Upgrade executed on devnet/);
  assert.match(
    lines(trace),
    /RE-PIN EXPECTED_IDL_HASH/,
    "a Squads deploy does not update the on-chain IDL; the run must say so"
  );
});

test("MAINNET is one seat short, so the SAME run approves twice and STOPS", async () => {
  const { trace, exitCode } = await runUpgrade({ cluster: "mainnet", threshold: 3, send: true });

  assert.equal(exitCode, null, `a handoff is a success, not a failure:\n${lines(trace)}`);
  assert.match(lines(trace), /MODE: HANDOFF/);

  assert.deepEqual(
    steps(trace, "proposalApprove").map((t) => t.member),
    [SYSTEM, ADMIN],
    "the two agent seats vote"
  );
  assert.equal(
    steps(trace, "vaultTransactionExecute").length,
    0,
    "NOTHING may execute — the approval that would authorise it has not been cast"
  );

  const out = lines(trace);
  assert.match(out, /STILL NEEDED: 1 more approval/);
  for (const operator of [ALEX, ALEX_TWO, ALEX_THREE]) {
    assert.match(out, new RegExp(operator), `the handoff must name ${operator}`);
  }
  assert.match(out, /WHAT YOU ARE APPROVING/, "and print what he is signing");
});

test("the mode follows the COUNT: lower mainnet's threshold and it executes", async () => {
  // Same cluster, same roster, same two seats — only the threshold moves. If the
  // branch were keyed on the cluster name rather than on the measurement, this
  // would still hand off.
  const { trace } = await runUpgrade({ cluster: "mainnet", threshold: 2, send: true });

  assert.match(lines(trace), /MODE: AUTONOMOUS/);
  assert.equal(steps(trace, "vaultTransactionExecute").length, 1);
});

test("the creator IS the fee payer, because the SDK signs with the fee payer alone", async () => {
  // `multisig.rpc.vaultTransactionCreate` signs `[feePayer, ...signers]`, while
  // the instruction marks BOTH `creator` and `rentPayer` as signer accounts. A
  // creator that is not the fee payer therefore produces a transaction missing a
  // required signature — with no build-time error, only a rejected send. The
  // script collapses the roles onto one seat; this proves it stays collapsed,
  // and picks the seat by BALANCE rather than by roster order.
  const { trace } = await runUpgrade({
    cluster: "devnet",
    threshold: 3,
    send: true,
    balances: { [SYSTEM_DEVNET]: 1_000_000_000, [ADMIN]: 9_000_000_000, [XAN]: 2_000_000_000 },
  });

  const creator = steps(trace, "vaultTransactionCreate")[0].member;
  const proposer = steps(trace, "proposalCreate")[0].member;

  assert.equal(creator, ADMIN, "the best-funded Initiate-capable seat creates");
  assert.equal(proposer, ADMIN, "and opens the proposal, so it pays that rent too");
  assert.match(lines(trace), /fee payer AND creator: admin/);
});

test("a seat that cannot Initiate is never chosen to create, however rich", async () => {
  const { trace } = await runUpgrade({
    cluster: "devnet",
    threshold: 3,
    send: true,
    masks: { [XAN]: 6 }, // Vote|Execute — rich, but cannot open a transaction
    balances: { [SYSTEM_DEVNET]: 1_000_000_000, [ADMIN]: 2_000_000_000, [XAN]: 9_000_000_000 },
  });

  assert.equal(
    steps(trace, "vaultTransactionCreate")[0].member,
    ADMIN,
    "the richest seat holds no Initiate bit, so the next-best one creates"
  );
  assert.deepEqual(
    steps(trace, "proposalApprove").map((t) => t.member),
    [SYSTEM_DEVNET, ADMIN, XAN],
    "it can still vote — Initiate and Vote are different bits"
  );
});

// --- the read-back, in the executed order -----------------------------------

test("the transaction is read back BEFORE the first approval, not after", async () => {
  const { trace } = await runUpgrade({ cluster: "devnet", threshold: 3, send: true });

  const readBack = trace.findIndex((t) => /read-back/.test(t.line || ""));
  const firstApproval = indexOf(trace, "proposalApprove");

  assert.ok(readBack > -1, "the run must state that it read the transaction back");
  assert.ok(firstApproval > -1);
  assert.ok(
    readBack < firstApproval,
    "an approval signs whatever is at that index — reading it back afterwards proves nothing"
  );
});

test("a CONFIG transaction at the resumed index is REFUSED before any approval", async () => {
  // The capture case: approving a config transaction believing it is an upgrade
  // hands over membership. It must refuse in words, and cast nothing.
  const { trace, exitCode } = await runUpgrade({
    cluster: "devnet",
    threshold: 3,
    send: true,
    extraArgs: ["--index=11"],
    onChainTransaction: {
      discriminator: [94, 8, 4, 35, 113, 139, 139, 112],
      proposalExists: false,
    },
  });

  assert.equal(exitCode, 1);
  assert.match(lines(trace), /CONFIG transaction/);
  assert.equal(steps(trace, "proposalApprove").length, 0, "nothing may be approved");
  assert.equal(steps(trace, "vaultTransactionExecute").length, 0);
});

test("a vault transaction whose BUFFER is not the planned one is REFUSED", async () => {
  const { trace, exitCode } = await runUpgrade({
    cluster: "devnet",
    threshold: 3,
    send: true,
    extraArgs: ["--index=13"],
    onChainTransaction: {
      discriminator: [168, 250, 162, 100, 81, 14, 162, 207],
      proposalExists: false,
      message: {
        accountKeys: [
          "BPFLoaderUpgradeab1e11111111111111111111111",
          PROGRAM_DATA,
          LIVE.devnet.program,
          "SomeOtherBuffer1111111111111111111111111111",
          XAN,
          RENT,
          CLOCK,
          LIVE.devnet.vault,
        ].map((k) => ({ toBase58: () => k })),
        instructions: [
          {
            programIdIndex: 0,
            accountIndexes: Uint8Array.from([1, 2, 3, 4, 5, 6, 7]),
            data: Uint8Array.from([3, 0, 0, 0]),
          },
        ],
        addressTableLookups: [],
      },
    },
  });

  assert.equal(exitCode, 1);
  assert.match(lines(trace), /on-chain buffer is SomeOtherBuffer/);
  assert.equal(steps(trace, "proposalApprove").length, 0);
});

// --- refusals before anything is spent --------------------------------------

test("a roster with NO seated key refuses before reading a balance", async () => {
  // The literal 09:41 state, generalised: the multisig no longer contains any
  // key this run can offer.
  const { trace, exitCode } = await runUpgrade({
    cluster: "mainnet",
    threshold: 3,
    members: [ALEX, ALEX_TWO, ALEX_THREE, MASON, XAN],
    send: true,
  });

  assert.equal(exitCode, 1);
  assert.match(lines(trace), /is a member of this multisig/);
  assert.equal(steps(trace, "sendTransaction").length, 0);
  assert.equal(steps(trace, "vaultTransactionCreate").length, 0);
});

test("an under-funded fee payer refuses, naming the number and the real error", async () => {
  const { trace, exitCode } = await runUpgrade({
    cluster: "mainnet",
    threshold: 3,
    send: true,
    balances: { [SYSTEM]: 1000, [ADMIN]: 500 },
  });

  assert.equal(exitCode, 1);
  const out = lines(trace);
  assert.match(out, /holds 0\.0000 SOL/);
  assert.match(
    out,
    /no record of a prior credit/,
    "the refusal must name the error it is standing in for, which names nothing itself"
  );
  assert.equal(steps(trace, "vaultTransactionCreate").length, 0);
});

test("a genesis hash that is not the named cluster's refuses immediately", async () => {
  const original = LIVE.devnet.genesis;
  LIVE.devnet.genesis = "SomeOtherChain11111111111111111111111111111";
  try {
    const { trace, exitCode } = await runUpgrade({ cluster: "devnet", threshold: 3, send: true });
    assert.equal(exitCode, 1);
    assert.match(lines(trace), /genesis mismatch/);
    assert.equal(steps(trace, "readMultisig").length, 0, "not even the membership is read");
  } finally {
    LIVE.devnet.genesis = original;
  }
});

test("an upgrade authority that is NOT this vault refuses before creating anything", async () => {
  // A proposal routed through the wrong vault can never execute, and without
  // this check the run would only discover that after paying for the
  // transaction account and casting its own approvals.
  const original = LIVE.devnet.vault;
  LIVE.devnet.vault = LIVE.mainnet.vault; // ProgramData now names the OTHER cluster's vault
  try {
    const { trace, exitCode } = await runUpgrade({ cluster: "devnet", threshold: 3, send: true });

    assert.equal(exitCode, 1);
    assert.match(lines(trace), /upgrade authority is/);
    assert.match(lines(trace), /can never execute/);
    assert.equal(steps(trace, "readMultisig").length, 0, "it refuses before reading membership");
  } finally {
    LIVE.devnet.vault = original;
  }
});

// --- the dry run ------------------------------------------------------------

test("a DRY RUN reads no key material and sends nothing", async () => {
  const { trace, exitCode } = await runUpgrade({ cluster: "mainnet", threshold: 3, send: false });

  assert.equal(exitCode, null);
  const out = lines(trace);
  assert.match(out, /DRY RUN — nothing signed, nothing sent, no key material read/);
  assert.match(out, /MODE: HANDOFF/, "it still classifies the run");
  assert.match(out, /steps this run would take/, "and names every step");

  assert.equal(steps(trace, "vaultTransactionCreate").length, 0);
  assert.equal(steps(trace, "proposalCreate").length, 0);
  assert.equal(steps(trace, "proposalApprove").length, 0);
  assert.equal(steps(trace, "sendTransaction").length, 0);
  assert.equal(steps(trace, "sign").length, 0);
});

test("a run with no --cluster refuses without touching the network", async () => {
  const { trace, exitCode } = await runUpgrade({
    cluster: "devnet",
    threshold: 3,
    omitCluster: true,
  });

  assert.equal(exitCode, 1);
  assert.match(lines(trace), /--cluster=devnet\|mainnet is REQUIRED/);
  assert.equal(steps(trace, "readMultisig").length, 0);
});
