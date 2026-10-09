#!/usr/bin/env node
/**
 * CEREMONY — empty and close the SPL token accounts owned by the rotated-out
 * admin key BLSBw8… (`solana.turf.admin`, archived). 2026-10-09, task
 * rotate-mainnet-admin-key, on Mr. McRitchie's ruling ("defaults, do both").
 *
 * ONE atomic transaction. For every token account BLSBw8 owns:
 *   createAssociatedTokenAccountIdempotent(recipient ATA)   payer: governance 4bKN
 *   transferChecked(all of it -> recipient ATA)             authority: BLSBw8
 *   closeAccount(rent -> recipient wallet)                   authority: BLSBw8
 * Fee payer is the governance seat `4bKN…`. BLSBw8 signs only as token owner.
 *
 * REFUSES unless every account is classic SPL Token, initialized, without a
 * delegate or close authority, and holds a mint on the canonical allow-list
 * below. An unknown mint is refused, never guessed at.
 *
 * DRY RUN BY DEFAULT: the unsigned transaction is SIMULATED (sigVerify off).
 * --send reads both keys from 1Password at run time (BLSBw8 from the archive),
 * never from argv or disk.
 *
 *   node scripts/ceremony/sweep-admin-tokens.js --cluster=mainnet \
 *     --to=7ZDJp7FUHhuceAqcW9CHe81hCiaMTjgWAXfprBM59Tcr [--send]
 */
"use strict";

const { Connection, Keypair, PublicKey, Transaction, VersionedTransaction } = require("@solana/web3.js");
const spl = require("@solana/spl-token");
const bs58m = require("bs58");
const { execFileSync } = require("child_process");

const { AGENT_SEATS, MEMBER_NAMES, resolveCluster, seatSecretSource } = require("../lib/squad-clusters");
const { NEW_SEAT, OLD_SEAT } = require("../lib/admin-seat-rotation");

const bs58 = bs58m.default || bs58m;
// Canonical mainnet mints (Circle USDC, Tether USDT). Anything else refuses.
const CANONICAL = {
  "mainnet-beta": {
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
    Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
  },
  devnet: {},
};
const OLD_ITEM = { role: "admin (rotated out)", pubkey: OLD_SEAT, item: "solana.turf.admin", vault: "studio-agents", secretField: "private-key" };

const argv = process.argv.slice(2);
const value = (n) => (argv.find((a) => a.startsWith(`${n}=`)) || "").slice(n.length + 1);
const SEND = argv.includes("--send");
const fail = (m, code = 1) => {
  console.error(`\nREFUSED — ${m}`);
  process.exit(code);
};

let cfg;
try {
  cfg = resolveCluster(value("--cluster"));
} catch (e) {
  fail(e.message, 2);
}
let TO;
try {
  TO = new PublicKey(value("--to"));
} catch (_) {
  fail("--to=<wallet> is required.", 2);
}
const operators = Object.keys(MEMBER_NAMES).filter((k) => /\(operator\)/.test(MEMBER_NAMES[k]));
if (!operators.includes(TO.toBase58())) fail(`--to ${TO.toBase58()} is not one of the operator's wallets.`, 2);

const OWNER = new PublicKey(OLD_SEAT);
const PAYER = new PublicKey(NEW_SEAT);

function keyFrom(raw, want, label) {
  const t = String(raw).trim();
  const kp = Keypair.fromSecretKey(t.startsWith("[") ? Uint8Array.from(JSON.parse(t)) : bs58.decode(t));
  if (kp.publicKey.toBase58() !== want) fail(`${label} does not derive to ${want}.`);
  return kp;
}
function readOld() {
  const spec = seatSecretSource(OLD_ITEM);
  try {
    return execFileSync("op", ["read", spec.ref], { encoding: "utf8", env: spec.childEnv, stdio: ["ignore", "pipe", "pipe"] });
  } catch (_) {
    // Archived: `op read` cannot resolve it; a read from the archive suffices (no unarchive).
    const out = execFileSync(
      "op",
      ["item", "get", OLD_ITEM.item, "--vault", spec.vault, "--include-archive", "--fields", `label=${OLD_ITEM.secretField}`, "--reveal", "--format", "json"],
      { encoding: "utf8", env: spec.childEnv, stdio: ["ignore", "pipe", "pipe"] }
    );
    console.log(`  read ${OLD_ITEM.item} from the 1Password ARCHIVE (not unarchived)`);
    return JSON.parse(out).value;
  }
}
function readPayer() {
  const seat = AGENT_SEATS[cfg.cluster].find((s) => s.pubkey === NEW_SEAT);
  if (!seat) fail("the governance seat is not on this cluster's roster.");
  const spec = seatSecretSource(seat);
  return execFileSync("op", ["read", spec.ref], { encoding: "utf8", env: spec.childEnv, stdio: ["ignore", "pipe", "pipe"] });
}

async function plan(conn) {
  const canon = CANONICAL[cfg.cluster];
  const t22 = await conn.getParsedTokenAccountsByOwner(OWNER, { programId: spl.TOKEN_2022_PROGRAM_ID }, "confirmed");
  if (t22.value.length) fail(`BLSBw8 owns ${t22.value.length} Token-2022 account(s); this script handles classic SPL only.`);
  const r = await conn.getParsedTokenAccountsByOwner(OWNER, { programId: spl.TOKEN_PROGRAM_ID }, "confirmed");
  const items = [];
  for (const x of r.value) {
    const i = x.account.data.parsed.info;
    const where = x.pubkey.toBase58();
    if (!canon[i.mint]) fail(`${where} holds mint ${i.mint}, which is not on the canonical list. Refusing all.`);
    if (i.state !== "initialized") fail(`${where} is ${i.state}.`);
    if (i.delegate) fail(`${where} has a delegate ${i.delegate}.`);
    if (i.closeAuthority) fail(`${where} has a close authority ${i.closeAuthority}.`);
    const mint = new PublicKey(i.mint);
    const ata = spl.getAssociatedTokenAddressSync(mint, TO, false, spl.TOKEN_PROGRAM_ID);
    items.push({
      source: x.pubkey,
      mint,
      symbol: canon[i.mint],
      amount: BigInt(i.tokenAmount.amount),
      decimals: i.tokenAmount.decimals,
      ui: i.tokenAmount.uiAmountString,
      rent: x.account.lamports,
      ata,
      ataExists: !!(await conn.getAccountInfo(ata, "confirmed")),
    });
  }
  if (!items.length) fail("BLSBw8 owns no token accounts; nothing to do.");
  return items;
}

function build(items, blockhash) {
  const tx = new Transaction({ feePayer: PAYER, recentBlockhash: blockhash });
  for (const it of items) {
    tx.add(spl.createAssociatedTokenAccountIdempotentInstruction(PAYER, it.ata, TO, it.mint, spl.TOKEN_PROGRAM_ID));
    if (it.amount > 0n) {
      tx.add(spl.createTransferCheckedInstruction(it.source, it.mint, it.ata, OWNER, it.amount, it.decimals, [], spl.TOKEN_PROGRAM_ID));
    }
    tx.add(spl.createCloseAccountInstruction(it.source, TO, OWNER, [], spl.TOKEN_PROGRAM_ID));
  }
  return tx;
}

(async () => {
  const conn = new Connection(cfg.rpcUrl, "confirmed");
  const fin = new Connection(cfg.rpcUrl, "finalized");
  const gen = await conn.getGenesisHash();
  if (gen !== cfg.genesisHash) fail(`${cfg.cluster} genesis mismatch (got ${gen}).`, 2);

  const items = await plan(conn);
  console.log(`\n${cfg.cluster.toUpperCase()}  empty + close BLSBw8's token accounts -> ${TO.toBase58()}  ${SEND ? "ARMED (--send)" : "dry run (simulated, no key loaded)"}`);
  console.log(`  fee payer ${NEW_SEAT} (governance): ${((await conn.getBalance(PAYER)) / 1e9).toFixed(9)} SOL`);
  for (const it of items) {
    console.log(`  ${it.symbol} mint ${it.mint.toBase58()} (canonical)`);
    console.log(`    ${it.source.toBase58()}  ${it.ui} ${it.symbol} (raw ${it.amount}) -> ATA ${it.ata.toBase58()} ${it.ataExists ? "(exists)" : "(will be created)"}`);
    console.log(`    close; rent ${(it.rent / 1e9).toFixed(9)} SOL -> ${TO.toBase58()}`);
  }

  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  if (!SEND) {
    const r = (
      await conn.simulateTransaction(new VersionedTransaction(build(items, blockhash).compileMessage()), {
        sigVerify: false,
        replaceRecentBlockhash: true,
      })
    ).value;
    if (r.err) fail(`simulation failed: ${JSON.stringify(r.err)}\n${(r.logs || []).join("\n")}`);
    console.log("  simulation OK");
    console.log("\n  DRY RUN — nothing signed or sent. Re-run with --send.\n");
    return;
  }

  const payer = keyFrom(readPayer(), NEW_SEAT, "solana.turf.governance");
  const owner = keyFrom(readOld(), OLD_SEAT, "solana.turf.admin");
  console.log("  both keys loaded and verified");
  const fresh = await plan(conn);
  const latest = await conn.getLatestBlockhash("finalized");
  const tx = build(fresh, latest.blockhash);
  tx.sign(payer, owner);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const res = await fin.confirmTransaction({ signature: sig, ...latest }, "finalized");
  if (res.value.err) fail(`${sig} failed: ${JSON.stringify(res.value.err)}`);
  console.log(`  finalized  ${sig}`);

  const left = await fin.getParsedTokenAccountsByOwner(OWNER, { programId: spl.TOKEN_PROGRAM_ID });
  const left22 = await fin.getParsedTokenAccountsByOwner(OWNER, { programId: spl.TOKEN_2022_PROGRAM_ID });
  console.log(`\n  BLSBw8 token accounts at finalized: ${left.value.length + left22.value.length}`);
  for (const it of fresh) {
    const b = await fin.getTokenAccountBalance(it.ata);
    console.log(`  ${TO.toBase58()} ${it.symbol} (${it.ata.toBase58()}): ${b.value.uiAmountString}`);
  }
  console.log("");
})().catch((e) => {
  console.error("\nFAILED:", e.message);
  process.exit(1);
});
