#!/usr/bin/env node
/**
 * Add the system wallet as a Squads seat, bringing the multisig to five —
 * matching the VaultState signer list exactly so the two stop diverging.
 * Creates + proposes + approves with the ONE seat the agent holds.
 * --cluster REQUIRED, no default. Dry run unless --send.
 */
const {Connection,Keypair,PublicKey}=require("@solana/web3.js");
const multisig=require("@sqds/multisig");
const bs58=require("bs58");
const {execFileSync}=require("child_process");

const CL={
 mainnet:{url:"https://api.mainnet-beta.solana.com",ms:"4H3fP3otjMtupk1DQDjKXYY1dWjT6LNM4H4ZWZ1XcKSX",
   gen:"5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
   add:[["system","7auwTLSvNniSUeAgL6v9RStMXJhWrrUhSJgwFWLpcqC"]]},
 devnet:{url:"https://api.devnet.solana.com",ms:"7nRuVw3VZFC6z85tYVDitPnaUHZCkqLpJRSTBNtPmtZB",
   gen:"EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
   add:[["system.devnet","2eGs8G3wzhEeNQQU2Q86BmmA2xTpDbMMae3Y1bvpZfx9"],["Xan","8K81w4e6UcB7TiANhM9N8sAgijJvTxxybRi8AENRaRYd"]],
   remove:[["Alex three","9gACbzsCLmkYF9Yx1EBGmwMvvyfuTquJ6qs8QsoQvHXf"]]},
};
const N={"8K81w4e6UcB7TiANhM9N8sAgijJvTxxybRi8AENRaRYd":"Xan (agent)","7ZDJp7FUHhuceAqcW9CHe81hCiaMTjgWAXfprBM59Tcr":"Alex Phantom (you)",
"BLSBw8fXHzZc5pbaYCKMpMSsrtXBTbWXpUPVzMrXx9oo":"admin (agent)","7auwTLSvNniSUeAgL6v9RStMXJhWrrUhSJgwFWLpcqC":"system (agent)",
"2eGs8G3wzhEeNQQU2Q86BmmA2xTpDbMMae3Y1bvpZfx9":"system.devnet (agent)",
"3Qj4v9qjhXgkru6zCRCErRVhy8Q6qU3NrNpvpXLTZboA":"Alex two (you)","9gACbzsCLmkYF9Yx1EBGmwMvvyfuTquJ6qs8QsoQvHXf":"Alex three (you)"};
const nm=k=>N[k]||"unrecognised";
const a=process.argv.slice(2), SEND=a.includes("--send");
const cluster=(a.find(x=>x.startsWith("--cluster="))||"").split("=")[1];
if(!CL[cluster]){console.error("REFUSED: --cluster=mainnet|devnet required (no default).");process.exit(2);}
const C=CL[cluster];
const opRead=(i,f)=>execFileSync("op",["read",`op://studio-agents/${i}/${f}`],{encoding:"utf8"}).trim();
function kp(raw){raw=raw.trim();let sk=null;
  if(raw.startsWith("[")) sk=Uint8Array.from(JSON.parse(raw));
  else {const b=(bs58.default||bs58).decode(raw); if(b.length===64) sk=b;}
  if(!sk) throw new Error("unparseable key"); return Keypair.fromSecretKey(sk);}
async function settle(l,fn,t=20){for(let i=0;i<t;i++){try{if(await fn())return;}catch(e){}
  await new Promise(r=>setTimeout(r,1000));} throw new Error("timed out: "+l);}

(async()=>{
  const conn=new Connection(C.url,"confirmed");
  if((await conn.getGenesisHash())!==C.gen){console.error(`REFUSED: ${cluster} genesis mismatch`);process.exit(2);}
  const MS=new PublicKey(C.ms);
  const ms=await multisig.accounts.Multisig.fromAccountAddress(conn,MS);
  const cur=ms.members.map(m=>m.key.toBase58());
  console.log(`\n${cluster.toUpperCase()}  ${C.ms.slice(0,8)}…   BEFORE: threshold ${ms.threshold} of ${cur.length}`);
  cur.forEach(k=>console.log(`    ${k.slice(0,8)}…  ${nm(k)}`));

  const adds=(C.add||[]).filter(([,k])=>!cur.includes(k));
  const rems=(C.remove||[]).filter(([,k])=>cur.includes(k));
  if(!adds.length&&!rems.length){console.log("\n  nothing to change — already in final form.");return;}
  const final=[...cur.filter(k=>!rems.some(([,r])=>r===k)),...adds.map(([,k])=>k)];
  if(ms.threshold>final.length){console.error("REFUSED: threshold would exceed member count");process.exit(1);}

  console.log(`\n  PLAN (one atomic config transaction):`);
  adds.forEach(([n,k])=>console.log(`    + add    ${n.padEnd(16)} ${k}  mask 7`));
  rems.forEach(([n,k])=>console.log(`    - remove ${n.padEnd(16)} ${k}`));
  console.log(`\n  AFTER: threshold ${ms.threshold} of ${final.length}`);
  final.forEach(k=>console.log(`    ${k.slice(0,8)}…  ${nm(k)}`));
  const agent=final.filter(k=>nm(k).includes("(agent)")).length;
  console.log(`\n  agent reaches ${agent} of ${final.length} vs threshold ${ms.threshold} -> ${agent>=ms.threshold?"⚠ AGENT CAN ACT ALONE":"agent cannot act alone"}`);
  if(!SEND){console.log("\n  DRY RUN — nothing sent.\n");return;}

  const admin=kp(opRead("solana.turf.admin","private-key"));
  if(admin.publicKey.toBase58()!=="BLSBw8fXHzZc5pbaYCKMpMSsrtXBTbWXpUPVzMrXx9oo"){console.error("REFUSED: admin key mismatch");process.exit(1);}
  const ti=BigInt(Number(ms.transactionIndex)+1);
  const common={connection:conn,multisigPda:MS,transactionIndex:ti};
  const [pPda]=multisig.getProposalPda({multisigPda:MS,transactionIndex:ti});
  const actions=[
    ...adds.map(([,k])=>({__kind:"AddMember",newMember:{key:new PublicKey(k),permissions:multisig.types.Permissions.all()}})),
    ...rems.map(([,k])=>({__kind:"RemoveMember",oldMember:new PublicKey(k)})),
  ];
  let s=await multisig.rpc.configTransactionCreate({...common,creator:admin.publicKey,rentPayer:admin.publicKey,feePayer:admin,
    actions,memo:`${cluster}: align Squads seats with the VaultState signer list`});
  console.log(`\n   configTransactionCreate  ${s.slice(0,20)}…  index ${ti}`);
  await settle("tx",async()=>{const [t]=multisig.getTransactionPda({multisigPda:MS,index:ti});return !!(await conn.getAccountInfo(t));});
  s=await multisig.rpc.proposalCreate({...common,creator:admin,feePayer:admin});
  console.log(`   proposalCreate           ${s.slice(0,20)}…`);
  await settle("proposal",async()=>!!(await conn.getAccountInfo(pPda)));
  s=await multisig.rpc.proposalApprove({...common,member:admin,feePayer:admin});
  console.log(`   approve (admin)          ${s.slice(0,20)}…`);
  await settle("approval",async()=>{const p=await multisig.accounts.Proposal.fromAccountAddress(conn,pPda);
    return p.approved.map(k=>k.toBase58()).includes(admin.publicKey.toBase58());});
  const p=await multisig.accounts.Proposal.fromAccountAddress(conn,pPda);
  console.log(`\n  ✓ proposal #${ti} is ${p.status.__kind} — ${p.approved.length}/${ms.threshold} approvals.`);
  console.log(`    NEEDS ${ms.threshold-p.approved.length} MORE from your wallets, then Execute.`);
})().catch(e=>{console.error("\nFAILED:",e.message);process.exit(1);});
