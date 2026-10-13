const test=require('node:test');const assert=require('node:assert/strict');
const {Keypair}=require('@solana/web3.js');
const {createExecutor,DEVNET_GENESIS}=require('./executor.cjs');
const {createDemoServer}=require('./server.cjs');
test('local HTTP demo refuses cross-origin proposals and serves only public policy state',async t=>{
  const wallet=Keypair.generate(),recipient=Keypair.generate().publicKey;
  const chain={genesis:async()=>DEVNET_GENESIS,balance:async()=>0};
  const executor=createExecutor({wallet,recipient,chain,decide:async()=>({})});
  const server=createDemoServer({executor,chain});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const refused=await fetch(base+'/api/prepare',{method:'POST',headers:{'content-type':'application/json','Origin':'https://attacker.example','x-demo-intent':'devnet-only'},body:'{}'});
  assert.equal(refused.status,403);
  const state=await (await fetch(base+'/api/state')).json();
  assert.equal(state.policy.cluster,'devnet');assert.equal(state.balanceLamports,0);
  assert.equal(JSON.stringify(state).includes('secretKey'),false);
});
