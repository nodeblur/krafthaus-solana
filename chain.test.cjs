const test=require('node:test');const assert=require('node:assert/strict');
const {createDevnetChain,DEVNET_RPC}=require('./chain.cjs');
test('simulation uses only the fixed devnet endpoint and preserves exact signed bytes and blockhash',async()=>{
  let observed;
  const chain=createDevnetChain({fetchImpl:async(url,options)=>{observed={url,body:JSON.parse(options.body)};return{ok:true,json:async()=>({result:{value:{err:null}}})}}});
  await chain.simulate(Buffer.from('signed-wire'));
  assert.equal(observed.url,DEVNET_RPC);
  assert.deepEqual(observed.body.params,['c2lnbmVkLXdpcmU=',{encoding:'base64',sigVerify:true,replaceRecentBlockhash:false,commitment:'confirmed'}]);
});
