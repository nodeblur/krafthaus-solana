const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require.resolve('./app.js'),'utf8');
const id='ab337e8a-3d9b-4889-b9e0-e17b85767738';
async function load(search,receipt){
  const elements=new Map(),requests=[];
  const element=()=>({textContent:'',dataset:{},disabled:false,hidden:true,addEventListener(){},replaceChildren(){}});
  const get=key=>{if(!elements.has(key))elements.set(key,element());return elements.get(key)};
  get('explorer');
  const state={policy:{sender:'test-sender',recipient:'test-recipient'},balanceLamports:5000000,funding:{status:'unavailable'}};
  vm.runInNewContext(source,{
    document:{getElementById:get,createElement:element,addEventListener(){}},
    window:{location:{search},addEventListener(){}},URLSearchParams,Date,setInterval(){},
    fetch:async(path,options)=>{requests.push({path,options});return {ok:true,json:async()=>path==='/api/state'?state:receipt}},
  });
  await new Promise(resolve=>setImmediate(resolve));
  return {elements,requests};
}
test('receipt link reopens actual confirmation read-only without a new transfer',async()=>{
  const result=await load('?approval='+id,{id,status:'confirmed',decision:{decision_id:'dec_actual'},messageHash:'hash',signature:'public-signature',proof:{slot:123,recipientDeltaLamports:1000000,feeLamports:5000,explorerUrl:'https://explorer.solana.com/tx/public-signature?cluster=devnet'}});
  assert.equal(result.elements.get('approval-status').textContent,'CONFIRMED');
  assert.match(result.elements.get('proof-status').textContent,/Confirmed at slot 123/);
  assert.equal(result.elements.get('execute').disabled,true);
  assert.equal(result.elements.get('explorer').hidden,false);
  assert.equal(result.requests.length,2);
  assert.equal(result.requests.every(r=>!r.options?.method||r.options.method==='GET'),true);
});
test('receipt lookup never grants signing authority even for an unexpired approval',async()=>{
  const result=await load('?approval='+id,{id,status:'approved',expiresAt:Date.now()+60000,decision:{decision_id:'dec_existing'},messageHash:'hash'});
  assert.equal(result.elements.get('approval-status').textContent,'APPROVED');
  for(const key of ['execute','tamper-recipient','tamper-amount'])assert.equal(result.elements.get(key).disabled,true);
  assert.equal(result.elements.get('explorer').hidden,true);
});
test('invalid or missing receipt does not display fabricated confirmation',async()=>{
  const invalid=await load('?approval=invalid',{});
  assert.equal(invalid.requests.length,1);
  assert.match(invalid.elements.get('notice').textContent,/INVALID_RECEIPT_ID/);
  const missing=await load('?approval='+id,{status:'refused',code:'APPROVAL_NOT_FOUND'});
  assert.match(missing.elements.get('notice').textContent,/APPROVAL_NOT_FOUND/);
  assert.equal(missing.elements.get('explorer').hidden,true);
});
