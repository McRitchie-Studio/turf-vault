/**
 * WHO SIGNS EACH STEP, read off the script itself.
 *
 * The 2026-09-15 defect was two `loadKey("…")` calls naming two people who had
 * been removed from both multisigs that morning, and only the SCRIPT TEXT can
 * answer for that class of defect: no runtime fixture proves that a name is
 * never hardcoded, because a hardcoded name is exactly what a fixture would be
 * built around. So this file grades the source — which member each call names,
 * that the measurement happens before the first spend, and that no retired
 * identity has crept back in.
 *
 * WHAT IT IS NOT. It cannot say what ORDER the calls run in, nor whether the
 * plan is consulted at all — a planner whose result is thrown away passes every
 * assertion here. That is squad-upgrade-flow.test.js's job, and it executes the
 * real script against fakes. The planner's own branches are graded in
 * squad-roles.test.js; the cluster table and squad.json's two vocabularies in
 * squad-clusters.test.js.
 *
 * No keys, no network, node stdlib only.
 *
 *   npm run test:scripts
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const XAN = "8K81w4e6UcB7TiANhM9N8sAgijJvTxxybRi8AENRaRYd";
const MASON = "CytJS23p1zCM2wvUUngiDePtbMB484ebD7bK4nDqWjrR";

const read = (name) => fs.readFileSync(path.join(__dirname, "..", name), "utf8");
const script = () => read("squad-upgrade.js");

// --- the defect this task exists for ---------------------------------------

test("the retired env vars are GONE from the script", () => {
  // `ALEX_BOT_KEY` was Xan and `MASON_KEY` was Mason. Both keys were removed
  // from both Squads multisigs at 09:41 on 2026-09-15, which left the script
  // unable to create, approve or execute an upgrade on either cluster. They may
  // appear in the header's account of what changed; they may not be LOADED.
  const src = script();

  assert.ok(
    !/loadKey\(\s*["']ALEX_BOT_KEY["']\s*\)/.test(src),
    "ALEX_BOT_KEY names a seat that no longer exists on either multisig"
  );
  assert.ok(!/loadKey\(\s*["']MASON_KEY["']\s*\)/.test(src));
  assert.ok(
    !/process\.env\.(ALEX_BOT_KEY|MASON_KEY)\b/.test(src),
    "neither retired variable may be read at all"
  );
});

test("no key is hardcoded as a named person in the signing path", () => {
  // The seats come from the cluster roster, which is intersected with live
  // membership. A base58 literal in the script itself would be a second,
  // unmeasured source of who can sign.
  const src = script();
  const withoutHeader = src.slice(src.indexOf('"use strict"'));

  for (const key of [XAN, MASON]) {
    assert.ok(
      !withoutHeader.includes(key),
      `${key} must not appear in the script body — the roster lives in scripts/lib/squad-clusters.js`
    );
  }
});

// --- the measurement, and where it sits relative to money -------------------

test("the script plans through squad-roles, against the chain's own members", () => {
  const src = script();

  assert.match(src, /planUpgrade\(/, "it must classify the run through the planner");
  assert.match(
    src,
    /multisig\.accounts\.Multisig\.fromAccountAddress/,
    "and the planner must be handed the ON-CHAIN account, never squad.json"
  );
  assert.match(
    src,
    /seats: cfg\.agentSeats/,
    "the seats offered are the cluster roster, so an unseated key drops out by measurement"
  );
});

test("the quorum is settled BEFORE the first lamport is spent", () => {
  // Under --send the extend pays SOL. A plan that ran after it would refuse with
  // the money already gone — validate-before-spend, in file order.
  const src = script();
  const planned = src.indexOf("planUpgrade({");
  const balanceCheck = src.indexOf("connection.getBalance(");
  const firstSpend = src.indexOf("buildExtendInstruction({");

  assert.ok(planned > -1, "the script must plan its signers through scripts/lib/squad-roles.js");
  assert.ok(firstSpend > -1, "the extend step moved — re-derive what the first spend is");
  assert.ok(planned < firstSpend, "planUpgrade must run before the extend transaction");
  assert.ok(
    balanceCheck < firstSpend,
    "and the fee payer's balance must be read before it is asked to pay"
  );
});

test("the transaction is read back BEFORE the first approval, in file order too", () => {
  const src = script();
  const readBack = src.indexOf("verifyUpgradeReadback(");
  const approve = src.indexOf("multisig.rpc.proposalApprove({");

  assert.ok(readBack > -1, "the read-back is the property that stops a multisig capture");
  assert.ok(approve > -1);
  assert.ok(readBack < approve, "an approval signs whatever is at that index");
});

// --- the two behaviours, as the source spells them --------------------------

test("both modes exist, and only one of them executes", () => {
  const src = script();

  assert.match(src, /plan\.mode === "handoff"/, "the handoff branch must exist");
  assert.match(src, /HANDOFF/, "and say so in words the operator reads");

  const handoffBranch = src.indexOf('plan.mode === "handoff"');
  const execute = src.indexOf("multisig.instructions.vaultTransactionExecute");
  assert.ok(
    handoffBranch < execute,
    "the handoff must RETURN before the execute, not merely log beside it"
  );
});

test("the handoff names who must approve, not just that someone must", () => {
  const src = script();

  assert.match(src, /STILL NEEDED/);
  assert.match(
    src,
    /plan\.outsideVoters\.forEach/,
    "it must enumerate the live members who can still vote"
  );
  assert.match(
    src,
    /memberName\(/,
    "and name them — a base58 string read under pressure is not an instruction"
  );
});

test("nothing decides the mode from the cluster NAME", () => {
  // One script, two behaviours, chosen by counting seats. A branch keyed on the
  // cluster would be a claim about the chain that has to be maintained by hand,
  // and the membership changed twice in one morning.
  const src = script();
  const body = src.slice(src.indexOf('"use strict"'));

  assert.ok(
    !/mode\s*=\s*.*(mainnet|devnet)/.test(body),
    "the mode must come from the measurement, never from which cluster this is"
  );
  assert.ok(
    !/cluster === "mainnet-beta"\s*\?\s*"handoff"/.test(body),
    "no cluster-keyed shortcut around the planner"
  );
});

test("one seat creates, pays and rent-pays — the SDK's signing asymmetry", () => {
  // `multisig.rpc.vaultTransactionCreate` signs `[feePayer, ...signers]` but the
  // instruction marks `creator` AND `rentPayer` as signer accounts. Splitting the
  // roles builds a transaction missing a signature, with no build-time error.
  const src = script();

  assert.match(
    src,
    /const initiatorSeat = feePayerSeat;/,
    "the creator must be the fee payer, by construction rather than by luck"
  );
  assert.match(
    src,
    /\.filter\(\(s\) => s\.mask & INITIATE\)/,
    "and the fee payer must be chosen from seats that can actually Initiate"
  );
});

// --- the ceremony's safety rails --------------------------------------------

test("the cluster is required and proved by genesis hash", () => {
  const src = script();

  assert.match(src, /getGenesisHash\(\)/);
  assert.match(src, /genesis mismatch/);
  assert.match(
    src,
    /resolveCluster\(args\.cluster\)/,
    "the cluster comes from an explicit flag, which squad-clusters refuses to default"
  );
});

test("the dry run is the DEFAULT and --send is what arms it", () => {
  const src = script();

  assert.match(src, /send: argv\.includes\("--send"\)/);
  assert.match(src, /if \(!args\.send\)/, "the dry run must return before anything is loaded");

  const dryReturn = src.indexOf("if (!args.send)");
  const keyLoad = src.indexOf("loadSeatKeypair(roster)"); // the CALL, not the definition
  assert.ok(
    dryReturn < keyLoad,
    "a dry run must read no key material at all — that is what makes it free to run"
  );
});

test("every write is followed by a poll, because each step races the next", () => {
  // Devnet needed four attempts by hand before the ceremony polled between
  // steps: the account or status the following call needs is not yet visible to
  // the node when it builds.
  const src = script();

  assert.match(src, /async function settle\(/);
  const settles = src.match(/await settle\(/g) || [];
  assert.ok(
    settles.length >= 4,
    `expected a poll after each write; found ${settles.length}`
  );
});

test("the signing keys come from env or 1Password, never argv", () => {
  const src = script();

  assert.match(src, /SQUAD_KEY_/, "the env overrides must be documented in the script");
  assert.match(src, /execFileSync\("op", \["read"/, "and 1Password is the default source");
  assert.ok(
    !/process\.argv\[[2-9]\]/.test(src),
    "no key may be read from argv — argv leaks in `ps`"
  );
  assert.match(
    src,
    /does not derive to/,
    "a loaded secret that is not the roster's key must be refused, not used"
  );
});

test("a loaded secret is never printed, not even what it derived to", () => {
  const src = script();
  const refusal = src.slice(src.indexOf("does not derive to") - 400, src.indexOf("does not derive to") + 400);

  assert.ok(
    !/keypair\.publicKey\.toBase58\(\)\}/.test(refusal),
    "the refusal must not print the address the wrong secret derived to — it is live"
  );
});

// --- the rule the whole repo hangs on ---------------------------------------

test("a successful upgrade tells the operator to re-pin the IDL hash", () => {
  // A Squads deploy does NOT update the on-chain IDL account, so `anchor idl
  // fetch` is not the source — the freshly BUILT IDL is.
  const src = script();

  assert.match(src, /RE-PIN EXPECTED_IDL_HASH/);
  assert.match(src, /does not [\s\S]{0,40}update the on-chain IDL/i);
});
