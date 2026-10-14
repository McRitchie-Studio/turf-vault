/**
 * Regression suite for scripts/lib/admin-seat-rotation.js — the arguments, the
 * plan, the read-back check and the execute gate behind
 * scripts/ceremony/rotate-admin-seat.js.
 *
 * Pure node stdlib, so it runs in CI's guards lane.   npm run test:scripts
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const R = require("../lib/admin-seat-rotation");
const {
  STALE_NOTICE,
  base58Decode,
  checkReadBack,
  executeProblems,
  formatPlan,
  outgoingSignerProblems,
  parseRotationArgs,
  planRotation,
  plannedActions,
  proposalProblems,
} = R;

const SYSTEM = "7auwTLSvNniSUeAgL6v9RStMXJhWrrUhSJgwFWLpcqC";
const ALEX = "7ZDJp7FUHhuceAqcW9CHe81hCiaMTjgWAXfprBM59Tcr";
const ALEX_TWO = "3Qj4v9qjhXgkru6zCRCErRVhy8Q6qU3NrNpvpXLTZboA";
const ALEX_THREE = "9gACbzsCLmkYF9Yx1EBGmwMvvyfuTquJ6qs8QsoQvHXf";
const OPERATORS = [ALEX, ALEX_TWO, ALEX_THREE];
const GOV = "4bKNSqkrKeggSyrds16Ak7rcB4ibvGJ4ZLsKjvQgC3Vk"; // exposed 2026-10-12
const GOV_V2 = "3LTLPG1s952sdNatZWtnfM7r9F3ivWSnPSqfhQLBepJ9"; // solana.turf.governance.v2
const BLSB = "BLSBw8fXHzZc5pbaYCKMpMSsrtXBTbWXpUPVzMrXx9oo";
const PAIR = { old: GOV, new: GOV_V2 };
const m = (key, mask = 7) => ({ key, mask });

// Mainnet 4H3fP3ot…, read 2026-10-14: 3 of 5, every member mask 7.
const MAINNET_NOW = { threshold: 3, members: [m(SYSTEM), m(ALEX_TWO), m(GOV), m(ALEX), m(ALEX_THREE)] };

const args = (s) => s.split(/\s+/).filter(Boolean);
const BASE = `--cluster=mainnet --old=${GOV} --new=${GOV_V2}`;

// --------------------------------------------------------------------------- arguments

test("--old and --new are both REQUIRED; there is no default pair", () => {
  const none = parseRotationArgs(args("--cluster=mainnet"));
  assert.ok(none.problems.includes("--old <pubkey> is REQUIRED"));
  assert.ok(none.problems.includes("--new <pubkey> is REQUIRED"));
  assert.equal(none.old, undefined);
  assert.equal(none.new, undefined);
  assert.ok(!("OLD_SEAT" in R) && !("NEW_SEAT" in R), "no hard-coded pair is exported for a caller to fall back on");

  const onlyNew = parseRotationArgs(args(`--cluster=mainnet --new=${GOV_V2}`));
  assert.deepEqual(onlyNew.problems, ["--old <pubkey> is REQUIRED"]);
  const bareFlag = parseRotationArgs(args(`--cluster=mainnet --old --new=${GOV_V2}`));
  assert.deepEqual(bareFlag.problems, ["--old <pubkey> is REQUIRED"]);
});

test("both --flag=value and --flag value spellings parse", () => {
  const eq = parseRotationArgs(args(BASE));
  const sp = parseRotationArgs(args(`--cluster mainnet --old ${GOV} --new ${GOV_V2}`));
  for (const a of [eq, sp]) {
    assert.deepEqual(a.problems, []);
    assert.equal(a.cluster, "mainnet");
    assert.equal(a.old, GOV);
    assert.equal(a.new, GOV_V2);
    assert.equal(a.mode, "create");
    assert.equal(a.send, false, "dry run unless --send");
  }
});

test("a key must be base58 that decodes to exactly 32 bytes", () => {
  const bad = (k) => parseRotationArgs(args(`--cluster=mainnet --old=${GOV} --new=${k}`)).problems;
  assert.ok(bad("0OIl" + GOV_V2.slice(4)).some((p) => /not base58/.test(p)), "0, O, I and l are outside the alphabet");
  assert.ok(bad(GOV_V2.slice(0, 20)).some((p) => /decodes to \d+ bytes, not 32/.test(p)), "too short");
  assert.ok(bad(GOV_V2 + "zz").some((p) => /not 32/.test(p)), "too long");
  assert.equal(base58Decode(GOV_V2).length, 32);
  assert.equal(base58Decode("11111111111111111111111111111111").length, 32, "leading 1s are zero bytes");
  assert.deepEqual(Array.from(base58Decode("11111111111111111111111111111111")), new Array(32).fill(0));
});

test("old and new must differ", () => {
  const same = parseRotationArgs(args(`--cluster=mainnet --old=${GOV_V2} --new=${GOV_V2}`));
  assert.ok(same.problems.some((p) => /same key/.test(p)));
});

test("an exposed or forbidden key is never ADDED", () => {
  for (const k of [GOV, BLSB, "8K81w4e6UcB7TiANhM9N8sAgijJvTxxybRi8AENRaRYd"]) {
    const a = parseRotationArgs(args(`--cluster=mainnet --old=${SYSTEM} --new=${k}`));
    assert.ok(a.problems.some((p) => /exposed or forbidden/.test(p)), k);
  }
  // Removing one is exactly what the tool is for.
  assert.deepEqual(parseRotationArgs(args(BASE)).problems, []);
});

test("mode flags: approve and execute need --index; create refuses one", () => {
  assert.equal(parseRotationArgs(args(`${BASE} --approve --index=10 --as=governance`)).mode, "approve");
  assert.equal(parseRotationArgs(args(`${BASE} --execute --index 10`)).mode, "execute");
  assert.ok(parseRotationArgs(args(`${BASE} --approve --as=governance`)).problems.some((p) => /needs --index/.test(p)));
  assert.ok(parseRotationArgs(args(`${BASE} --execute`)).problems.some((p) => /needs --index/.test(p)));
  assert.ok(parseRotationArgs(args(`${BASE} --index=10`)).problems.some((p) => /create takes no --index/.test(p)));
  assert.ok(parseRotationArgs(args(`${BASE} --approve --execute --index=10`)).problems.some((p) => /separate steps/.test(p)));
  assert.ok(parseRotationArgs(args(`${BASE} --approve --index=10`)).problems.some((p) => /needs --as/.test(p)));
  assert.ok(parseRotationArgs(args(`${BASE} --bogus`)).problems.some((p) => /unknown argument/.test(p)));
  assert.ok(parseRotationArgs(args(`${BASE} --old=${SYSTEM}`)).problems.some((p) => /given twice/.test(p)));
});

test("--allow-outgoing-signer covers an approval only", () => {
  assert.ok(
    parseRotationArgs(args(`${BASE} --execute --index=10 --allow-outgoing-signer`)).problems.some((p) => /APPROVAL only/.test(p))
  );
  assert.ok(
    parseRotationArgs(args(`${BASE} --send --allow-outgoing-signer`)).problems.some((p) => /--and-approve-as/.test(p)),
    "on create it only pairs with the co-approval"
  );
  assert.deepEqual(parseRotationArgs(args(`${BASE} --send --and-approve-as=governance --allow-outgoing-signer`)).problems, []);
  assert.deepEqual(parseRotationArgs(args(`${BASE} --approve --index=10 --as=governance --allow-outgoing-signer`)).problems, []);
  assert.ok(parseRotationArgs(args(`${BASE} --execute --index=10 --and-approve-as=governance`)).problems.length > 0);
});

// --------------------------------------------------------------------------- plan

test("today's mainnet plans cleanly: 4bKN out, 3LTL in, same count, same threshold", () => {
  const plan = planRotation(MAINNET_NOW, PAIR);
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.threshold, 3);
  assert.equal(plan.mask, 7);
  assert.equal(plan.after.length, plan.before.length);
  assert.ok(plan.after.includes(GOV_V2));
  assert.ok(!plan.after.includes(GOV));
});

test("the new member inherits the OLD member's live mask, whatever it is", () => {
  const voteOnly = { threshold: 2, members: [m(SYSTEM), m(ALEX), m(GOV, 2)] };
  const plan = planRotation(voteOnly, PAIR);
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.mask, 2);
  assert.deepEqual(plannedActions({ ...PAIR, mask: plan.mask }), [
    { kind: "RemoveMember", key: GOV },
    { kind: "AddMember", key: GOV_V2, mask: 2 },
  ]);
  assert.ok(!plannedActions({ ...PAIR, mask: 7 }).some((a) => a.kind === "ChangeThreshold"), "the threshold is unchanged");
  assert.ok(planRotation({ threshold: 2, members: [m(SYSTEM), m(ALEX), m(GOV, 9)] }, PAIR).problems.some((p) => /mask 9/.test(p)));
});

test("old must be a live member and new must not be", () => {
  const done = { threshold: 3, members: [m(SYSTEM), m(ALEX_TWO), m(GOV_V2), m(ALEX), m(ALEX_THREE)] };
  const { problems } = planRotation(done, PAIR);
  assert.ok(problems.some((p) => /NOT a member/.test(p)), "a re-run after the rotation refuses");
  assert.ok(problems.some((p) => /ALREADY a member/.test(p)));
  assert.ok(planRotation(MAINNET_NOW, {}).problems.some((p) => /needs both/.test(p)));
});

test("a threshold the swap cannot keep refuses", () => {
  assert.ok(planRotation({ threshold: 0, members: MAINNET_NOW.members }, PAIR).problems.some((p) => /not usable/.test(p)));
});

test("plan output: the swap, the inherited mask, the predicted set and the stale warning", () => {
  const plan = planRotation(MAINNET_NOW, PAIR);
  const text = formatPlan({ index: 10n, creator: { role: "system" }, plan, pair: PAIR, open: [] }).join("\n");
  assert.match(text, /ONE atomic config transaction at #10, creator system/);
  assert.match(text, new RegExp(`- removeMember ${GOV}`));
  assert.match(text, new RegExp(`\\+ addMember    ${GOV_V2}  mask 7`));
  assert.match(text, /outgoing member's mask 7; threshold stays 3/);
  assert.match(text, /AFTER \(predicted\): threshold 3 of 5/);
  assert.ok(text.includes(STALE_NOTICE), "the 6007 warning prints even when nothing is open");
  assert.match(STALE_NOTICE, /6007/);
  assert.match(text, /OPEN NOW — none/);
  // The predicted set lists the incoming key and not the outgoing one.
  const after = text.split("AFTER")[1].split("STALE")[0];
  assert.ok(after.includes(GOV_V2) && !after.includes(GOV));
});

test("plan output names every open proposal the rotation would stale", () => {
  const plan = planRotation(MAINNET_NOW, PAIR);
  const open = [{ index: 8n, status: "Active" }, { index: 9n, status: "Approved" }];
  const text = formatPlan({ index: 10n, creator: { role: "system" }, plan, pair: PAIR, open }).join("\n");
  assert.match(text, /OPEN NOW — 2 proposal\(s\) this rotation would stale/);
  assert.match(text, /#8  Active/);
  assert.match(text, /#9  Approved/);
  assert.match(text, /--send refuses while any is open/);
});

// --------------------------------------------------------------------------- read-back

test("read-back: an exact match passes; every drift refuses", () => {
  const plan = { ...PAIR, mask: 7 };
  assert.deepEqual(checkReadBack(plannedActions(plan), plan), []);

  const extra = [...plannedActions(plan), { kind: "ChangeThreshold", threshold: 1 }];
  assert.ok(checkReadBack(extra, plan).some((p) => /extra action/.test(p)));

  const wrongKey = [{ kind: "RemoveMember", key: GOV }, { kind: "AddMember", key: SYSTEM, mask: 7 }];
  assert.ok(checkReadBack(wrongKey, plan).some((p) => /names/.test(p)));

  const wrongMask = [{ kind: "RemoveMember", key: GOV }, { kind: "AddMember", key: GOV_V2, mask: 1 }];
  assert.ok(checkReadBack(wrongMask, plan).some((p) => /mask 1/.test(p)));

  const removesAlex = [{ kind: "RemoveMember", key: ALEX }, { kind: "AddMember", key: GOV_V2, mask: 7 }];
  assert.ok(checkReadBack(removesAlex, plan).length > 0);

  const swapped = [{ kind: "AddMember", key: GOV_V2, mask: 7 }, { kind: "RemoveMember", key: GOV }];
  assert.ok(checkReadBack(swapped, plan).some((p) => /action 1 is AddMember/.test(p)), "order matters");

  assert.ok(checkReadBack([plannedActions(plan)[1]], plan).length > 0, "an add without its remove refuses");
  assert.ok(checkReadBack([], plan).length > 0);
  // The 2026-10-09 transaction is not today's plan.
  assert.ok(checkReadBack(plannedActions({ old: BLSB, new: GOV, mask: 7 }), plan).length > 0);
});

// --------------------------------------------------------------------------- proposal and execute gates

test("a stale or wrong-status proposal refuses; the devnet #17 shape is stale", () => {
  assert.ok(proposalProblems({ index: 17, staleTransactionIndex: 18, status: "Active" }).some((p) => /stale/.test(p)));
  assert.deepEqual(proposalProblems({ index: 19, staleTransactionIndex: 18, status: "Active", want: "Active" }), []);
  assert.ok(proposalProblems({ index: 6, staleTransactionIndex: 4, status: "Active", want: "Approved" }).length === 1);
});

test("execute refuses until the threshold is met on chain", () => {
  const gate = (status, approved, cluster = "mainnet-beta") =>
    executeProblems({ cluster, status, approved, threshold: 3, operatorKeys: OPERATORS });
  // The agents' two votes: Active, 2 of 3.
  const twoAgents = gate("Active", [SYSTEM, GOV]);
  assert.ok(twoAgents.some((p) => /not Approved/.test(p)));
  assert.ok(twoAgents.some((p) => /2 approval\(s\) on chain, the threshold is 3/.test(p)));
  // Mr. McRitchie's click lands: Approved, 3 of 3, his seat among them.
  assert.deepEqual(gate("Approved", [SYSTEM, GOV, ALEX]), []);
  assert.ok(gate("Executed", [SYSTEM, GOV, ALEX]).some((p) => /already Executed/.test(p)));
});

test("on mainnet, agent votes alone never execute, even at threshold", () => {
  const agentsOnly = executeProblems({
    cluster: "mainnet-beta",
    status: "Approved",
    approved: [SYSTEM, GOV, "GF4sojG9tHF2kC3jpgto1gd3b1nXLuUiAcsAiYi5Y5vb"],
    threshold: 3,
    operatorKeys: OPERATORS,
  });
  assert.ok(agentsOnly.some((p) => /Mr. McRitchie's seats/.test(p)));
  // Devnet has no operator UI, so its agent seats may finish.
  assert.deepEqual(
    executeProblems({ cluster: "devnet", status: "Approved", approved: [SYSTEM, GOV, BLSB], threshold: 3, operatorKeys: OPERATORS }),
    []
  );
});

test("the outgoing key approves its own removal only under the flag, and never creates or executes", () => {
  const o = (seatPubkey, step, allowOutgoing = false) => outgoingSignerProblems({ seatPubkey, old: GOV, allowOutgoing, step });
  assert.ok(o(GOV, "approve").some((p) => /needs --allow-outgoing-signer/.test(p)));
  assert.deepEqual(o(GOV, "approve", true), []);
  assert.ok(o(GOV, "create", true).some((p) => /never creates/.test(p)));
  assert.ok(o(GOV, "execute", true).some((p) => /never executes/.test(p)));
  assert.deepEqual(o(SYSTEM, "create"), []);
  assert.deepEqual(o(SYSTEM, "approve"), []);
  assert.ok(o(SYSTEM, "approve", true).some((p) => /is not/.test(p)), "the flag cannot ride on another seat's vote");
});

test("the 2026-10-09 pair survives only as a named record for the sweeps", () => {
  assert.deepEqual({ ...R.ROTATION_2026_10_09 }, { old: BLSB, new: GOV });
  assert.ok(Object.isFrozen(R.ROTATION_2026_10_09));
});
