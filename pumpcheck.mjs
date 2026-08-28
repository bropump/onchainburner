import {Connection,PublicKey} from "@solana/web3.js";
const M=new Connection("https://api.mainnet-beta.solana.com","confirmed");
const PUMPT="pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
const WSOL="So11111111111111111111111111111111111111112";
const TOKP=["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA","TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];
const VEN=[["Raydium v4","675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",[400,432],[336,368]],
           ["Raydium CP","CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",[168,200],[72,104]]];
for(const [name,pid,mintOffs,vaultOffs] of VEN){
  let pools=[];
  for(const [a,b] of [[mintOffs[0],mintOffs[1]],[mintOffs[1],mintOffs[0]]]){
    try{
      const accs=await M.getProgramAccounts(new PublicKey(pid),{filters:[
        {memcmp:{offset:a,bytes:PUMPT}},{memcmp:{offset:b,bytes:WSOL}}],dataSlice:{offset:0,length:0}});
      pools.push(...accs.map(x=>x.pubkey));
    }catch(e){console.log(name,"query err",String(e).slice(0,60));}
    await new Promise(r=>setTimeout(r,600));
  }
  pools=[...new Map(pools.map(p=>[p.toBase58(),p])).values()];
  console.log(`${name}: ${pools.length} $PUMP/WSOL pool(s)`);
  for(const p of pools.slice(0,6)){
    const ai=await M.getAccountInfo(p); await new Promise(r=>setTimeout(r,250));
    if(!ai) continue;
    const A=new PublicKey(ai.data.subarray(vaultOffs[0],vaultOffs[0]+32));
    const B=new PublicKey(ai.data.subarray(vaultOffs[1],vaultOffs[1]+32));
    const infos=await M.getMultipleAccountsInfo([A,B]); await new Promise(r=>setTimeout(r,250));
    let sol=0,tok=0,ok=true;
    for(const inf of infos){
      if(!inf||!TOKP.includes(inf.owner.toBase58())||inf.data.length<72){ok=false;break;}
      const m=new PublicKey(inf.data.subarray(0,32)).toBase58();
      const amt=Number(inf.data.readBigUInt64LE(64));
      if(m===WSOL) sol=amt; else if(m===PUMPT) tok=amt; else ok=false;
    }
    console.log(`   ${p.toBase58().slice(0,14)} readable=${ok} wsol=${(sol/1e9).toFixed(1)} SOL pump=${(tok/1e6).toFixed(0)}`);
  }
}
