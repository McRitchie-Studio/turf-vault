#!/usr/bin/env node
/**
 * Resume a Squads V4 config transaction that was created but not executed.
 * Verifies the ON-CHAIN actions match the expected plan BEFORE approving —
 * never approve a config transaction you have not read back yourself.
 * --index is required. Dry run unless --send.
 */
const { Connection, Keypair, PublicKey } = require("@solana/web3.js");
const multisig = require("@sqds/multisig");
const bs58 = require("bs58");
const { execFileSync } = require("child_process");

const CL = { devnet:{url:"https://api.devnet.solana.com",ms:"7nRuVw3VZFC6z85tYVDitPnaUHZCkqLpJRSTBNtPmtZB",gen:"EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"},
             mainnet:{url:"https://api.mainnet-beta.solana.com",ms:"4H3fP3otjMtupk1DQDjKXYY1dWjT6LNM4H4ZWZ1XcKSX",gen:"5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"} };
const EXPECT_ADD    = ["BLSBw8fXHzZc5pbaYCKMpMSsrtXBTbWXpUPVzMrXx9oo","3Qj4v9qjhXgkru6zCRCErRVhy8Q6qU3NrNpvpXLTZboA","9gACbzsCLmkYF9Yx1EBGmwMvvyfuTquJ6qs8QsoQvHXf"];
const EXPECT_REMOVE = ["8K81w4e6UcB7TiANhM9N8sAgijJvTxxybRi8AENRaRYd","CytJS23p1zCM2wvUUngiDePtbMB484ebD7bK4nDqWjrR"];
const EXPECT_THRESHOLD = 3;

const a = process.argv.slice(2);
const SEND = a.includes("--send");
const cluster = (a.find(x=>x.startsWith("--cluster="))||"").split("=")[1];
const index = Number((a.find(x=>x.startsWith("--index="))||"").split("=")[1]);
if (!CL[cluster]) { console.error("REFUSED: --cluster=devnet|mainnet required."); process.exit(2); }
if (!Number.isInteger(index) || index < 1) { console.error("REFUSED: --index=<n> required."); process.exit(2); }
const C = CL[cluster];

// Poll until a condition holds. Devnet showed each step racing the next: the
// account or status is not yet visible to the node when the following call builds.
async function settle(label, fn, tries=20){
  for(let i=0;i<tries;i++){ try{ if(await fn()) return; }catch(e){}
    await new Promise(r=>setTimeout(r,1000)); }
  throw new Error(`timed out waiting for ${label}`);
}
const opRead=(i,f)=>execFileSync("op",["read",`op://studio-agents/${i}/${f}`],{encoding:"utf8"}).trim();
function kp(raw){raw=raw.trim();let sk=null;
  if(raw.startsWith("[")) sk=Uint8Array.from(JSON.parse(raw));
  else {const b=(bs58.default||bs58).decode(raw); if(b.length===64) sk=b;}
  if(!sk) throw new Error("unparseable key"); return Keypair.fromSecretKey(sk);}

(async()=>{
  const conn=new Connection(C.url,"confirmed");
  if((await conn.getGenesisHash())!==C.gen){console.error("REFUSED: genesis mismatch");process.exit(2);}
  const msPda=new PublicKey(C.ms);
  const ms=await multisig.accounts.Multisig.fromAccountAddress(conn,msPda);
  const ti=BigInt(index);
  const [txPda]=multisig.getTransactionPda({multisigPda:msPda,index:ti});
  const [pPda]=multisig.getProposalPda({multisigPda:msPda,transactionIndex:ti});

  const txInfo=await conn.getAccountInfo(txPda);
  if(!txInfo){console.error(`REFUSED: no config transaction at index ${index}.`);process.exit(1);}
  const ctx=await multisig.accounts.ConfigTransaction.fromAccountAddress(conn,txPda);

  // ---- verify the ON-CHAIN actions are exactly the expected plan ----
  const adds=[],rems=[]; let thr=null, other=0;
  for(const ac of ctx.actions){
    // solita puts the variant payload directly on the object, NOT under .fields
    if(ac.__kind==="AddMember") adds.push(ac.newMember.key.toBase58());
    else if(ac.__kind==="RemoveMember") rems.push(ac.oldMember.toBase58());
    else if(ac.__kind==="ChangeThreshold") thr=ac.newThreshold;
    else other++;
  }
  const same=(x,y)=>x.length===y.length&&x.every(v=>y.includes(v));
  console.log(`\n${cluster.toUpperCase()} index ${index} — on-chain actions read back:`);
  adds.forEach(k=>console.log(`    + add    ${k}`));
  rems.forEach(k=>console.log(`    - remove ${k}`));
  console.log(`    ~ threshold -> ${thr}`);
  const bad=[];
  if(!same(adds,EXPECT_ADD)) bad.push("AddMember set does not match the plan");
  if(!same(rems,EXPECT_REMOVE)) bad.push("RemoveMember set does not match the plan");
  if(thr!==EXPECT_THRESHOLD) bad.push(`threshold ${thr} != expected ${EXPECT_THRESHOLD}`);
  if(other) bad.push(`${other} unexpected action kind(s) present`);
  if(bad.length){console.error("\nREFUSED — on-chain actions differ from the plan:");bad.forEach(b=>console.error("  - "+b));process.exit(1);}
  console.log("  ✓ on-chain actions match the expected plan exactly");

  const prInfo=await conn.getAccountInfo(pPda);
  let status="(none)",approved=[];
  if(prInfo){const p=await multisig.accounts.Proposal.fromAccountAddress(conn,pPda);
    status=p.status.__kind; approved=p.approved.map(k=>k.toBase58());}
  console.log(`  proposal: ${status}   approvals: ${approved.length}/${ms.threshold}`);
  if(!SEND){console.log("\n  DRY RUN — nothing sent. Re-run with --send.\n");return;}

  const xan=kp(opRead("agent.xan.solana","private key"));
  const mason=kp(opRead("agent.mason.solana","private key"));
  const common={connection:conn,multisigPda:msPda,transactionIndex:ti};

  if(!prInfo){
    const s=await multisig.rpc.proposalCreate({...common,creator:xan,feePayer:xan});
    console.log(`   proposalCreate   ${s.slice(0,20)}…`);
    await settle("proposal account", async()=> !!(await conn.getAccountInfo(pPda)));
  }
  for(const [n,signer] of [["Xan",xan],["Mason",mason]]){
    if(approved.includes(signer.publicKey.toBase58())){console.log(`   approve (${n}) — already approved, skipped`);continue;}
    const s=await multisig.rpc.proposalApprove({...common,member:signer,feePayer:signer});
    console.log(`   approve (${n})    ${s.slice(0,20)}…`);
    await settle(`${n}'s approval to register`, async()=>{
      const p=await multisig.accounts.Proposal.fromAccountAddress(conn,pPda);
      return p.approved.map(k=>k.toBase58()).includes(signer.publicKey.toBase58());});
  }
  await settle("proposal to reach Approved", async()=>{
    const p=await multisig.accounts.Proposal.fromAccountAddress(conn,pPda);
    return p.status.__kind==="Approved";});
  const s=await multisig.rpc.configTransactionExecute({...common,member:xan,feePayer:xan,rentPayer:xan});
  console.log(`   execute          ${s.slice(0,20)}…`);

  await settle("config change to apply", async()=>{
    const a=await multisig.accounts.Multisig.fromAccountAddress(
      new Connection(C.url,"finalized"),msPda);
    return a.threshold===EXPECT_THRESHOLD;});
  const after=await multisig.accounts.Multisig.fromAccountAddress(
    new Connection(C.url,"finalized"),msPda);
  console.log(`\n  AFTER (read back): threshold ${after.threshold} of ${after.members.length}`);
  after.members.forEach(m=>console.log(`    mask ${m.permissions.mask}  ${m.key.toBase58()}`));
})().catch(e=>{console.error("\nFAILED:",e.message);process.exit(1);});
