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
  AGENT_SEATS,
  ClusterError,
  GENESIS,
  MEMBER_NAMES,
  SQUAD_JSON,
  addressesFor,
  canonicalCluster,
  memberName,
  resolveCluster,
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
  // Read off chain 2026-09-15, after the day's second rotation. Both multisigs
  // are threshold 3 of 5; mainnet's agent seats reach 2 and devnet's reach 3,
  // which is the asymmetry the two behaviours are built on.
  assert.deepEqual(
    AGENT_SEATS["mainnet-beta"].map((s) => s.pubkey),
    [
      "7auwTLSvNniSUeAgL6v9RStMXJhWrrUhSJgwFWLpcqC", // system
      "BLSBw8fXHzZc5pbaYCKMpMSsrtXBTbWXpUPVzMrXx9oo", // admin
    ]
  );
  assert.deepEqual(
    AGENT_SEATS.devnet.map((s) => s.pubkey),
    [
      "2eGs8G3wzhEeNQQU2Q86BmmA2xTpDbMMae3Y1bvpZfx9", // system.devnet
      "BLSBw8fXHzZc5pbaYCKMpMSsrtXBTbWXpUPVzMrXx9oo", // admin
      "8K81w4e6UcB7TiANhM9N8sAgijJvTxxybRi8AENRaRYd", // Xan — devnet ONLY since 09:41
    ]
  );
});

test("no retired key is offered on the cluster that removed it", () => {
  // The whole defect: `ALEX_BOT_KEY` was Xan and `MASON_KEY` was Mason, and both
  // were removed from both multisigs at 09:41 on 2026-09-15. Mason is gone from
  // everywhere; Xan survives on devnet alone.
  const MASON = "CytJS23p1zCM2wvUUngiDePtbMB484ebD7bK4nDqWjrR";
  const XAN = "8K81w4e6UcB7TiANhM9N8sAgijJvTxxybRi8AENRaRYd";

  for (const cluster of Object.keys(AGENT_SEATS)) {
    assert.ok(
      !AGENT_SEATS[cluster].some((s) => s.pubkey === MASON),
      `${cluster} must not offer Mason — removed from both multisigs`
    );
  }
  assert.ok(!AGENT_SEATS["mainnet-beta"].some((s) => s.pubkey === XAN));
  assert.ok(AGENT_SEATS.devnet.some((s) => s.pubkey === XAN));
});

test("every seat names a 1Password item, its FIELD, and an env override", () => {
  // The field label differs between items and that is not a typo to tidy:
  // `solana.turf.*` spell it `private-key`; `agent.xan.solana` spells it
  // `private key`, with a space. Reading the wrong label fails naming the item
  // but not the field.
  for (const [cluster, seats] of Object.entries(AGENT_SEATS)) {
    for (const seat of seats) {
      assert.ok(seat.role, `${cluster} seat needs a role`);
      assert.match(seat.item, /^[a-z0-9.]+$/, `${cluster}/${seat.role} item`);
      assert.match(seat.secretField, /^private[- ]key$/, `${cluster}/${seat.role} field`);
      assert.match(seat.env, /^SQUAD_KEY_[A-Z]+$/, `${cluster}/${seat.role} env override`);
    }
  }
  assert.equal(
    AGENT_SEATS.devnet.find((s) => s.role === "xan").secretField,
    "private key",
    "agent.xan.solana's field has a SPACE — do not normalise it"
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
