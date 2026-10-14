/**
 * Regression suite for scripts/lib/squad-clusters.js — WHICH CHAIN, WHICH
 * ADDRESSES, WHICH KEYS, and the two vocabularies inside scripts/squad.json
 * that have been conflated once already.
 *
 * WHAT IT PROTECTS.
 *
 *   1. THE CLUSTER IS REQUIRED. `squad-upgrade.js` upgrades a program that
 *      custodies real assets. A default cluster is how a ceremony step hits the
 *      wrong chain, so there is none, and a missing or unknown `--cluster` is a
 *      refusal rather than an inference.
 *
 *   2. THE MAINNET ADDRESSES ARE NOT COPIED. They come out of squad.json's flat
 *      top level — the ONE copy, which scripts/lib/mainnet-config.js resolves
 *      for `initialize-mainnet.js` too. Two copies of those four addresses in
 *      one repo is how an upgrade and an initialize end up pointed at different
 *      programs.
 *
 *   3. `members` IS NOT THE SQUADS MEMBERSHIP. squad.json's top-level
 *      `members`/`threshold` are the PROGRAM's own `VaultState` signer set,
 *      written by `initialize` and checked by `validate_multisig`. The Squads
 *      rotation on 2026-09-15 changed Squads membership on both clusters and
 *      VaultState on neither — and the previous version of this suite asserted
 *      those fields under the belief that they described the Squads multisig,
 *      so it would have fired on the wrong event and sent the reader to the
 *      wrong ceremony. Squads membership is read from the CHAIN, every run.
 *
 * Pure node stdlib and the committed squad.json (public addresses only), so it
 * runs in CI's guards lane, which installs no dependency tree.
 *
 *   npm run test:scripts
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  ADMIN_VAULT,
  AGENT_SEATS,
  AGENT_VAULT,
  ClusterError,
  GENESIS,
  MAINNET_FORBIDDEN_SIGNERS,
  MEMBER_NAMES,
  OPERATOR_KEYS,
  SQUAD_JSON,
  addressesFor,
  canonicalCluster,
  memberName,
  resolveCluster,
  seatSecretSource,
  seatsForMembers,
  squadsTransactionsUrl,
} = require("../lib/squad-clusters");

const cfg = () => JSON.parse(fs.readFileSync(SQUAD_JSON, "utf8"));

// --- the cluster is an argument, never an inference -------------------------

test("a missing cluster is REFUSED, and the refusal says why there is no default", () => {
  assert.throws(
    () => resolveCluster(undefined),
    (error) => {
      assert.ok(error instanceof ClusterError);
      assert.match(error.message, /REQUIRED/);
      assert.match(error.message, /wrong chain/);
      return true;
    }
  );
  assert.throws(() => resolveCluster("mainnet-beta-2"), ClusterError);
  assert.throws(() => resolveCluster("localnet"), ClusterError);
});

test("`mainnet` and `mainnet-beta` name the same chain; nothing else does", () => {
  assert.equal(canonicalCluster("mainnet"), "mainnet-beta");
  assert.equal(canonicalCluster("mainnet-beta"), "mainnet-beta");
  assert.equal(canonicalCluster("devnet"), "devnet");
  assert.equal(canonicalCluster("Devnet"), null, "case is not guessed at");
  assert.equal(canonicalCluster(""), null);
});

test("each cluster carries the genesis hash that proves which chain answered", () => {
  // An RPC URL is a claim. `SOLANA_RPC_URL` pointed at the wrong cluster reads
  // perfectly in a log; the genesis hash does not.
  assert.equal(GENESIS["mainnet-beta"], "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d");
  assert.equal(GENESIS.devnet, "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
  for (const cluster of ["mainnet-beta", "devnet"]) {
    assert.equal(resolveCluster(cluster).genesisHash, GENESIS[cluster]);
  }
});

// --- the addresses, and the one copy of them --------------------------------

test("mainnet's addresses are READ from squad.json's flat top level", () => {
  const file = cfg();
  const resolved = resolveCluster("mainnet");

  assert.equal(resolved.programId, file.programId);
  assert.equal(resolved.multisigPda, file.multisigPda);
  assert.equal(resolved.vaultPda, file.vaultPda);
});

test("devnet's addresses are its own block, and differ from mainnet's", () => {
  const devnet = resolveCluster("devnet");
  const mainnet = resolveCluster("mainnet");

  assert.equal(devnet.programId, cfg().devnet.programId);
  for (const field of ["programId", "multisigPda", "vaultPda"]) {
    assert.notEqual(
      devnet[field],
      mainnet[field],
      `${field} must differ between clusters — the devnet vault address is the one that ` +
        `has historically leaked into mainnet-facing prose`
    );
  }
});

test("a flat top level that does not declare mainnet-beta is REFUSED", () => {
  // The devnet branches carry a flat config with `"network": "devnet"`. Treating
  // one as the mainnet upgrade target would propose against the wrong program.
  assert.throws(
    () => addressesFor({ ...cfg(), network: "devnet" }, "mainnet-beta"),
    /not "mainnet-beta"/
  );
});

test("a missing or incomplete block is REFUSED, never half-resolved", () => {
  assert.throws(() => addressesFor({ network: "mainnet-beta" }, "mainnet-beta"), ClusterError);
  assert.throws(() => addressesFor({}, "devnet"), /devnet block is missing/);
  assert.throws(
    () => addressesFor({ devnet: { programId: "x", multisigPda: "y" } }, "devnet"),
    /missing vaultPda/
  );
});

// --- the two vocabularies ---------------------------------------------------

test("squad.json's `members`/`threshold` are VaultState signers, NOT Squads members", () => {
  // These are what `initialize-mainnet.js` writes on chain and what the deployed
  // program's `validate_multisig` checks. The 2026-09-15 Squads rotation removed
  // 8K81 and CytJ from BOTH Squads multisigs and touched VaultState on NEITHER,
  // so these three are still correct and must not be "fixed" to match the Squads
  // seats. `node scripts/check-signer-slots.js` reads them back off the chain.
  const file = cfg();

  assert.equal(file.threshold, 2);
  assert.deepEqual(Object.keys(file.members).sort(), ["alex", "alex_bot", "mason"]);
  assert.equal(file.members.alex_bot, "8K81w4e6UcB7TiANhM9N8sAgijJvTxxybRi8AENRaRYd");
  assert.equal(file.members.alex, "7ZDJp7FUHhuceAqcW9CHe81hCiaMTjgWAXfprBM59Tcr");
  assert.equal(file.members.mason, "CytJS23p1zCM2wvUUngiDePtbMB484ebD7bK4nDqWjrR");

  assert.match(
    file._members_are,
    /VaultState/,
    "the file must SAY which multisig `members` describes — the conflation cost a ceremony"
  );
});

test("no Squads membership is resolved from the file — only from the chain", () => {
  // The seat roster is a list of keys to OFFER the chain. Nothing here claims
  // any of them is seated; `planUpgrade` intersects the two.
  const resolved = resolveCluster("mainnet");

  assert.ok(Array.isArray(resolved.agentSeats));
  assert.equal(
    resolved.threshold,
    undefined,
    "a resolved cluster must carry no threshold — the chain owns that number"
  );
  assert.equal(resolved.members, undefined);
});

// --- the seat roster --------------------------------------------------------

test("the roster's public keys are the LIVE agent seats on each cluster", () => {
  // Read off chain 2026-09-15, after the day's second rotation, and amended by
  // the 2026-10-08 governance rotation (BLSBw8 out, 4bKN in, one config
  // transaction per cluster). Both multisigs are threshold 3 of 5; mainnet's
  // agent seats reach 2 and devnet's reach 3, which is the asymmetry the two
  // behaviours are built on.
  assert.deepEqual(
    AGENT_SEATS["mainnet-beta"].map((s) => s.pubkey),
    [
      "7auwTLSvNniSUeAgL6v9RStMXJhWrrUhSJgwFWLpcqC", // system
      "4bKNSqkrKeggSyrds16Ak7rcB4ibvGJ4ZLsKjvQgC3Vk", // governance, before the 2026-10-14 swap
      "3LTLPG1s952sdNatZWtnfM7r9F3ivWSnPSqfhQLBepJ9", // governance.v2, after it (seatsForMembers picks)
    ]
  );
  assert.deepEqual(
    AGENT_SEATS.devnet.map((s) => s.pubkey),
    [
      "2eGs8G3wzhEeNQQU2Q86BmmA2xTpDbMMae3Y1bvpZfx9", // system.devnet
      "GF4sojG9tHF2kC3jpgto1gd3b1nXLuUiAcsAiYi5Y5vb", // seat-a.devnet — replaced 8K81 at #21
      "39qaSh2J4VoQhn3sZCwWmb1W17VCrDMri2JoBAN6dT1o", // seat-b.devnet — replaced 4bKN at #21
    ]
  );
});

test("the devnet roster offers no exposed or mainnet-capable key", () => {
  // devnet-exposed-keys-tidy, 2026-10-12: 4bKN (a mainnet Squad seat) and 8K81
  // (production's SOLANA_ADMIN_KEY) were printed into a transcript and left the
  // devnet Squad at config transaction #21. A devnet roster that offered either
  // again would hand a mainnet-capable key to an unattended devnet run.
  const EXPOSED = [
    "4bKNSqkrKeggSyrds16Ak7rcB4ibvGJ4ZLsKjvQgC3Vk",
    "8K81w4e6UcB7TiANhM9N8sAgijJvTxxybRi8AENRaRYd",
  ];
  const mainnetCapable = [
    ...AGENT_SEATS["mainnet-beta"].map((s) => s.pubkey),
    ...OPERATOR_KEYS,
    ...Object.keys(MAINNET_FORBIDDEN_SIGNERS),
  ];
  for (const seat of AGENT_SEATS.devnet) {
    assert.ok(!EXPOSED.includes(seat.pubkey), `devnet still offers exposed ${seat.pubkey}`);
    if (seat.role === "system.devnet") continue; // QA's server key; devnet-only by construction
    assert.ok(!mainnetCapable.includes(seat.pubkey), `devnet/${seat.role} is a mainnet-capable key`);
    assert.match(seat.item, /\.devnet$/, `devnet/${seat.role} must read a devnet-only item`);
  }
  assert.equal(AGENT_SEATS.devnet.length, 3, "three agent seats keep devnet AUTONOMOUS at threshold 3");
});

test("the mainnet Squad's five seats, as read off chain 2026-10-12", () => {
  // Read 2026-10-12 from multisig 4H3fP3ot…: threshold 3, five members, every
  // mask 7 (Initiate|Vote|Execute). The two agent seats plus Mr. McRitchie's
  // three are EXACTLY those five. This file never claims membership (the chain
  // decides on every run), but a rotation that changes the set has to change
  // this test on purpose — that is how BLSBw8 lingered in prose after #6.
  const LIVE_MAINNET_SEATS = [
    "7auwTLSvNniSUeAgL6v9RStMXJhWrrUhSJgwFWLpcqC", // system (agent)
    "3Qj4v9qjhXgkru6zCRCErRVhy8Q6qU3NrNpvpXLTZboA", // operator
    "4bKNSqkrKeggSyrds16Ak7rcB4ibvGJ4ZLsKjvQgC3Vk", // governance (agent)
    "7ZDJp7FUHhuceAqcW9CHe81hCiaMTjgWAXfprBM59Tcr", // operator (Phantom)
    "9gACbzsCLmkYF9Yx1EBGmwMvvyfuTquJ6qs8QsoQvHXf", // operator
  ];
  const resolved = seatsForMembers("mainnet-beta", LIVE_MAINNET_SEATS);
  const roster = [...resolved.map((s) => s.pubkey), ...OPERATOR_KEYS];
  assert.deepEqual([...roster].sort(), [...LIVE_MAINNET_SEATS].sort());
  assert.equal(new Set(roster).size, 5, "no key is both an agent seat and an operator seat");
  assert.ok(!roster.includes("BLSBw8fXHzZc5pbaYCKMpMSsrtXBTbWXpUPVzMrXx9oo"), "BLSBw8 left the Squad at #6");
});

// --- the governance cut-over (2026-10-14, squad-seat-rotation-any-pair) ------

const GOV = "4bKNSqkrKeggSyrds16Ak7rcB4ibvGJ4ZLsKjvQgC3Vk";
const GOV_V2 = "3LTLPG1s952sdNatZWtnfM7r9F3ivWSnPSqfhQLBepJ9";
const SYSTEM_KEY = "7auwTLSvNniSUeAgL6v9RStMXJhWrrUhSJgwFWLpcqC";

test("before the swap the governance seat is 4bKN's item; after it, 3LTL's", () => {
  const before = seatsForMembers("mainnet-beta", [SYSTEM_KEY, GOV, ...OPERATOR_KEYS]);
  const govBefore = before.filter((s) => s.role === "governance");
  assert.equal(govBefore.length, 1);
  assert.equal(govBefore[0].pubkey, GOV);
  assert.equal(govBefore[0].item, "solana.turf.governance");

  const after = seatsForMembers("mainnet-beta", [SYSTEM_KEY, GOV_V2, ...OPERATOR_KEYS]);
  const govAfter = after.filter((s) => s.role === "governance");
  assert.equal(govAfter.length, 1);
  assert.equal(govAfter[0].pubkey, GOV_V2);
  assert.equal(govAfter[0].item, "solana.turf.governance.v2");
  assert.equal(govAfter[0].vault, ADMIN_VAULT, "the v2 key lives in the admin vault");
  assert.equal(govAfter[0].secretField, "private key", "its field is filed with a SPACE");
  assert.ok(after.some((s) => s.role === "system"), "the other seats ride along unchanged");
});

test("neither or both governance candidates seated refuses", () => {
  assert.throws(
    () => seatsForMembers("mainnet-beta", [SYSTEM_KEY, ...OPERATOR_KEYS]),
    (e) => e instanceof ClusterError && /no governance candidate/.test(e.message)
  );
  assert.throws(
    () => seatsForMembers("mainnet-beta", [SYSTEM_KEY, GOV, GOV_V2, ...OPERATOR_KEYS]),
    (e) => e instanceof ClusterError && /BOTH governance candidates/.test(e.message)
  );
});

test("devnet has no governance candidate, so its roster passes through untouched", () => {
  const out = seatsForMembers("devnet", []);
  assert.deepEqual(out.map((s) => s.pubkey), AGENT_SEATS.devnet.map((s) => s.pubkey));
  out[0].pubkey = "tampered";
  assert.notEqual(AGENT_SEATS.devnet[0].pubkey, "tampered", "copies, never the table itself");
});

test("no forbidden mainnet signer is an agent seat or an operator seat", () => {
  // squad-vault-ops: no agent signs mainnet with Xan (8K81), Mason (CytJ) or Mack.
  assert.deepEqual(Object.keys(MAINNET_FORBIDDEN_SIGNERS).sort(), [
    "8K81w4e6UcB7TiANhM9N8sAgijJvTxxybRi8AENRaRYd",
    "CytJS23p1zCM2wvUUngiDePtbMB484ebD7bK4nDqWjrR",
    "foUuRyeibadQoGdKXZ9pBGDqmkb1jY1jYsu8dZ29nds",
  ]);
  for (const key of Object.keys(MAINNET_FORBIDDEN_SIGNERS)) {
    assert.ok(!AGENT_SEATS["mainnet-beta"].some((s) => s.pubkey === key), `${key} is a mainnet agent seat`);
    assert.ok(!OPERATOR_KEYS.includes(key), `${key} is listed as an operator seat`);
  }
});

test("the operator keys are the three wallets named for Mr. McRitchie", () => {
  for (const key of OPERATOR_KEYS) assert.match(memberName(key), /\(operator\)$/);
  const named = Object.keys(MEMBER_NAMES).filter((k) => /\(operator\)$/.test(MEMBER_NAMES[k]));
  assert.deepEqual([...named].sort(), [...OPERATOR_KEYS].sort());
});

test("the Squads link keys on the VAULT PDA, never the multisig", () => {
  // The multisig address 404s on app.squads.so (turf-monster
  // Solana::Config.squads_app_url records the 2026-09-29 measurement).
  const mainnet = resolveCluster("mainnet");
  assert.equal(
    squadsTransactionsUrl(mainnet.vaultPda),
    "https://app.squads.so/squads/Bk9sS7iiSRL18vuo2KVzkeGw7EekKqxMCjrdoyGGdJm/transactions"
  );
  assert.ok(!squadsTransactionsUrl(mainnet.vaultPda).includes(mainnet.multisigPda));
  assert.throws(() => squadsTransactionsUrl(undefined), ClusterError);
});

test("the exposed admin key is offered on NO cluster", () => {
  // BLSBw8 (solana.turf.admin) sat in local env files on many desks. A roster
  // that still offered it would have a rotated-out key sign the next upgrade.
  const EXPOSED = "BLSBw8fXHzZc5pbaYCKMpMSsrtXBTbWXpUPVzMrXx9oo";
  for (const [cluster, seats] of Object.entries(AGENT_SEATS)) {
    assert.ok(!seats.some((s) => s.pubkey === EXPOSED), `${cluster} still offers BLSBw8`);
    assert.ok(!seats.some((s) => s.item === "solana.turf.admin"), `${cluster} still reads solana.turf.admin`);
  }
});

test("every seat names its vault; governance and the devnet seats are the admin vault, system seats are not", () => {
  // governance (4bKN) holds a mainnet Squads seat; the two devnet seats hold
  // two of devnet's three agent votes, enough with system.devnet to upgrade the
  // devnet program alone. None may be readable by a desk-level token.
  const ADMIN_ROLES = ["governance", "seat-a.devnet", "seat-b.devnet"];
  for (const [cluster, seats] of Object.entries(AGENT_SEATS)) {
    for (const seat of seats) {
      const want = ADMIN_ROLES.includes(seat.role) ? ADMIN_VAULT : AGENT_VAULT;
      assert.equal(seat.vault, want, `${cluster}/${seat.role} vault`);
    }
  }
});

test("an agent-vault seat reads exactly as before: MCR_OP_VAULT_AGENT, caller's token", () => {
  const seat = AGENT_SEATS["mainnet-beta"].find((s) => s.role === "system");
  const env = { OP_SERVICE_ACCOUNT_TOKEN: "agent-token" };
  const plain = seatSecretSource(seat, env);
  assert.equal(plain.ref, "op://studio-agents/solana.turf.system/private-key");
  assert.equal(plain.childEnv, env, "an agent seat inherits the caller's environment untouched");

  const renamed = seatSecretSource(seat, { ...env, MCR_OP_VAULT_AGENT: "other-agents" });
  assert.equal(renamed.ref, "op://other-agents/solana.turf.system/private-key");

});

test("a devnet seat reads from the admin vault with the admin token", () => {
  const seatA = AGENT_SEATS.devnet.find((s) => s.role === "seat-a.devnet");
  const spec = seatSecretSource(seatA, { OP_SERVICE_ACCOUNT_TOKEN: "agent-token", OP_ADMIN_SERVICE_ACCOUNT_TOKEN: "admin-token" });
  assert.equal(spec.ref, "op://studio-agents-admin/solana.turf.squad-seat-a.devnet/private key");
  assert.equal(spec.childEnv.OP_SERVICE_ACCOUNT_TOKEN, "admin-token");
  assert.throws(() => seatSecretSource(seatA, { OP_SERVICE_ACCOUNT_TOKEN: "agent-token" }), ClusterError);
});

test("an admin-vault seat swaps in the admin token, and refuses without it", () => {
  const seat = AGENT_SEATS["mainnet-beta"].find((s) => s.role === "governance");
  const env = { OP_SERVICE_ACCOUNT_TOKEN: "agent-token", OP_ADMIN_SERVICE_ACCOUNT_TOKEN: "admin-token", MCR_OP_VAULT_AGENT: "x" };
  const spec = seatSecretSource(seat, env);
  assert.equal(spec.ref, "op://studio-agents-admin/solana.turf.governance/private key");
  assert.equal(spec.childEnv.OP_SERVICE_ACCOUNT_TOKEN, "admin-token");
  assert.equal(env.OP_SERVICE_ACCOUNT_TOKEN, "agent-token", "the caller's env is not mutated");

  assert.throws(
    () => seatSecretSource(seat, { OP_SERVICE_ACCOUNT_TOKEN: "agent-token" }),
    (e) => e instanceof ClusterError && /zprofile\.admin/.test(e.message)
  );
  assert.throws(() => seatSecretSource({ ...seat, vault: "agents" }, env), ClusterError);
});

test("no retired key is offered on the cluster that removed it", () => {
  // The whole defect: `ALEX_BOT_KEY` was Xan and `MASON_KEY` was Mason, and both
  // were removed from both multisigs at 09:41 on 2026-09-15. Mason is gone from
  // everywhere. Xan survived on devnet alone until devnet config transaction
  // #21 (2026-10-12, devnet-exposed-keys-tidy) removed him there too.
  const MASON = "CytJS23p1zCM2wvUUngiDePtbMB484ebD7bK4nDqWjrR";
  const XAN = "8K81w4e6UcB7TiANhM9N8sAgijJvTxxybRi8AENRaRYd";

  for (const cluster of Object.keys(AGENT_SEATS)) {
    assert.ok(
      !AGENT_SEATS[cluster].some((s) => s.pubkey === MASON),
      `${cluster} must not offer Mason — removed from both multisigs`
    );
  }
  for (const cluster of Object.keys(AGENT_SEATS)) {
    assert.ok(!AGENT_SEATS[cluster].some((s) => s.pubkey === XAN), `${cluster} must not offer Xan`);
  }
});

test("every seat names a 1Password item, its FIELD, and an env override", () => {
  // The field label differs between items and that is not a typo to tidy:
  // `solana.turf.*` spell it `private-key`; `agent.xan.solana` spells it
  // `private key`, with a space. Reading the wrong label fails naming the item
  // but not the field.
  for (const [cluster, seats] of Object.entries(AGENT_SEATS)) {
    for (const seat of seats) {
      assert.ok(seat.role, `${cluster} seat needs a role`);
      // Lowercase, dot-separated; a hyphen inside a part is legal, as in the
      // filed items `solana.turf.settle-cosigner.devnet` and
      // `solana.turf.squad-seat-a.devnet`.
      assert.match(seat.item, /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/, `${cluster}/${seat.role} item`);
      assert.match(seat.secretField, /^private[- ]key$/, `${cluster}/${seat.role} field`);
      assert.match(seat.env, /^SQUAD_KEY_[A-Z]+(?:_V\d+)?$/, `${cluster}/${seat.role} env override`);
    }
  }
  assert.equal(
    AGENT_SEATS["mainnet-beta"].find((s) => s.role === "governance").secretField,
    "private key",
    "solana.turf.governance's field has a SPACE — do not normalise it"
  );
  assert.equal(
    AGENT_SEATS.devnet.find((s) => s.role === "seat-a.devnet").secretField,
    "private key",
    "the devnet seat items were filed with `private key`, with a SPACE"
  );
});

test("resolveCluster hands back copies, so a caller cannot mutate the roster", () => {
  const first = resolveCluster("devnet");
  first.agentSeats[0].pubkey = "tampered";
  assert.notEqual(resolveCluster("devnet").agentSeats[0].pubkey, "tampered");
});

// --- names, for refusals a human reads --------------------------------------

test("member names cover every key either cluster can present", () => {
  const seatKeys = Object.values(AGENT_SEATS).flat().map((s) => s.pubkey);
  for (const key of seatKeys) {
    assert.notEqual(
      memberName(key),
      "unrecognised",
      `${key} is on the roster but has no name — a handoff would print bare base58`
    );
  }
  assert.equal(memberName("NotAKey"), "unrecognised", "an unknown key says so rather than guessing");
});

test("the operator's wallets are named for Mr. McRitchie, because Alex is an agent", () => {
  // These three seats are the approvals a mainnet HANDOFF waits on, and
  // squad-upgrade.js prints memberName() beside each one. Until 2026-09-16 they
  // read "Alex Phantom", "Alex two" and "Alex three" — and in this ecosystem Alex
  // is an AGENT, so the line a person reads mid-ceremony named the wrong party.
  const operatorWallets = [
    "7ZDJp7FUHhuceAqcW9CHe81hCiaMTjgWAXfprBM59Tcr",
    "3Qj4v9qjhXgkru6zCRCErRVhy8Q6qU3NrNpvpXLTZboA",
    "9gACbzsCLmkYF9Yx1EBGmwMvvyfuTquJ6qs8QsoQvHXf",
  ];
  for (const key of operatorWallets) {
    assert.match(memberName(key), /^Mr\. McRitchie's .+ \(operator\)$/, `${key} is Mr. McRitchie's wallet`);
  }
  for (const [key, label] of Object.entries(MEMBER_NAMES)) {
    assert.doesNotMatch(label, /\bAlex\b/, `${key} reads "${label}" — Alex is an agent, not the operator`);
  }
});

// --- the coupling this suite cannot check in CI -----------------------------

test("the Squads account discriminators in the fixtures match the SDK", (t) => {
  // scripts/tests/upgrade-instruction.test.js hardcodes the VaultTransaction,
  // ConfigTransaction and Batch discriminators so that it needs no dependency
  // tree. Production passes the SDK's own values (squad-upgrade.js), so a drift
  // would make the FIXTURE wrong, not the check — and a fixture testing a case
  // that cannot occur is worth nothing.
  //
  // CI's guards lane installs no node_modules, so this self-skips there. It
  // bites where the dependency tree exists: a builder's `bin/release-check`.
  let sdk;
  try {
    sdk = require("@sqds/multisig");
  } catch (_) {
    t.skip("@sqds/multisig not installed (CI guards lane) — run bin/release-check locally");
    return;
  }

  assert.deepEqual(
    Array.from(sdk.accounts.vaultTransactionDiscriminator),
    [168, 250, 162, 100, 81, 14, 162, 207]
  );
  assert.deepEqual(
    Array.from(sdk.accounts.configTransactionDiscriminator),
    [94, 8, 4, 35, 113, 139, 139, 112]
  );
  assert.deepEqual(
    Array.from(sdk.accounts.batchDiscriminator),
    [156, 194, 70, 44, 22, 88, 137, 44]
  );
});

test("the committed squad.json parses and the file path is inside scripts/", () => {
  assert.equal(path.basename(SQUAD_JSON), "squad.json");
  assert.doesNotThrow(() => cfg());
});
