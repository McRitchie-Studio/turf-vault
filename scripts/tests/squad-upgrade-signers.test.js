/**
 * WHO SIGNS EACH STEP, read off the script itself.
 *
 * The defect was one argument on one line, and only the line can answer for it,
 * so this grades the SCRIPT text: which member each call names, and that the
 * signer plan is consulted BEFORE the first spend. The planner's own behaviour is
 * graded in squad-roles.test.js; the executed order in squad-upgrade-flow.test.js.
 *
 * WHAT THE SCRIPT DOES, and deliberately still does (2026-09-14): the bot
 * initiates the vault transaction, opens the proposal, casts the FIRST approval,
 * pays every fee and executes; Mason casts the second. Moving both approvals to
 * humans was proposed under /tasks/narrow-bot-squads-permissions and DECLINED by
 * Mr. McRitchie — without the mask narrowing it is not a security boundary (an
 * attacker holding the bot key would use the SDK, not this script) and it would
 * put both humans at every upgrade.
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

test("the two approvals are the bot and Mason, and the plan names them", () => {
  const src = script();
  const approvals = src.match(/proposalApprove\(\{[\s\S]*?\}\)/g) || [];

  assert.equal(approvals.length, 2, "two approvals, one per approver");
  assert.ok(
    /member: alexBot\b/.test(approvals.join("\n")),
    "the bot casts one approval — it holds Vote, by decision"
  );
  assert.ok(
    /member: mason\b/.test(approvals.join("\n")),
    "Mason casts the other"
  );
  assert.match(
    src,
    /approvers: \[alexBot\.publicKey\.toBase58\(\), mason\.publicKey\.toBase58\(\)\]/,
    "the planner must be handed the SAME two approvers the script then uses, or it grades a plan nobody runs"
  );
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

test("the bot still initiates, opens the proposal, and executes", () => {
  const src = script();

  assert.match(
    src,
    /vaultTransactionCreate\(\{[\s\S]*?creator: alexBot\.publicKey/,
    "the bot initiates the vault tx"
  );
  assert.match(
    src,
    /proposalCreate\(\{[\s\S]*?creator: alexBot/,
    "the bot opens the proposal"
  );
  assert.match(
    src,
    /vaultTransactionExecute\(\{[\s\S]*?member: alexBot\.publicKey/,
    "the bot executes"
  );
});

test("the signing keys come from env vars, never argv", () => {
  const src = script();

  assert.match(src, /loadKey\("ALEX_BOT_KEY"\)/);
  assert.match(src, /loadKey\("MASON_KEY"\)/);
  assert.ok(
    !/process\.argv\[[34]\]/.test(src),
    "no key may be read from argv — argv leaks in ps"
  );
});
