import {Connection,PublicKey} from "@solana/web3.js";
const M=new Connection("https://api.mainnet-beta.solana.com","confirmed");
const CLMM="CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const PUMPT="pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
const WSOL="So11111111111111111111111111111111111111112";
const TOKP=["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA","TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];
let pools=[];
for(const [a,b] of [[73,105],[105,73]]){
  const accs=await M.getProgramAccounts(new PublicKey(CLMM),{filters:[
    {memcmp:{offset:a,bytes:PUMPT}},{memcmp:{offset:b,bytes:WSOL}}],dataSlice:{offset:0,length:0}});
  pools.push(...accs.map(x=>x.pubkey));
  await new Promise(r=>setTimeout(r,600));
}
pools=[...new Map(pools.map(p=>[p.toBase58(),p])).values()];
console.log("$PUMP/WSOL Raydium CLMM pools:",pools.length);
let best=null;
for(const p of pools){
  const ai=await M.getAccountInfo(p); await new Promise(r=>setTimeout(r,250));
  const d=ai.data;
  const m0=new PublicKey(d.subarray(73,105)).toBase58();
  const v0=new PublicKey(d.subarray(137,169)), v1=new PublicKey(d.subarray(169,201));
  const dec0=d[233],dec1=d[234];
  const sq=d.readBigUInt64LE(253)+(d.readBigUInt64LE(261)<<64n);
  const infos=await M.getMultipleAccountsInfo([v0,v1]); await new Promise(r=>setTimeout(r,250));
  let sol=0,tok=0,ok=true;
  for(const inf of infos){
    if(!inf||!TOKP.includes(inf.owner.toBase58())||inf.data.length<72){ok=false;break;}
    const m=new PublicKey(inf.data.subarray(0,32)).toBase58();
    const amt=Number(inf.data.readBigUInt64LE(64));
    if(m===WSOL) sol=amt; else if(m===PUMPT) tok=amt; else ok=false;
  }
  const sqf=Number(sq)/2**64, price=sqf*sqf;
  const solIs0=m0===WSOL;
  const tps= solIs0 ? price*10**(dec0-dec1) : (1/price)*10**(dec1-dec0);
  console.log(`  ${p.toBase58().slice(0,14)} readable=${ok} wsolVault=${(sol/1e9).toFixed(1)} SOL pumpVault=${(tok/1e6).toFixed(0)} tokensPerSOL=${tps.toExponential(4)}`);
  if(ok&&(!best||sol>best.sol)) best={p:p.toBase58(),sol,tps};
}
if(best){
  const r=await fetch(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${WSOL}&outputMint=${PUMPT}&amount=1000000000&slippageBps=300&instructionVersion=V2`);
  const j=await r.json();
  const jtps=Number(j.outAmount)/1e6;
  console.log(`\nbest pool ${best.p.slice(0,14)} depth ${(best.sol/1e9).toFixed(1)} SOL`);
  console.log(`  sqrtPrice tokens/SOL = ${best.tps.toExponential(5)}   jupiter = ${jtps.toExponential(5)}   err = ${(100*(jtps-best.tps)/best.tps).toFixed(3)}%`);
}
