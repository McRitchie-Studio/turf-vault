#!/usr/bin/env node
/**
 * ONE-OFF CEREMONY — Squads V4 membership + threshold change.
 *
 * Seats Mr. McRitchie's three personal wallets plus the agent admin key, retires
 * the two agent-reachable legacy signers, and raises the threshold 2 -> 3.
 * ONE atomic config transaction: if any action is invalid, none apply.
 *
 * DRY RUN BY DEFAULT. --send arms it. --cluster is REQUIRED (no default: a
 * convenient default is how a ceremony step hits the wrong chain).
 */
const { Connection, Keypair, PublicKey } = require("@solana/web3.js");
const multisig = require("@sqds/multisig");
const bs58 = require("bs58");
const { execFileSync } = require("child_process");

const CLUSTERS = {
  devnet:  { url: "https://api.devnet.solana.com",       ms: "7nRuVw3VZFC6z85tYVDitPnaUHZCkqLpJRSTBNtPmtZB",
             genesis: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" },
  mainnet: { url: "https://api.mainnet-beta.solana.com", ms: "4H3fP3otjMtupk1DQDjKXYY1dWjT6LNM4H4ZWZ1XcKSX",
             genesis: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" },
};
const ADD    = [["admin BLSBw8","BLSBw8fXHzZc5pbaYCKMpMSsrtXBTbWXpUPVzMrXx9oo"],
                ["Alex two 3Qj4v9","3Qj4v9qjhXgkru6zCRCErRVhy8Q6qU3NrNpvpXLTZboA"],
                ["Alex three 9gACbz","9gACbzsCLmkYF9Yx1EBGmwMvvyfuTquJ6qs8QsoQvHXf"]];
const REMOVE = [["Xan 8K81","8K81w4e6UcB7TiANhM9N8sAgijJvTxxybRi8AENRaRYd"],
                ["Mason CytJ","CytJS23p1zCM2wvUUngiDePtbMB484ebD7bK4nDqWjrR"]];
const NEW_THRESHOLD = 3;
const KEEP = "7ZDJp7FUHhuceAqcW9CHe81hCiaMTjgWAXfprBM59Tcr"; // Alex Phantom, already seated

const args = process.argv.slice(2);
const SEND = args.includes("--send");
const cluster = (args.find(a => a.startsWith("--cluster=")) || "").split("=")[1];
if (!CLUSTERS[cluster]) { console.error("REFUSED: --cluster=devnet|mainnet is required (no default)."); process.exit(2); }
const C = CLUSTERS[cluster];

function opRead(item, field) {
  return execFileSync("op", ["read", `op://studio-agents/${item}/${field}`], { encoding: "utf8" }).trim();
}
function kp(raw) {
  raw = raw.trim();
  let sk = null;
  if (raw.startsWith("[")) sk = Uint8Array.from(JSON.parse(raw));
  else { const b = (bs58.default || bs58).decode(raw); if (b.length === 64) sk = b; }
  if (!sk) throw new Error("unparseable key material");
  return Keypair.fromSecretKey(sk);
}

(async () => {
  const conn = new Connection(C.url, "confirmed");
  const gen = await conn.getGenesisHash();
  if (gen !== C.genesis) { console.error(`REFUSED: ${cluster} genesis mismatch (got ${gen}).`); process.exit(2); }

  const msPda = new PublicKey(C.ms);
  const before = await multisig.accounts.Multisig.fromAccountAddress(conn, msPda);
  const cur = before.members.map(m => m.key.toBase58());

  console.log(`\n${cluster.toUpperCase()}  multisig ${C.ms.slice(0,8)}…   genesis OK`);
  console.log(`  BEFORE: threshold ${before.threshold} of ${cur.length}`);
  cur.forEach(k => console.log(`    ${k}`));

  // ---- validate the plan against live state before building anything ----
  const problems = [];
  for (const [n,a] of ADD)    if (cur.includes(a)) problems.push(`${n} is ALREADY a member — add would fail`);
  for (const [n,a] of REMOVE) if (!cur.includes(a)) problems.push(`${n} is NOT a member — remove would fail`);
  if (!cur.includes(KEEP)) problems.push(`Alex Phantom ${KEEP.slice(0,8)}… is NOT seated — refusing`);
  const finalCount = cur.length + ADD.length - REMOVE.length;
  if (NEW_THRESHOLD > finalCount) problems.push(`threshold ${NEW_THRESHOLD} exceeds final member count ${finalCount}`);
  if (problems.length) { console.error("\nREFUSED — plan does not match live state:"); problems.forEach(p=>console.error("  - "+p)); process.exit(1); }

  console.log(`\n  PLAN (one atomic config transaction, applied in order):`);
  ADD.forEach(([n,a]) => console.log(`    + add    ${n.padEnd(20)} ${a}  mask 7`));
  REMOVE.forEach(([n,a]) => console.log(`    - remove ${n.padEnd(20)} ${a}`));
  console.log(`    ~ threshold ${before.threshold} -> ${NEW_THRESHOLD}`);
  console.log(`\n  AFTER (predicted): threshold ${NEW_THRESHOLD} of ${finalCount}`);
  [...cur.filter(k => !REMOVE.some(([,a])=>a===k)), ...ADD.map(([,a])=>a)].forEach(k => console.log(`    ${k}`));

  if (!SEND) { console.log(`\n  DRY RUN — nothing sent. Re-run with --send to execute.\n`); return; }

  const xan   = kp(opRead("agent.xan.solana", "private key"));
  const mason = kp(opRead("agent.mason.solana", "private key"));
  if (xan.publicKey.toBase58() !== REMOVE[0][1] || mason.publicKey.toBase58() !== REMOVE[1][1])
    { console.error("REFUSED: signer keys do not derive to the expected members."); process.exit(1); }

  const actions = [
    ...ADD.map(([,a]) => ({ __kind: "AddMember", newMember: { key: new PublicKey(a), permissions: multisig.types.Permissions.all() } })),
    ...REMOVE.map(([,a]) => ({ __kind: "RemoveMember", oldMember: new PublicKey(a) })),
    { __kind: "ChangeThreshold", newThreshold: NEW_THRESHOLD },
  ];
  const transactionIndex = BigInt(Number(before.transactionIndex) + 1);
  const common = { connection: conn, multisigPda: msPda, transactionIndex, sendOptions: { skipPreflight: false } };

  console.log(`\n  sending… transactionIndex ${transactionIndex}`);
  let sig = await multisig.rpc.configTransactionCreate({ ...common, creator: xan.publicKey, rentPayer: xan.publicKey, feePayer: xan, actions, memo: "seat operator wallets; retire agent signers; threshold 3" });
  console.log(`   1/5 configTransactionCreate  ${sig.slice(0,20)}…`);
  sig = await multisig.rpc.proposalCreate({ ...common, creator: xan, feePayer: xan });
  console.log(`   2/5 proposalCreate           ${sig.slice(0,20)}…`);
  sig = await multisig.rpc.proposalApprove({ ...common, member: xan, feePayer: xan });
  console.log(`   3/5 approve (Xan)            ${sig.slice(0,20)}…`);
  sig = await multisig.rpc.proposalApprove({ ...common, member: mason, feePayer: mason });
  console.log(`   4/5 approve (Mason)          ${sig.slice(0,20)}…`);
  sig = await multisig.rpc.configTransactionExecute({ ...common, member: xan, feePayer: xan, rentPayer: xan });
  console.log(`   5/5 execute                  ${sig.slice(0,20)}…`);

  const after = await multisig.accounts.Multisig.fromAccountAddress(conn, msPda);
  console.log(`\n  AFTER (read back): threshold ${after.threshold} of ${after.members.length}`);
  after.members.forEach(m => console.log(`    mask ${m.permissions.mask}  ${m.key.toBase58()}`));
})().catch(e => { console.error("\nFAILED:", e.message); process.exit(1); });
