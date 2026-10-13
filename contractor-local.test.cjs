const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {PassThrough}=require('node:stream');
const {generateKeyPairSync,sign}=require('node:crypto');
const {Keypair}=require('@solana/web3.js');
const {createExecutor,DEVNET_GENESIS}=require('./executor.cjs');
const {createContractorWorkflow}=require('./contractor.cjs');
const {createContractorServer,startContractorDemo}=require('./contractor-local.cjs');
const fs=require('node:fs'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const policyPath=fs.existsSync(path.join(__dirname,'contractor-policy.mjs'))?path.join(__dirname,'contractor-policy.mjs'):
  path.resolve(__dirname,'../../solana/bound-payout/contractor-policy.mjs');
const loadPolicy=()=>import(pathToFileURL(policyPath).href);

async function fixture(t) {
  const wallet=Keypair.generate(),recipient=Keypair.generate().publicKey,owner=generateKeyPairSync('ed25519');
  const agreement={schema_version:'krafthaus_contractor_agreement_v1',obligation_id:'http_obligation',invoice_id:'http_invoice',
    milestone_id:'http_milestone',delivery_sha256:'c'.repeat(64),recipient:recipient.toBase58(),lamports:1000000,cluster:'devnet'};
  const chain={genesis:async()=>DEVNET_GENESIS,balance:async()=>0,
    latest:async()=>({blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:1000})};
  const executor=createExecutor({wallet,recipient,chain,decide:async()=>({application_verdict:'APPROVE',decision_id:'http_fixture',record_hash:'d'.repeat(64)})});
  const trustedOwnerKey=owner.publicKey.export({type:'spki',format:'der'}).toString('base64');
  const workflow=createContractorWorkflow({agreement,trustedOwnerKey,executor});
  const server=createContractorServer({workflow,chain});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}`;
  const policy=await loadPolicy();
  const record={schema_version:'krafthaus_owner_acceptance_v1',agreement_hash:await policy.agreementHash(agreement),accepted_at:new Date().toISOString()};
  const acceptance={...record,signature_base64:sign(null,policy.acceptanceSigningBytes(record),owner.privateKey).toString('base64')};
  const headers={'content-type':'application/json','x-demo-intent':'devnet-only',origin:url};
  const post=(route,body,overrides={})=>fetch(url+route,{method:'POST',headers:{...headers,...overrides},body:JSON.stringify(body)});
  return {workflow,server,url,acceptance,post,headers};
}

test('contractor localhost API exposes public state and gates preparation without an owner issuer or legacy bypass',async t=>{
  const f=await fixture(t),state=await (await fetch(f.url+'/api/state')).json();
  assert.equal(state.policy.cluster,'devnet');assert.equal(state.agreement.invoice_id,'http_invoice');
  assert.equal(state.approval,null);assert.equal(state.acceptance,undefined);
  assert.equal(/privateKey|secretKey/.test(JSON.stringify(state)),false);
  const missing=await (await f.post('/api/prepare',{})).json();assert.equal(missing.verdict,'DEFER');
  for(const route of ['/api/accept','/api/sign','/api/fund','/api/tamper','/api/raw-execute']) {
    assert.equal((await f.post(route,{})).status,404);
  }
  const prepared=await (await f.post('/api/prepare',{acceptance:f.acceptance})).json();
  assert.equal(prepared.status,'approved');assert.equal(prepared.contractor.acceptance.signature_base64,f.acceptance.signature_base64);
  const alias=await (await f.post('/api/execute',{id:prepared.id,transactionBase64:prepared.transactionBase64,invoice_id:'alias'})).json();
  assert.equal(alias.code,'INVALID_EXECUTION');
  assert.equal((await (await fetch(f.url+'/api/receipt')).json()).id,prepared.id);
});

test('contractor HTTP mutations require exact loopback Host, Origin, JSON and explicit devnet intent',async t=>{
  const f=await fixture(t);
  for(const headers of [
    {'content-type':'application/json','x-demo-intent':'devnet-only'},
    {...f.headers,origin:'https://attacker.example'},
    {...f.headers,'content-type':'application/json; charset=utf-8'},
    {...f.headers,'x-demo-intent':'mainnet'},
  ]) assert.equal((await fetch(f.url+'/api/prepare',{method:'POST',headers,body:'{}'})).status,403);
  const wrongHost=await new Promise((resolve,reject)=>{
    const request=http.request(f.url+'/api/state',{headers:{host:`localhost:${f.server.address().port}`}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode));});
    request.on('error',reject);request.end();
  });
  assert.equal(wrongHost,403);
  assert.throws(()=>createContractorServer({workflow:f.workflow}).listen(0,'0.0.0.0'),/LOCAL_BIND_REQUIRED/);
  assert.throws(()=>createContractorServer({workflow:f.workflow}).listen({port:0,host:'0.0.0.0'}),/INVALID_LOCAL_PORT/);
  const invalid=await fetch(f.url+'/api/prepare',{method:'POST',headers:f.headers,body:'{' });assert.equal(invalid.status,400);
  const huge=await fetch(f.url+'/api/prepare',{method:'POST',headers:f.headers,body:JSON.stringify({acceptance:'x'.repeat(9000)})});assert.equal(huge.status,413);
  assert.equal((await fetch(f.url+'/api/receipt?id=caller_alias')).status,400);
  assert.equal(f.workflow.snapshot().approval,null);
});

test('operator Node entrypoint issues fixed-scope acceptance only after explicit owner-console step',async t=>{
  let decisionContext;
  const chain={genesis:async()=>DEVNET_GENESIS,balance:async()=>0,
    latest:async()=>({blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:1000})};
  const demo=await startContractorDemo({chain,decide:async(_input,context)=>{
    decisionContext=context;return {application_verdict:'APPROVE',decision_id:'operator_fixture',record_hash:'e'.repeat(64)};
  }});
  t.after(()=>new Promise(resolve=>demo.server.close(resolve)));
  const startup=await (await fetch(demo.url+'/api/state')).json();
  assert.equal(startup.approval,null);assert.equal(startup.acceptance,undefined);
  assert.equal(demo.executor,undefined);assert.equal(demo.wallet,undefined);
  const headers={'content-type':'application/json','x-demo-intent':'devnet-only',origin:demo.url};
  const missing=await (await fetch(demo.url+'/api/prepare',{method:'POST',headers,body:'{}'})).json();assert.equal(missing.verdict,'DEFER');
  const acceptance=await demo.ownerConsole.accept();
  assert.equal(demo.workflow.snapshot().approval,null);
  const policy=await loadPolicy();
  assert.equal((await policy.verifyAcceptance(startup.agreement,acceptance,startup.trustedOwnerKey)).verdict,'APPROVE');
  const result=await (await fetch(demo.url+'/api/prepare',{method:'POST',headers,body:JSON.stringify({acceptance})})).json();
  assert.equal(result.status,'approved');assert.equal(result.signature,undefined);
  assert.equal(decisionContext.acceptanceGate.verdict,'APPROVE');
  assert.equal(decisionContext.agreement.invoice_id,startup.agreement.invoice_id);
});

test('operator stdio startup prints no acceptance and explicit accept prints only the signed public record',async t=>{
  const operatorInput=new PassThrough(),operatorOutput=new PassThrough(),records=[];
  operatorOutput.on('data',chunk=>records.push(JSON.parse(chunk.toString())));
  const chain={genesis:async()=>DEVNET_GENESIS,balance:async()=>0};
  const demo=await startContractorDemo({chain,operatorInput,operatorOutput});
  t.after(()=>new Promise(resolve=>demo.server.close(resolve)));
  assert.equal(records.length,1);assert.equal(records[0].status,'ready');assert.equal(records[0].acceptance,undefined);
  const signedOutput=new Promise(resolve=>operatorOutput.on('data',chunk=>{const record=JSON.parse(chunk.toString());if(record.type==='owner_acceptance') resolve(record);}));
  operatorInput.write('accept\n');
  const signed=await signedOutput;
  assert.equal(signed.acceptance.schema_version,'krafthaus_owner_acceptance_v1');
  assert.equal(/privateKey|secretKey/.test(JSON.stringify(records)),false);
  assert.equal(demo.workflow.snapshot().approval,null);
  assert.equal((await fetch(demo.url+'/api/accept',{method:'POST',headers:{origin:demo.url,'content-type':'application/json','x-demo-intent':'devnet-only'},body:'{}'})).status,404);
});
