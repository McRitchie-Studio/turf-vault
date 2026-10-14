/**
 * The seat rotation, EXECUTED — scripts/ceremony/rotate-admin-seat.js end to
 * end, with every external boundary stubbed (the squad-upgrade-flow.test.js
 * pattern).
 *
 * admin-seat-rotation.test.js grades the pure plan; this file proves the
 * SCRIPT consults it: that a dry run signs nothing and prints the plan with
 * its stale warning, that the agents' half (create + the two agent votes)
 * stops short of execute, and that execute refuses until Mr. McRitchie's
 * approval is on chain.
 *
 * NOTHING REAL IS TOUCHED. @solana/web3.js, @sqds/multisig, bs58 and
 * child_process are replaced in the module loader: no RPC, no signature, no
 * 1Password read. The fake `op read` returns the seat's PUBLIC key as its
 * "secret", and the fake Keypair passes it straight through, so the script's
 * own derivation check still compares against the roster.
 *
 *   npm run test:scripts
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

const SCRIPT = path.join(__dirname, "..", "ceremony", "rotate-admin-seat.js");
const { AGENT_SEATS, GENESIS } = require("../lib/squad-clusters");

const SYSTEM = "7auwTLSvNniSUeAgL6v9RStMXJhWrrUhSJgwFWLpcqC";
const GOV = "4bKNSqkrKeggSyrds16Ak7rcB4ibvGJ4ZLsKjvQgC3Vk";
const GOV_V2 = "3LTLPG1s952sdNatZWtnfM7r9F3ivWSnPSqfhQLBepJ9";
const ALEX = "7ZDJp7FUHhuceAqcW9CHe81hCiaMTjgWAXfprBM59Tcr";
const ALEX_TWO = "3Qj4v9qjhXgkru6zCRCErRVhy8Q6qU3NrNpvpXLTZboA";
const ALEX_THREE = "9gACbzsCLmkYF9Yx1EBGmwMvvyfuTquJ6qs8QsoQvHXf";
const CONFIG_DISC = [1, 2, 3, 4, 5, 6, 7, 8];
const PAIR_ARGS = [`--old=${GOV}`, `--new=${GOV_V2}`];

class FakePublicKey {
  constructor(k) {
    this.k = String(k);
  }
  toBase58() {
    return this.k;
  }
  toBytes() {
    return Buffer.from(this.k);
  }
  equals(o) {
    return o && o.k === this.k;
  }
  static isOnCurve() {
    return true;
  }
}

/**
 * Run the real script against a fake mainnet Squad.
 * @param {{argv: string[], chain?: {status?: string, approved?: string[], members?: string[]}}} opts
 */
async function runRotation({ argv, chain = {} }) {
  const trace = [];
  let exitCode = null;
  let finished;
  const done = new Promise((r) => (finished = r));

  const members = (chain.members || [SYSTEM, ALEX_TWO, GOV, ALEX, ALEX_THREE]).map((k) => ({
    key: new FakePublicKey(k),
    permissions: { mask: 7 },
  }));
  // Index 10 holds the rotation when the chain says so; 11 is always empty.
  const store = new Map();
  const proposal = { status: chain.status || "Active", approved: [...(chain.approved || [])] };
  if (chain.status) {
    store.set("tx-10", {
      data: Buffer.from([...CONFIG_DISC, 0]),
      tx: {
        actions: [
          { __kind: "RemoveMember", oldMember: new FakePublicKey(GOV) },
          { __kind: "AddMember", newMember: { key: new FakePublicKey(GOV_V2), permissions: { mask: 7 } } },
        ],
      },
    });
    store.set("pr-10", { data: Buffer.alloc(8) });
  }

  const fakeWeb3 = {
    LAMPORTS_PER_SOL: 1e9,
    PublicKey: FakePublicKey,
    Keypair: { fromSecretKey: (bytes) => ({ publicKey: new FakePublicKey(bytes.__pubkey) }) },
    Connection: class {
      async getGenesisHash() {
        return GENESIS["mainnet-beta"];
      }
      async getAccountInfo(pda) {
        return store.get(pda.toBase58()) || null;
      }
      async getBalance() {
        return 1e9;
      }
    },
  };

  const fakeMultisig = {
    getTransactionPda: ({ index }) => [new FakePublicKey(`tx-${index}`)],
    getProposalPda: ({ transactionIndex }) => [new FakePublicKey(`pr-${transactionIndex}`)],
    types: {
      Permission: { Initiate: 1, Vote: 2, Execute: 4 },
      Permissions: { fromPermissions: (ps) => ({ mask: ps.reduce((a, b) => a | b, 0) }) },
    },
    accounts: {
      configTransactionDiscriminator: CONFIG_DISC,
      ConfigTransaction: { fromAccountInfo: (info) => [info.tx] },
      Proposal: {
        async fromAccountAddress() {
          return { status: { __kind: proposal.status }, approved: proposal.approved.map((k) => new FakePublicKey(k)) };
        },
      },
      Multisig: {
        async fromAccountAddress() {
          return { members, threshold: 3, transactionIndex: chain.status ? 10n : 9n, staleTransactionIndex: 6n };
        },
      },
    },
    rpc: {
      async configTransactionCreate(args) {
        trace.push({ step: "configTransactionCreate", member: args.creator.toBase58(), actions: args.actions });
        store.set("tx-10", { data: Buffer.from([...CONFIG_DISC, 0]), tx: { actions: args.actions } });
        return "SIG";
      },
      async proposalCreate(args) {
        trace.push({ step: "proposalCreate", member: args.creator.publicKey.toBase58() });
        store.set("pr-10", { data: Buffer.alloc(8) });
        return "SIG";
      },
      async proposalApprove(args) {
        const member = args.member.publicKey.toBase58();
        trace.push({ step: "proposalApprove", member });
        proposal.approved.push(member);
        return "SIG";
      },
      async configTransactionExecute(args) {
        trace.push({ step: "configTransactionExecute", member: args.member.publicKey.toBase58() });
        members.splice(members.findIndex((m) => m.key.k === GOV), 1, { key: new FakePublicKey(GOV_V2), permissions: { mask: 7 } });
        return "SIG";
      },
    },
  };

  // `op read op://<vault>/<item>/<field>` -> that seat's pubkey, recorded.
  const fakeChildProcess = {
    execFileSync(cmd, argv) {
      const item = String(argv[1]).split("/")[3];
      const seat = AGENT_SEATS["mainnet-beta"].find((s) => s.item === item);
      trace.push({ step: "op-read", item });
      if (!seat) throw new Error(`no fake secret for ${item}`);
      return seat.pubkey;
    },
  };
  const decode = (text) => {
    const bytes = new Uint8Array(64);
    bytes.__pubkey = text;
    return bytes;
  };

  const stubs = {
    "@solana/web3.js": fakeWeb3,
    "@sqds/multisig": fakeMultisig,
    bs58: { decode, default: { decode } },
    child_process: fakeChildProcess,
  };

  const originalLoad = Module._load;
  const originalArgv = process.argv;
  const originalEnv = { ...process.env };
  const originalExit = process.exit;
  const originalLog = console.log;
  const originalError = console.error;
  const originalTimeout = global.setTimeout;

  Module._load = function (request) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    return originalLoad.apply(this, arguments);
  };
  process.argv = ["node", SCRIPT, "--cluster=mainnet", ...argv];
  process.env.OP_ADMIN_SERVICE_ACCOUNT_TOKEN = "fake-admin-token"; // never leaves the fake op
  delete process.env.SOLANA_RPC_URL;

  // A stubbed exit must HALT, or "nothing signed after the refusal" tests a
  // script that never refused (see squad-upgrade-flow.test.js).
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
    if (/DRY RUN|Nothing executed|AFTER \(read back at finalized\)|HANDOFF|already approved/.test(line)) setImmediate(finished);
  };
  console.log = capture("log");
  console.error = capture("error");
  // The script's settle() polls with 1.5 s sleeps; the fake chain is instant.
  global.setTimeout = (fn, _ms, ...rest) => originalTimeout(fn, 0, ...rest);

  try {
    delete require.cache[require.resolve(SCRIPT)];
    try {
      require(SCRIPT);
    } catch (e) {
      if (!(e instanceof Halt)) throw e;
    }
    let timer;
    await Promise.race([done, new Promise((r) => (timer = originalTimeout(r, 8000)))]);
    clearTimeout(timer);
    await new Promise((r) => setImmediate(r));
  } finally {
    Module._load = originalLoad;
    process.argv = originalArgv;
    process.env = originalEnv;
    process.exit = originalExit;
    console.log = originalLog;
    console.error = originalError;
    global.setTimeout = originalTimeout;
    delete require.cache[require.resolve(SCRIPT)];
  }
  return { trace, exitCode };
}

const signed = (trace) => trace.filter((t) => t.step !== "log" && t.step !== "error");
const text = (trace) => trace.filter((t) => t.step === "log" || t.step === "error").map((t) => t.line).join("\n");

test("the mainnet plan is read-only: it prints the swap and the stale warning and signs nothing", async () => {
  const { trace, exitCode } = await runRotation({ argv: PAIR_ARGS });
  assert.equal(exitCode, null, text(trace));
  assert.deepEqual(signed(trace), [], "no rpc call and no 1Password read in a dry run");
  const out = text(trace);
  assert.match(out, new RegExp(`OUT ${GOV}`));
  assert.match(out, new RegExp(`IN ${GOV_V2}`));
  assert.match(out, /PLAN — ONE atomic config transaction at #10, creator system/);
  assert.match(out, /mask 7; threshold stays 3/);
  assert.match(out, /STALE WARNING \(Squads error 6007\)/);
  assert.match(out, /DRY RUN — nothing sent/);
});

test("no --old refuses before any chain read", async () => {
  const { trace, exitCode } = await runRotation({ argv: [`--new=${GOV_V2}`] });
  assert.equal(exitCode, 2);
  assert.match(text(trace), /--old <pubkey> is REQUIRED/);
  assert.deepEqual(signed(trace), []);
});

test("a new key that is already seated refuses the plan", async () => {
  const { trace, exitCode } = await runRotation({
    argv: [`--old=${GOV}`, `--new=${ALEX}`],
  });
  assert.equal(exitCode, 1);
  assert.match(text(trace), /ALREADY a member/);
  assert.deepEqual(signed(trace), []);
});

test("the agents' half: create, system votes, the outgoing 4bKN votes, and NOTHING executes", async () => {
  const { trace, exitCode } = await runRotation({
    argv: [...PAIR_ARGS, "--send", "--and-approve-as=governance", "--allow-outgoing-signer"],
  });
  assert.equal(exitCode, null, text(trace));
  const calls = signed(trace).filter((t) => t.step !== "op-read");
  assert.deepEqual(
    calls.map((t) => `${t.step} ${t.member}`),
    [`configTransactionCreate ${SYSTEM}`, `proposalCreate ${SYSTEM}`, `proposalApprove ${SYSTEM}`, `proposalApprove ${GOV}`]
  );
  const add = calls[0].actions[1];
  assert.equal(add.newMember.key.toBase58(), GOV_V2);
  assert.equal(add.newMember.permissions.mask, 7, "the old member's mask carries over");
  assert.equal(calls[0].actions[0].oldMember.toBase58(), GOV);
  const out = text(trace);
  assert.match(out, /the outgoing key approves its own removal/);
  assert.match(out, /HANDOFF — Mr. McRitchie approves #10/);
  assert.match(out, /app\.squads\.so\/squads\/.+\/transactions/);
});

test("the outgoing key's vote without --allow-outgoing-signer refuses before anything is created", async () => {
  const { trace, exitCode } = await runRotation({ argv: [...PAIR_ARGS, "--send", "--and-approve-as=governance"] });
  assert.equal(exitCode, 2);
  assert.match(text(trace), /needs --allow-outgoing-signer/);
  assert.deepEqual(signed(trace), []);
});

test("execute refuses while only the two agent votes are on chain", async () => {
  const { trace, exitCode } = await runRotation({
    argv: [...PAIR_ARGS, "--execute", "--index=10", "--send"],
    chain: { status: "Active", approved: [SYSTEM, GOV] },
  });
  assert.equal(exitCode, 1);
  assert.match(text(trace), /not executable yet/);
  assert.match(text(trace), /2 approval\(s\) on chain, the threshold is 3/);
  assert.deepEqual(signed(trace), [], "no key read, nothing executed");
});

test("execute refuses an Approved proposal that carries no operator approval", async () => {
  const { trace, exitCode } = await runRotation({
    argv: [...PAIR_ARGS, "--execute", "--index=10", "--send"],
    chain: { status: "Approved", approved: [SYSTEM, GOV, "GF4sojG9tHF2kC3jpgto1gd3b1nXLuUiAcsAiYi5Y5vb"] },
  });
  assert.equal(exitCode, 1);
  assert.match(text(trace), /no approval from Mr\. McRitchie's seats/);
  assert.deepEqual(signed(trace), []);
});

test("after Mr. McRitchie's click, the system seat executes and the read-back shows 3LTL in, 4bKN out", async () => {
  const { trace, exitCode } = await runRotation({
    argv: [...PAIR_ARGS, "--execute", "--index=10", "--send"],
    chain: { status: "Approved", approved: [SYSTEM, GOV, ALEX] },
  });
  assert.equal(exitCode, null, text(trace));
  const calls = signed(trace).filter((t) => t.step !== "op-read");
  assert.deepEqual(calls.map((t) => `${t.step} ${t.member}`), [`configTransactionExecute ${SYSTEM}`]);
  assert.deepEqual(
    signed(trace).filter((t) => t.step === "op-read").map((t) => t.item),
    ["solana.turf.system"],
    "only the system seat's key is read; the outgoing key never executes"
  );
  const after = text(trace).split("AFTER (read back at finalized)")[1];
  assert.ok(after.includes(GOV_V2) && !after.includes(GOV));
});
