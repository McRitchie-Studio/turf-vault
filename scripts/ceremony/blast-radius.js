const {Connection,PublicKey}=require("@solana/web3.js");
const multisig=require("@sqds/multisig");
const BPF=new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const N={"8K81w4e6UcB7TiANhM9N8sAgijJvTxxybRi8AENRaRYd":"Xan","7ZDJp7FUHhuceAqcW9CHe81hCiaMTjgWAXfprBM59Tcr":"Alex Phantom","CytJS23p1zCM2wvUUngiDePtbMB484ebD7bK4nDqWjrR":"Mason"};
(async()=>{
 const c=new Connection("https://api.devnet.solana.com","finalized");
 const MS=new PublicKey("7nRuVw3VZFC6z85tYVDitPnaUHZCkqLpJRSTBNtPmtZB");
 const PROG=new PublicKey("EQGFJAcABtDb6VXtiijTjZ6cE2UqdvhnqJvoharJbpMJ");
 const VAULT=new PublicKey("J7b5g9uS5M2Nog1Ly1UATXTDMtXdpXK3JffRAHXGHkK2");

 console.log("DEVNET — after the membership change that already ran\n");
 const [v]=multisig.getVaultPda({multisigPda:MS,index:0});
 console.log("  Squads vault PDA (index 0):", v.toBase58());
 console.log("    expected BW13kgfi… ->", v.toBase58()==="BW13kgfiG2koFn3WRkte21NW9TFygsD1ge2fNJdjH6kC" ? "UNCHANGED ✓" : "CHANGED ✗");

 const [pd]=PublicKey.findProgramAddressSync([PROG.toBuffer()],BPF);
 const d=(await c.getAccountInfo(pd)).data;
 const auth=new PublicKey(d.slice(13,45)).toBase58();
 console.log("  program upgrade authority:", auth);
 console.log("    still the Squads vault ->", auth===v.toBase58() ? "YES ✓" : "NO ✗");

 const vs=(await c.getAccountInfo(VAULT)).data;
 let o=8; const pk=()=>{const k=new PublicKey(vs.subarray(o,o+32)).toBase58();o+=32;return k;};
 const s=[pk(),pk(),pk()]; const thr=vs[o];
 console.log("\n  turf_vault VaultState.signers — the set the APP checks:");
 s.forEach((k,i)=>console.log(`    signer[${i}]  ${(N[k]||k).padEnd(14)} ${k.slice(0,8)}…`));
 console.log(`    threshold: ${thr}`);
 console.log("    untouched by the Squads change ->", (s[0].startsWith("8K81")&&s[2].startsWith("CytJ")&&thr===2) ? "YES ✓" : "CHANGED ✗");
})().catch(e=>console.log("err",e.message));
