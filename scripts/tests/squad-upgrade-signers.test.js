/**
 * THE DEFECT ITSELF, read off the script: who casts the two approvals on a
 * mainnet upgrade (narrow-bot-squads-permissions, 2026-09-13).
 *
 * `scripts/squad-upgrade.js` approved as ALEX BOT and as Mason. The bot key
 * lives in Heroku config and on disk, so with a Vote bit a leaked bot key plus
 * ANY ONE human key reached the 2-of-3 quorum over mainnet upgrade authority.
 * Mr. McRitchie's decision (activity-8875): both HUMANS approve, and the bot
 * loses Vote (mask 5). The script must stop voting as the bot BEFORE that mask
 * lands, or the multisig ships a permission the tooling violates.
 *
 * This file grades the SCRIPT, not a description of it: the defect was one
 * argument on one line, and only the line can answer for it. The planner's own
 * behaviour is graded in squad-roles.test.js.
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

const BOT = "8K81w4e6UcB7TiANhM9N8sAgijJvTxxybRi8AENRaRYd";
const ALEX = "7ZDJp7FUHhuceAqcW9CHe81hCiaMTjgWAXfprBM59Tcr";
const MASON = "CytJS23p1zCM2wvUUngiDePtbMB484ebD7bK4nDqWjrR";

const script = () =>
  fs.readFileSync(path.join(__dirname, "..", "squad-upgrade.js"), "utf8");

// --- the committed documentation must still describe this ceremony ----------

test("squad.json still documents three members and a threshold of 2", () => {
  // Documentation only — the planner is handed the on-chain account. This
  // guard exists so a FOURTH member, or a changed threshold, fails here and
  // sends the reader back to the ceremony in credential-rotation.md rather
  // than quietly changing who can reach quorum.
  const cfg = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "squad.json"), "utf8")
  );

  assert.equal(cfg.threshold, 2);
  assert.deepEqual(Object.keys(cfg.members).sort(), [
    "alex",
    "alex_bot",
    "mason",
  ]);
  assert.equal(cfg.members.alex_bot, BOT);
  assert.equal(cfg.members.alex, ALEX);
  assert.equal(cfg.members.mason, MASON);
});

test("squad-upgrade.js approves as two humans and never as the bot", () => {
  // The planner can only bind what the script asks it to bind. This reads the
  // script itself, because the defect was one argument on one line.
  const src = fs.readFileSync(
    path.join(__dirname, "..", "squad-upgrade.js"),
    "utf8"
  );
  const approvals = src.match(/proposalApprove\(\{[\s\S]*?\}\)/g) || [];

  assert.equal(approvals.length, 2, "two approvals, one per human");
  for (const call of approvals) {
    assert.ok(
      !/member:\s*alexBot\b/.test(call),
      "no approval may be cast as the bot"
    );
  }
  assert.ok(/member:\s*alex\b/.test(approvals.join("\n")), "Alex approves");
  assert.ok(/member:\s*mason\b/.test(approvals.join("\n")), "Mason approves");
});

test("the quorum is settled BEFORE the first lamport is spent", () => {
  // The ProgramData extend pays SOL. A plan that runs after it would refuse
  // with the money already gone — validate-before-spend, in file order.
  const src = script();
  const planned = src.indexOf("planUpgradeSigners(");
  const firstSpend = src.indexOf("sendAndConfirm(connection, [extendIx]");

  assert.ok(
    planned > -1,
    "the script must plan its signers through scripts/lib/squad-roles.js"
  );
  assert.ok(
    firstSpend > -1,
    "the extend step moved — re-derive what the first spend is"
  );
  assert.ok(
    planned < firstSpend,
    "planUpgradeSigners must run before the extend transaction"
  );
});

test("the bot still initiates and executes, and still pays", () => {
  const src = script();

  assert.match(
    src,
    /vaultTransactionCreate\(\{[\s\S]*?creator: alexBot\.publicKey/,
    "the bot initiates the vault tx"
  );
  assert.match(
    src,
    /vaultTransactionExecute\(\{[\s\S]*?member: alexBot\.publicKey/,
    "the bot executes"
  );
});

// WHY THIS IS NO LONGER `assert.match(/rentPayer: alexBot/)` (2026-09-13, Carl's
// review of PR 31). It was exactly that — and it passed while the rent fell on the
// HUMAN. `multisig.rpc.proposalCreate` accepts `rentPayer`, pushes it into the
// signer list, and hands the transaction builder no rentPayer at all (locked 2.1.4,
// lib/index.js:8209-8217), so the instruction resolved `rent_payer = creator`. A
// regex over the source could not see that; it only proved the string was present.
// So the SHAPE is graded here — the script must BUILD the instruction — and the
// SDK's real behaviour is graded in squad-upgrade-rent-payer.test.js.
test("the proposal instruction is built, never taken from the rpc helper that drops rentPayer", () => {
  const src = script();

  assert.match(
    src,
    /multisig\.instructions\.proposalCreate\(\{[\s\S]*?rentPayer: alexBot\.publicKey/,
    "the script must build the proposal instruction with the bot as rent payer"
  );
  assert.ok(
    !/multisig\.rpc\.proposalCreate\(/.test(src),
    "multisig.rpc.proposalCreate accepts rentPayer and discards it — the human creator then pays the rent"
  );
});

test("the human keys come from env vars, never argv", () => {
  const src = script();

  assert.match(src, /loadKey\("ALEX_KEY"\)/);
  assert.match(src, /loadKey\("MASON_KEY"\)/);
  assert.ok(
    !/process\.argv\[[34]\]/.test(src),
    "no key may be read from argv — argv leaks in ps"
  );
});
