/**
 * squad-clusters — the per-cluster facts an upgrade needs, in ONE place, and
 * the roster of seats the AGENT can sign with on each.
 *
 * WHY THIS EXISTS (2026-09-15). `squad-upgrade.js` used to read four top-level
 * fields out of `scripts/squad.json` and hardcode two env vars —
 * `ALEX_BOT_KEY` and `MASON_KEY` — as creator, both approvers and fee payer.
 * That made it a MAINNET-ONLY script that could only ever act with two named
 * people's keys. When the 09:41 Squads rotation removed Xan (`8K81w4e6…`) and
 * Mason (`CytJS23p…`) from both multisigs, the script could no longer create,
 * approve or execute an upgrade on EITHER cluster — the capability was intact,
 * the tooling pointed at retired seats.
 *
 * So the cluster is now a REQUIRED argument with a genesis-hash guard, and the
 * keys the script signs with are a ROSTER that is intersected with live
 * membership rather than a pair of names it assumes are seated.
 *
 * THE ROSTER IS A LIST OF SEATS TO TRY, NOT A CLAIM ABOUT THE CHAIN. A seat in
 * this table that is not a live member is REPORTED AND DROPPED, never fatal.
 * That is the whole lesson of the rotation: a roster that must be right is a
 * roster that breaks every time membership changes, and membership changed
 * twice in one morning. The chain decides; this table only says which keys are
 * worth offering it.
 *
 * WHY THE PUBKEYS ARE WRITTEN OUT HERE. They are public data, they make the
 * roster legible in a diff, and — the operational reason — they let a DRY RUN
 * classify the whole flow with ZERO key material and zero 1Password reads. A
 * `--send` run loads the secret and REFUSES unless it derives to the pubkey
 * recorded here, so the literal is a cross-check rather than a second source.
 *
 * WHERE MAINNET'S ADDRESSES COME FROM. Not from here — from `squad.json`'s top
 * level, which `scripts/lib/mainnet-config.js` documents at length as the ONE
 * copy. Two copies of those four addresses, read by two scripts, is how an
 * upgrade and an initialize end up pointed at different programs. Devnet gets
 * its own `devnet` block in the same file: a different cluster is not a second
 * copy, and the flat-mainnet contract `mainnet-config.js` depends on is
 * untouched by a sibling key.
 *
 * NOTE THE TWO VOCABULARIES IN squad.json, because they have been conflated
 * before. `members` / `threshold` at its top level are the PROGRAM's own
 * `VaultState` signer set, which `initialize-mainnet.js` writes on chain — NOT
 * the Squads multisig membership. The Squads membership is never read from a
 * file; it is read from the chain, every run.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const SQUAD_JSON = path.join(__dirname, "..", "squad.json");

/** A cluster's genesis hash — the only unforgeable proof of which chain answered. */
const GENESIS = {
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
};

/**
 * The agent's candidate seats, per cluster.
 *
 * `item` / `secretField` name the 1Password entry a `--send` run reads. The
 * field LABEL differs between items and that is not a typo to tidy:
 * `solana.turf.*` spell it `private-key`, `agent.xan.solana` spells it
 * `private key`, with a space. Reading the wrong label returns an error that
 * names the item but not the field, so both spellings are recorded.
 *
 * `env` is the override: set it and 1Password is not consulted for that seat.
 */
const AGENT_SEATS = {
  "mainnet-beta": [
    {
      role: "system",
      pubkey: "7auwTLSvNniSUeAgL6v9RStMXJhWrrUhSJgwFWLpcqC",
      item: "solana.turf.system",
      secretField: "private-key",
      env: "SQUAD_KEY_SYSTEM",
    },
    {
      role: "admin",
      pubkey: "BLSBw8fXHzZc5pbaYCKMpMSsrtXBTbWXpUPVzMrXx9oo",
      item: "solana.turf.admin",
      secretField: "private-key",
      env: "SQUAD_KEY_ADMIN",
    },
  ],
  devnet: [
    {
      role: "system.devnet",
      pubkey: "2eGs8G3wzhEeNQQU2Q86BmmA2xTpDbMMae3Y1bvpZfx9",
      item: "solana.turf.system.devnet",
      secretField: "private-key",
      env: "SQUAD_KEY_SYSTEM",
    },
    {
      role: "admin",
      pubkey: "BLSBw8fXHzZc5pbaYCKMpMSsrtXBTbWXpUPVzMrXx9oo",
      item: "solana.turf.admin",
      secretField: "private-key",
      env: "SQUAD_KEY_ADMIN",
    },
    {
      role: "xan",
      pubkey: "8K81w4e6UcB7TiANhM9N8sAgijJvTxxybRi8AENRaRYd",
      item: "agent.xan.solana",
      secretField: "private key",
      env: "SQUAD_KEY_XAN",
    },
  ],
};

/**
 * Members nobody holds a key for, named so a run can say WHOSE approval it is
 * waiting on instead of printing a bare base58 string at someone under
 * pressure. Absence from this map is not an error — an unrecognised member is
 * reported as `unrecognised`, which is itself worth seeing.
 *
 * The operator is Mr. McRitchie. "Alex" is an AGENT in this ecosystem, so a
 * handoff that printed "waiting on Alex Phantom" named the wrong party; the
 * three operator labels said exactly that until 2026-09-16.
 *
 * A DATE IN A LABEL NAMES THE MULTISIG IT HAPPENED ON. `F6f8…` read "evicted
 * 2026-06-06" — true of the devnet Squad only, while the key stayed seated on
 * the first mainnet Squad `9dCLM…` until config transaction #2 removed it on
 * 2026-09-16. A bare date was true of one multisig and read as true of all.
 */
const MEMBER_NAMES = {
  "7ZDJp7FUHhuceAqcW9CHe81hCiaMTjgWAXfprBM59Tcr": "Mr. McRitchie's Phantom (operator)",
  "3Qj4v9qjhXgkru6zCRCErRVhy8Q6qU3NrNpvpXLTZboA": "Mr. McRitchie's second (operator)",
  "9gACbzsCLmkYF9Yx1EBGmwMvvyfuTquJ6qs8QsoQvHXf": "Mr. McRitchie's third (operator)",
  "7auwTLSvNniSUeAgL6v9RStMXJhWrrUhSJgwFWLpcqC": "system (agent)",
  "2eGs8G3wzhEeNQQU2Q86BmmA2xTpDbMMae3Y1bvpZfx9": "system.devnet (agent)",
  BLSBw8fXHzZc5pbaYCKMpMSsrtXBTbWXpUPVzMrXx9oo: "admin (agent)",
  "8K81w4e6UcB7TiANhM9N8sAgijJvTxxybRi8AENRaRYd": "Xan (agent)",
  CytJS23p1zCM2wvUUngiDePtbMB484ebD7bK4nDqWjrR: "Mason (retired: live Squads 2026-09-15, 9dCLM 2026-09-16)",
  F6f8h5yynbnkgWvU5abQx3RJxJpe8EoQmeFBuNKdKzhZ: "LEAKED agent.solana (evicted: devnet 2026-06-06, 9dCLM 2026-09-16)",
};

const DEFAULT_RPC = {
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
  devnet: "https://api.devnet.solana.com",
};

class ClusterError extends Error {
  constructor(message) {
    super(message);
    this.name = "ClusterError";
  }
}

/** `--cluster=mainnet` and `--cluster=mainnet-beta` name the same chain. */
function canonicalCluster(name) {
  if (name === "mainnet" || name === "mainnet-beta") return "mainnet-beta";
  if (name === "devnet") return "devnet";
  return null;
}

const REQUIRED_ADDRESSES = ["programId", "multisigPda", "vaultPda"];

/**
 * Pull one cluster's address block out of a parsed squad.json.
 *
 * mainnet-beta is the FLAT top level (the shape the file ships and
 * `mainnet-config.js` resolves); devnet is the `devnet` block. A cluster whose
 * block is missing or incomplete ABORTS — an upgrade is not a place to infer an
 * address.
 */
function addressesFor(cfg, cluster) {
  const block = cluster === "mainnet-beta" ? cfg : cfg.devnet;
  const label = cluster === "mainnet-beta" ? "squad.json top level" : "squad.json devnet block";

  if (!block || typeof block !== "object") {
    throw new ClusterError(
      `${label} is missing — ${cluster} has no programId/multisigPda/vaultPda to upgrade.`
    );
  }
  const missing = REQUIRED_ADDRESSES.filter(
    (k) => typeof block[k] !== "string" || block[k].length === 0
  );
  if (missing.length) {
    throw new ClusterError(`${label} is missing ${missing.join(", ")}.`);
  }
  if (cluster === "mainnet-beta" && cfg.network !== "mainnet-beta") {
    throw new ClusterError(
      `squad.json's top level declares network ${JSON.stringify(cfg.network)}, not "mainnet-beta". ` +
        `Refusing to treat it as the mainnet upgrade target.`
    );
  }
  return {
    programId: block.programId,
    multisigPda: block.multisigPda,
    vaultPda: block.vaultPda,
  };
}

/**
 * Resolve everything one upgrade run needs for one cluster.
 *
 * @param {string} name   "devnet" | "mainnet" | "mainnet-beta" (REQUIRED — no default)
 * @param {object} [opts] `{ cfg, rpcUrl }` for tests; both default from disk/env.
 * @returns {{cluster, rpcUrl, genesisHash, programId, multisigPda, vaultPda,
 *            agentSeats: Array<{role, pubkey, item, secretField, env}>}}
 */
function resolveCluster(name, opts = {}) {
  const cluster = canonicalCluster(name);
  if (!cluster) {
    throw new ClusterError(
      `--cluster=devnet|mainnet is REQUIRED (got ${JSON.stringify(name ?? null)}). ` +
        `There is no default: a convenient default is how a ceremony step hits the wrong chain.`
    );
  }
  const cfg = opts.cfg || JSON.parse(fs.readFileSync(SQUAD_JSON, "utf8"));
  const addresses = addressesFor(cfg, cluster);

  return {
    cluster,
    rpcUrl: opts.rpcUrl || process.env.SOLANA_RPC_URL || DEFAULT_RPC[cluster],
    genesisHash: GENESIS[cluster],
    ...addresses,
    agentSeats: AGENT_SEATS[cluster].map((seat) => ({ ...seat })),
  };
}

/** "Mr. McRitchie's Phantom (operator)" — or "unrecognised", which is worth seeing. */
function memberName(pubkey) {
  return MEMBER_NAMES[pubkey] || "unrecognised";
}

module.exports = {
  AGENT_SEATS,
  ClusterError,
  DEFAULT_RPC,
  GENESIS,
  MEMBER_NAMES,
  REQUIRED_ADDRESSES,
  SQUAD_JSON,
  addressesFor,
  canonicalCluster,
  memberName,
  resolveCluster,
};
