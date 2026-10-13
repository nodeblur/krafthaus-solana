const {DEVNET_GENESIS}=require('./executor.cjs');
const DEVNET_RPC='https://api.devnet.solana.com';
function createDevnetChain({fetchImpl=fetch}={}) {
  let sequence=0;
  async function rpc(method,params=[]) {
    const r=await fetchImpl(DEVNET_RPC,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:++sequence,method,params}),signal:AbortSignal.timeout(12000)});
    if(!r.ok) throw new Error(`DEVNET_HTTP_${r.status}`);
    const body=await r.json();if(body.error) throw new Error(`DEVNET_RPC_${body.error.code}`);
    return body.result;
  }
  return {
    genesis:()=>rpc('getGenesisHash'),
    latest:async()=> (await rpc('getLatestBlockhash',[{commitment:'confirmed'}])).value,
    height:()=>rpc('getBlockHeight',[{commitment:'confirmed'}]),
    balance:async address=>(await rpc('getBalance',[address,{commitment:'confirmed'}])).value,
    simulate:async raw=>(await rpc('simulateTransaction',[Buffer.from(raw).toString('base64'),{encoding:'base64',sigVerify:true,replaceRecentBlockhash:false,commitment:'confirmed'}])).value,
    broadcast:raw=>rpc('sendTransaction',[Buffer.from(raw).toString('base64'),{encoding:'base64',skipPreflight:false,preflightCommitment:'confirmed',maxRetries:0}]),
    transaction:signature=>rpc('getTransaction',[signature,{encoding:'base64',commitment:'confirmed',maxSupportedTransactionVersion:0}]),
    async fund(address) {
      if(await rpc('getGenesisHash')!==DEVNET_GENESIS) throw new Error('DEVNET_REQUIRED');
      return rpc('requestAirdrop',[address,20000000,{commitment:'confirmed'}]);
    },
  };
}
module.exports={createDevnetChain,DEVNET_RPC};
