#!/usr/bin/env node
/**
 * CEREMONY — move the SOL left on the rotated-out admin key BLSBw8…
 * (`solana.turf.admin`) after rotate-admin-seat.js removed it from the
 * cluster's multisig. 2026-10-09, task rotate-mainnet-admin-key.
 *
 * Two shapes; pass one:
 *
 *   EXACT  --to=<pubkey>:<sol> (repeatable). One plain system transfer per
 *          --to, each its OWN transaction and signature, in the order given.
 *          Whatever is left stays on BLSBw8; it must end at 0 or at least the
 *          rent-exempt minimum.  (Mr. McRitchie's 2026-10-09 ruling used this.)
 *
 *   SWEEP  --rest=<pubkey> --leave=zero|rent [--fund=<pubkey>:<sol>]. One
 *          transaction: optional fixed transfer, then everything else, fee-aware,
 *          so BLSBw8 ends at exactly 0 or at the rent-exempt minimum.
 *
 * Refuses unless BLSBw8 is already OUT of this cluster's multisig at
 * `finalized` — the sweep follows the swap, never precedes it.
 *
 * SOL ONLY. SPL token accounts owned by BLSBw8 are listed, never moved.
 *
 * DRY RUN BY DEFAULT: each unsigned transaction is SIMULATED (sigVerify off),
 * so a dry run loads no key material. --send arms it; the key is read from
 * 1Password at run time, never from argv or disk.
 *
 * Destinations are allow-listed (the governance seat, the cluster's Squads
 * vault, the operator's wallets); anything else is refused as a likely typo.
 *
 *   node scripts/ceremony/sweep-admin-seat.js --cluster=mainnet \
 *     --to=4bKNSqkrKeggSyrds16Ak7rcB4ibvGJ4ZLsKjvQgC3Vk:0.5 \
 *     --to=7ZDJp7FUHhuceAqcW9CHe81hCiaMTjgWAXfprBM59Tcr:3 [--send]
 */
"use strict";

const {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} = require("@solana/web3.js");
const multisig = require("@sqds/multisig");
const bs58m = require("bs58");
const { execFileSync } = require("child_process");

const { MEMBER_NAMES, memberName, resolveCluster, seatSecretSource } = require("../lib/squad-clusters");
const { NEW_SEAT, OLD_SEAT } = require("../lib/admin-seat-rotation");

const bs58 = bs58m.default || bs58m;
const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];
const OLD_ITEM = { role: "admin (rotated out)", pubkey: OLD_SEAT, item: "solana.turf.admin", vault: "studio-agents", secretField: "private-key" };

const argv = process.argv.slice(2);
const value = (n) => (argv.find((a) => a.startsWith(`${n}=`)) || "").slice(n.length + 1);
const values = (n) => argv.filter((a) => a.startsWith(`${n}=`)).map((a) => a.slice(n.length + 1));
const SEND = argv.includes("--send");
const fail = (m, code = 1) => {
  console.error(`\nREFUSED — ${m}`);
  process.exit(code);
};
const sol = (l) => (l / LAMPORTS_PER_SOL).toFixed(9);

let cfg;
try {
  cfg = resolveCluster(value("--cluster"));
} catch (e) {
  fail(e.message, 2);
}

const operators = Object.keys(MEMBER_NAMES).filter((k) => /\(operator\)/.test(MEMBER_NAMES[k]));
const ALLOWED = new Set([NEW_SEAT, cfg.vaultPda, ...operators]);
function dest(pk, flag) {
  let key;
  try {
    key = new PublicKey(pk);
  } catch (_) {
    fail(`${flag} ${pk} is not a public key.`, 2);
  }
  if (!ALLOWED.has(key.toBase58())) {
    fail(`${flag} ${pk} is not an allowed destination (governance seat, ${cfg.cluster} Squads vault, operator wallets).`, 2);
  }
  return key;
}
function amount(spec, flag) {
  const i = spec.lastIndexOf(":");
  if (i < 0) fail(`${flag}=<pubkey>:<sol> expected, got ${spec}.`, 2);
  const lamports = Math.round(Number(spec.slice(i + 1)) * LAMPORTS_PER_SOL);
  if (!Number.isFinite(lamports) || lamports <= 0) fail(`${flag} needs a positive SOL amount.`, 2);
  return { to: dest(spec.slice(0, i), flag), lamports };
}
const label = (k) => (k.toBase58() === cfg.vaultPda ? `${cfg.cluster} Squads vault` : memberName(k.toBase58()));

const exact = values("--to").map((s) => amount(s, "--to"));
const MODE = exact.length ? "exact" : "sweep";
let leave, rest, fund;
if (MODE === "exact") {
  if (value("--rest") || value("--fund") || value("--leave")) fail("--to is the EXACT shape; do not mix it with --rest/--fund/--leave.", 2);
} else {
  leave = value("--leave");
  if (!["zero", "rent"].includes(leave)) fail("pass --to=<pubkey>:<sol>, or --rest=<pubkey> with --leave=zero|rent.", 2);
  if (!value("--rest")) fail("--rest=<pubkey> is required for a sweep.", 2);
  rest = dest(value("--rest"), "--rest");
  fund = value("--fund") ? amount(value("--fund"), "--fund") : null;
  if (fund && fund.to.equals(rest)) fail("--fund and --rest name the same account; use --rest alone.", 2);
}

const FROM = new PublicKey(OLD_SEAT);
function tx(transfers, blockhash) {
  const t = new Transaction({ feePayer: FROM, recentBlockhash: blockhash });
  transfers.forEach((x) => t.add(SystemProgram.transfer({ fromPubkey: FROM, toPubkey: x.to, lamports: x.lamports })));
  return t;
}
async function feeOf(conn, transfers, blockhash) {
  const fee = (await conn.getFeeForMessage(tx(transfers, blockhash).compileMessage(), "confirmed")).value;
  if (fee == null) fail("the RPC returned no fee for the message.");
  return fee;
}

/** The transactions to send, in order, each a list of transfers. */
async function plan(conn) {
  const info = await conn.getAccountInfo(FROM, "confirmed");
  if (!info) fail(`${OLD_SEAT} has no account on ${cfg.cluster}; nothing to move.`);
  if (!info.owner.equals(SystemProgram.programId) || info.data.length) fail(`${OLD_SEAT} is not a plain system account.`);
  const rentMin = await conn.getMinimumBalanceForRentExemption(0, "confirmed");
  const { blockhash } = await conn.getLatestBlockhash("confirmed");

  let txs;
  let left;
  if (MODE === "exact") {
    txs = exact.map((x) => [x]);
    let fees = 0;
    for (const t of txs) fees += await feeOf(conn, t, blockhash);
    left = info.lamports - fees - exact.reduce((a, x) => a + x.lamports, 0);
    if (left < 0) fail(`balance ${sol(info.lamports)} SOL cannot cover the transfers plus fees.`);
    if (left > 0 && left < rentMin) fail(`BLSBw8 would be left at ${sol(left)} SOL, under rent-exempt ${sol(rentMin)}.`);
  } else {
    const fee = await feeOf(conn, [...(fund ? [fund] : []), { to: rest, lamports: 1 }], blockhash);
    const keep = leave === "rent" ? rentMin : 0;
    const restLamports = info.lamports - fee - keep - (fund ? fund.lamports : 0);
    if (restLamports <= 0) fail(`balance ${sol(info.lamports)} SOL cannot cover fund + fee + keep.`);
    txs = [[...(fund ? [fund] : []), { to: rest, lamports: restLamports }]];
    left = keep;
  }
  for (const t of txs) {
    for (const x of t) {
      const cur = await conn.getBalance(x.to, "confirmed");
      if (cur + x.lamports < rentMin) fail(`${x.to.toBase58()} would hold ${sol(cur + x.lamports)} SOL, under rent-exempt ${sol(rentMin)}.`);
    }
  }
  return { balance: info.lamports, rentMin, txs, left };
}

(async () => {
  const conn = new Connection(cfg.rpcUrl, "confirmed");
  const fin = new Connection(cfg.rpcUrl, "finalized");
  const gen = await conn.getGenesisHash();
  if (gen !== cfg.genesisHash) fail(`${cfg.cluster} genesis mismatch (got ${gen}).`, 2);

  // The sweep follows the swap: BLSBw8 must already be out of the multisig.
  const ms = await multisig.accounts.Multisig.fromAccountAddress(fin, new PublicKey(cfg.multisigPda));
  if (ms.members.some((m) => m.key.toBase58() === OLD_SEAT)) {
    fail(`${OLD_SEAT} is still a member of the ${cfg.cluster} multisig at finalized; execute the rotation first.`);
  }

  const p = await plan(conn);
  console.log(`\n${cfg.cluster.toUpperCase()}  move SOL off ${OLD_SEAT}  mode ${MODE}  ${SEND ? "ARMED (--send)" : "dry run (simulated, no key loaded)"}`);
  console.log(`  BLSBw8 out of multisig ${cfg.multisigPda} at finalized: confirmed`);
  console.log(`  balance            ${sol(p.balance)} SOL`);
  p.txs.forEach((t, i) => t.forEach((x) => console.log(`  tx ${i + 1}: -> ${x.to.toBase58()}  ${sol(x.lamports)} SOL  (${label(x.to)})`)));
  console.log(`  left on BLSBw8     ${sol(p.left)} SOL after fees (rent-exempt minimum reads ${sol(p.rentMin)})`);
  for (const prog of TOKEN_PROGRAMS) {
    const t = await conn.getParsedTokenAccountsByOwner(FROM, { programId: new PublicKey(prog) });
    t.value.forEach((x) => {
      const i = x.account.data.parsed.info;
      console.log(`  NOT MOVED: token account ${x.pubkey.toBase58()} mint ${i.mint} amount ${i.tokenAmount.uiAmountString}`);
    });
  }

  if (!SEND) {
    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    for (const [i, t] of p.txs.entries()) {
      const r = (
        await conn.simulateTransaction(new VersionedTransaction(tx(t, blockhash).compileMessage()), {
          sigVerify: false,
          replaceRecentBlockhash: true,
        })
      ).value;
      if (r.err) fail(`simulation of tx ${i + 1} failed: ${JSON.stringify(r.err)}\n${(r.logs || []).join("\n")}`);
      console.log(`  simulation of tx ${i + 1} OK (alone, against the current balance)`);
    }
    console.log("\n  DRY RUN — nothing signed or sent. Re-run with --send.\n");
    return;
  }

  const spec = seatSecretSource(OLD_ITEM);
  const raw = execFileSync("op", ["read", spec.ref], { encoding: "utf8", env: spec.childEnv, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const kp = Keypair.fromSecretKey(raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw));
  if (kp.publicKey.toBase58() !== OLD_SEAT) fail(`${spec.ref} does not derive to ${OLD_SEAT}.`);
  console.log("  BLSBw8 key loaded and verified");

  const fresh = await plan(conn); // re-read: the balance may have moved since the printout
  for (const [i, t] of fresh.txs.entries()) {
    const latest = await conn.getLatestBlockhash("finalized");
    const signed = tx(t, latest.blockhash);
    signed.sign(kp);
    const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false });
    const res = await fin.confirmTransaction({ signature: sig, ...latest }, "finalized");
    if (res.value.err) fail(`tx ${i + 1} ${sig} failed: ${JSON.stringify(res.value.err)}`);
    console.log(`  tx ${i + 1} finalized  ${sig}`);
  }
  const seen = new Map([[OLD_SEAT, FROM]]);
  fresh.txs.flat().forEach((x) => seen.set(x.to.toBase58(), x.to));
  console.log("\n  balances at finalized:");
  for (const [k, pk] of seen) console.log(`    ${k}  ${sol(await fin.getBalance(pk))} SOL  (${k === OLD_SEAT ? "BLSBw8, rotated out" : label(pk)})`);
  console.log("");
})().catch((e) => {
  console.error("\nFAILED:", e.message);
  process.exit(1);
});
