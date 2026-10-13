const assert=require('node:assert/strict');
const base=process.argv[2];
if(!/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(base||'')) throw Error('Supply only the running local demo URL, e.g. http://127.0.0.1:54899');
const headers={'content-type':'application/json','x-demo-intent':'devnet-only'};
async function request(path,body){const r=await fetch(base+path,body===undefined?{}:{method:'POST',headers,body:JSON.stringify(body)});assert.equal(r.ok,true);return r.json()}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
  const state=await request('/api/state');assert.equal(state.policy.cluster,'devnet');
  const input={recipient:state.policy.recipient,lamports:1000000};
  const over=await request('/api/prepare',{...input,lamports:2000000});assert.equal(over.code,'AMOUNT_OUTSIDE_POLICY');
  const p=await request('/api/prepare',input);assert.equal(p.status,'approved');assert.ok(p.decision.decision_id);
  console.log(JSON.stringify({check:'actual_decide_and_unsigned_transfer',decisionId:p.decision.decision_id,id:p.id,messageHash:p.messageHash}));
  for(const kind of ['amount','recipient']){
    const r=await request('/api/tamper',{id:p.id,transactionBase64:p.transactionBase64,kind});assert.equal(r.code,'TRANSACTION_CHANGED');
    console.log(JSON.stringify({check:'tamper_refused',kind,code:r.code}));
  }
  if(process.argv.includes('--unsigned-only') || state.balanceLamports<1050000){console.log(JSON.stringify({status:'unsigned_path_verified',broadcast:false,remaining:'Free devnet funding and actual confirmation'}));return}
  const body={id:p.id,transactionBase64:p.transactionBase64};
  const submitted=await request('/api/execute',body);assert.equal(submitted.status,'submitted');
  const retry=await request('/api/execute',body);assert.equal(retry.signature,submitted.signature);
  console.log(JSON.stringify({check:'identical_retry',sameSignature:true,signature:submitted.signature}));
  for(let i=0;i<20;i++){
    const receipt=await request('/api/receipt?id='+encodeURIComponent(p.id));
    if(receipt.status==='confirmed'){
      assert.equal(receipt.messageHash,p.messageHash);assert.equal(receipt.proof.recipientDeltaLamports,1000000);
      console.log(JSON.stringify({status:'confirmed',signature:receipt.signature,proof:receipt.proof,decisionId:p.decision.decision_id,messageHash:p.messageHash}));return;
    }
    if(receipt.status==='failed')throw Error(receipt.code);
    await sleep(1500);
  }
  throw Error('Not confirmed within bounded polling window; do not resubmit a new transfer. Refresh the same receipt.');
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
