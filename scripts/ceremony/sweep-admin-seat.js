#!/usr/bin/env node
/**
 * CEREMONY — sweep the SOL left on the rotated-out admin key BLSBw8…
 * (`solana.turf.admin`), after rotate-admin-seat.js removed it from the
 * multisig. 2026-10-09, task rotate-mainnet-admin-key.
 *
 * ONE system transaction, signed by BLSBw8 alone (its own funds; this is the
 * only thing it ever signs again):
 *   [optional] transfer <fund SOL> to --fund=<pubkey>:<sol>
 *   transfer the remainder            to --rest=<pubkey>
 * fee-aware, so BLSBw8 ends at exactly 0 (--leave=zero) or at the chain's
 * rent-exempt minimum for an empty account (--leave=rent).
 *
 * SOL ONLY. SPL token accounts owned by BLSBw8 are listed, never moved: a
 * token sweep is a separate decision and a separate transaction.
 *
 * DRY RUN BY DEFAULT: the unsigned transaction is SIMULATED (sigVerify off),
 * so a dry run loads no key material at all. --send arms it.
 *
 * Destinations are allow-listed (the governance seat, the cluster's Squads
 * vault, the operator's wallets); anything else is refused as a likely typo.
 *
 *   node scripts/ceremony/sweep-admin-seat.js --cluster=mainnet \
 *     --fund=4bKNSqkrKeggSyrds16Ak7rcB4ibvGJ4ZLsKjvQgC3Vk:0.1 \
 *     --rest=Bk9sS7iiSRL18vuo2KVzkeGw7EekKqxMCjrdoyGGdJm --leave=zero [--send]
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
const bs58m = require("bs58");
const { execFileSync } = require("child_process");

const { MEMBER_NAMES, memberName, resolveCluster, seatSecretSource } = require("../lib/squad-clusters");
const { NEW_SEAT, OLD_SEAT } = require("../lib/admin-seat-rotation");

const bs58 = bs58m.default || bs58m;
const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];
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
const leave = value("--leave");
if (!["zero", "rent"].includes(leave)) fail("--leave=zero|rent is required (close to 0, or keep the rent-exempt minimum).", 2);
const restArg = value("--rest");
if (!restArg) fail("--rest=<pubkey> is required.", 2);

const operators = Object.keys(MEMBER_NAMES).filter((k) => /\(operator\)/.test(MEMBER_NAMES[k]));
const ALLOWED = new Set([NEW_SEAT, cfg.vaultPda, ...operators]);
function dest(pk, flag) {
  let key;
  try {
    key = new PublicKey(pk);
  } catch (_) {
    fail(`${flag} ${pk} is not a public key.`, 2);
  }
  if (!ALLOWED.has(key.toBase58())) fail(`${flag} ${pk} is not an allowed destination (governance seat, ${cfg.cluster} Squads vault, operator wallets).`, 2);
  return key;
}
const rest = dest(restArg, "--rest");
let fund = null;
if (value("--fund")) {
  const [pk, sol] = value("--fund").split(":");
  const lamports = Math.round(Number(sol) * LAMPORTS_PER_SOL);
  if (!Number.isFinite(lamports) || lamports <= 0) fail("--fund=<pubkey>:<sol> needs a positive SOL amount.", 2);
  fund = { to: dest(pk, "--fund"), lamports };
  if (fund.to.equals(rest)) fail("--fund and --rest name the same account; use --rest alone.", 2);
}
const sol = (l) => (l / LAMPORTS_PER_SOL).toFixed(9);

function buildTx(fromKey, restLamports, blockhash) {
  const tx = new Transaction({ feePayer: fromKey, recentBlockhash: blockhash });
  if (fund) tx.add(SystemProgram.transfer({ fromPubkey: fromKey, toPubkey: fund.to, lamports: fund.lamports }));
  tx.add(SystemProgram.transfer({ fromPubkey: fromKey, toPubkey: rest, lamports: restLamports }));
  return tx;
}

async function plan(conn) {
  const from = new PublicKey(OLD_SEAT);
  const info = await conn.getAccountInfo(from, "confirmed");
  if (!info) fail(`${OLD_SEAT} has no account on ${cfg.cluster} — nothing to sweep.`);
  if (!info.owner.equals(SystemProgram.programId) || info.data.length) fail(`${OLD_SEAT} is not a plain system account.`);
  const rentMin = await conn.getMinimumBalanceForRentExemption(0, "confirmed");
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const fee = (await conn.getFeeForMessage(buildTx(from, 1, blockhash).compileMessage(), "confirmed")).value;
  if (fee == null) fail("the RPC returned no fee for the message.");
  const keep = leave === "rent" ? rentMin : 0;
  const restLamports = info.lamports - fee - keep - (fund ? fund.lamports : 0);
  if (restLamports <= 0) fail(`balance ${sol(info.lamports)} SOL cannot cover fund + fee + keep.`);
  for (const [to, amt] of [...(fund ? [[fund.to, fund.lamports]] : []), [rest, restLamports]]) {
    const cur = await conn.getBalance(to, "confirmed");
    if (cur + amt < rentMin) fail(`${to.toBase58()} would hold ${sol(cur + amt)} SOL, under rent-exempt ${sol(rentMin)}.`);
  }
  return { from, balance: info.lamports, rentMin, fee, keep, restLamports, blockhash };
}

(async () => {
  const conn = new Connection(cfg.rpcUrl, "confirmed");
  const gen = await conn.getGenesisHash();
  if (gen !== cfg.genesisHash) fail(`${cfg.cluster} genesis mismatch (got ${gen}).`, 2);

  const p = await plan(conn);
  console.log(`\n${cfg.cluster.toUpperCase()}  sweep ${OLD_SEAT}  ${SEND ? "ARMED (--send)" : "dry run (simulated, no key loaded)"}`);
  console.log(`  balance            ${sol(p.balance)} SOL`);
  if (fund) console.log(`  -> ${fund.to.toBase58()}  ${sol(fund.lamports)} SOL  (${memberName(fund.to.toBase58()) === "unrecognised" ? "Squads vault" : memberName(fund.to.toBase58())})`);
  const restName = rest.toBase58() === cfg.vaultPda ? `${cfg.cluster} Squads vault` : memberName(rest.toBase58());
  console.log(`  -> ${rest.toBase58()}  ${sol(p.restLamports)} SOL  (${restName})`);
  console.log(`  network fee        ${sol(p.fee)} SOL`);
  console.log(`  left on BLSBw8     ${sol(p.keep)} SOL  (--leave=${leave}; rent-exempt minimum reads ${sol(p.rentMin)})`);

  for (const prog of TOKEN_PROGRAMS) {
    const t = await conn.getParsedTokenAccountsByOwner(p.from, { programId: new PublicKey(prog) });
    t.value.forEach((x) => {
      const i = x.account.data.parsed.info;
      console.log(`  NOT MOVED: token account ${x.pubkey.toBase58()} mint ${i.mint} amount ${i.tokenAmount.uiAmountString}`);
    });
  }

  if (!SEND) {
    // Unsigned, sigVerify off: the simulation needs no key.
    const vtx = new VersionedTransaction(buildTx(p.from, p.restLamports, p.blockhash).compileMessage());
    const result = (
      await conn.simulateTransaction(vtx, {
        sigVerify: false,
        replaceRecentBlockhash: true,
        accounts: { addresses: [OLD_SEAT], encoding: "base64" },
      })
    ).value;
    if (result.err) fail(`simulation failed: ${JSON.stringify(result.err)}\n${(result.logs || []).join("\n")}`);
    const after = result.accounts && result.accounts[0] ? result.accounts[0].lamports : "(not returned)";
    console.log(`  simulation OK; BLSBw8 would hold ${after === "(not returned)" ? after : sol(after) + " SOL"} after`);
    console.log("\n  DRY RUN — nothing signed or sent. Re-run with --send.\n");
    return;
  }

  const spec = seatSecretSource(OLD_ITEM);
  const raw = execFileSync("op", ["read", spec.ref], { encoding: "utf8", env: spec.childEnv, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const secret = raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw);
  const kp = Keypair.fromSecretKey(secret);
  if (kp.publicKey.toBase58() !== OLD_SEAT) fail(`${spec.ref} does not derive to ${OLD_SEAT}.`);
  const fresh = await plan(conn); // re-read: the balance may have moved since the printout
  const tx = buildTx(fresh.from, fresh.restLamports, fresh.blockhash);
  tx.sign(kp);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction({ signature: sig, blockhash: fresh.blockhash, lastValidBlockHeight: (await conn.getLatestBlockhash()).lastValidBlockHeight }, "finalized");
  console.log(`  sent ${sig}`);
  const fin = new Connection(cfg.rpcUrl, "finalized");
  console.log(`  BLSBw8 now ${sol(await fin.getBalance(fresh.from))} SOL`);
  if (fund) console.log(`  ${fund.to.toBase58()} now ${sol(await fin.getBalance(fund.to))} SOL`);
  console.log(`  ${rest.toBase58()} now ${sol(await fin.getBalance(rest))} SOL\n`);
})().catch((e) => {
  console.error("\nFAILED:", e.message);
  process.exit(1);
});
