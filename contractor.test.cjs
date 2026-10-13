const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, sign } = require('node:crypto');
const { Keypair, Transaction, SystemInstruction, SystemProgram } = require('@solana/web3.js');
const { createExecutor, DEVNET_GENESIS } = require('./executor.cjs');
const { createContractorWorkflow } = require('./contractor.cjs');
const fs=require('node:fs'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const policyPath=fs.existsSync(path.join(__dirname,'contractor-policy.mjs'))?path.join(__dirname,'contractor-policy.mjs'):
  path.resolve(__dirname,'../../solana/bound-payout/contractor-policy.mjs');
const loadPolicy=()=>import(pathToFileURL(policyPath).href);

async function fixture() {
  const wallet = Keypair.generate(), recipient = Keypair.generate().publicKey;
  const owner = generateKeyPairSync('ed25519');
  const trustedOwnerKey = owner.publicKey.export({type:'spki',format:'der'}).toString('base64');
  let clock = Date.now();
  const agreement = {schema_version:'krafthaus_contractor_agreement_v1',obligation_id:'obligation_01',invoice_id:'invoice_01',
    milestone_id:'milestone_01',delivery_sha256:'a'.repeat(64),recipient:recipient.toBase58(),lamports:1000000,cluster:'devnet'};
  const chain = {genesis:async()=>DEVNET_GENESIS,latest:async()=>({blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:1000}),
    height:async()=>100,balance:async()=>100000000,simulate:async()=>({err:null}),transaction:async()=>null,sent:[],
    broadcast:async raw=>{chain.sent.push(Buffer.from(raw));return require('bs58').encode(Transaction.from(raw).signature)}};
  const decide = async()=>({application_verdict:'APPROVE',decision_id:'fixture_contractor_decision',record_hash:'b'.repeat(64)});
  const executor = createExecutor({wallet,recipient,chain,decide,now:()=>clock});
  const policy = await loadPolicy();
  async function acceptance(overrides = {}, signingKey = owner.privateKey) {
    const record = {schema_version:'krafthaus_owner_acceptance_v1',agreement_hash:await policy.agreementHash(agreement),
      accepted_at:new Date(clock).toISOString(),...overrides};
    return {...record,signature_base64:sign(null,policy.acceptanceSigningBytes(record),signingKey).toString('base64')};
  }
  return {wallet,recipient,owner,agreement,trustedOwnerKey,chain,executor,decide,acceptance,now:()=>clock,
    advance:ms=>{clock+=ms},create:options=>createContractorWorkflow({agreement,trustedOwnerKey,executor,now:()=>clock,...options})};
}

test('missing owner acceptance defers the configured contractor obligation without a signable transaction', async()=>{
  const f=await fixture(),workflow=f.create();
  const result=await workflow.prepare({});
  assert.equal(result.status,'deferred');
  assert.equal(result.verdict,'DEFER');
  assert.equal(result.code,'OWNER_ACCEPTANCE_MISSING');
  assert.equal(result.transactionBase64,undefined);
  assert.equal(workflow.snapshot().approval,null);
  assert.equal(f.chain.sent.length,0);
});

test('verified owner acceptance prepares the exact configured transfer and immutable acceptance trace', async()=>{
  const f=await fixture(),workflow=f.create(),acceptance=await f.acceptance();
  const result=await workflow.prepare({acceptance});
  assert.equal(result.status,'approved');
  assert.equal(result.acceptanceGate.verdict,'APPROVE');
  assert.equal(result.acceptanceGate.code,'OWNER_ACCEPTANCE_VERIFIED');
  assert.deepEqual(result.contractor.agreement,f.agreement);
  assert.deepEqual(result.contractor.acceptance,acceptance);
  assert.equal(result.contractor.agreementHash,acceptance.agreement_hash);
  assert.match(result.decideInputInterpretation.quorumSigned,/single configured owner/);
  assert.match(result.decideInputInterpretation.quorumSigned,/not a DAO quorum/i);
  assert.match(result.decideInputInterpretation.recipientVerified,/allowlisted address/);
  assert.match(result.decideInputInterpretation.recipientVerified,/not identity verification/i);
  const transfer=SystemInstruction.decodeTransfer(Transaction.from(Buffer.from(result.transactionBase64,'base64')).instructions[0]);
  assert.equal(transfer.toPubkey.toBase58(),f.agreement.recipient);
  assert.equal(Number(transfer.lamports),f.agreement.lamports);
  assert.equal(f.chain.sent.length,0);
});

test('agent booleans, extra proposal fields, tampering and untrusted signatures cannot replace owner acceptance', async()=>{
  const f=await fixture(),valid=await f.acceptance(),rogue=generateKeyPairSync('ed25519');
  for(const input of [
    {accepted:true}, {acceptance:valid,quorumSigned:true}, {acceptance:valid,lamports:1},
    {acceptance:{...valid,accepted_at:'2020-01-01T00:00:00.000Z'}},
    {acceptance:await f.acceptance({agreement_hash:'f'.repeat(64)})},
    {acceptance:await f.acceptance({},rogue.privateKey)},
    {acceptance:{...valid,trustedOwnerKey:rogue.publicKey.export({type:'spki',format:'der'}).toString('base64')}},
  ]) {
    const workflow=f.create(),result=await workflow.prepare(input);
    assert.equal(result.status,'refused');assert.equal(result.verdict,'BLOCK');
    assert.equal(result.transactionBase64,undefined);assert.equal(workflow.snapshot().approval,null);
  }
});

test('concurrent and new preparation requests reuse one exact approval for the configured obligation', async()=>{
  const f=await fixture(),workflow=f.create(),acceptance=await f.acceptance();
  let release;const hold=new Promise(resolve=>{release=resolve});
  f.chain.latest=async()=>{await hold;return {blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:1000}};
  const first=workflow.prepare({acceptance});
  const second=workflow.prepare({acceptance});
  await new Promise(resolve=>setImmediate(resolve));release();
  const [a,b]=await Promise.all([first,second]);
  assert.equal(a.status,'approved');assert.deepEqual(b,a);
  f.advance(1000);
  const newlySigned=await f.acceptance();
  assert.deepEqual(await workflow.prepare({acceptance:newlySigned}),a);
});

test('lost broadcast response and concurrent retries reconcile the original obligation without replacement payment', async()=>{
  const f=await fixture(),workflow=f.create(),acceptance=await f.acceptance();
  f.chain.broadcast=async raw=>{f.chain.sent.push(Buffer.from(raw));throw Error('response lost')};
  const p=await workflow.prepare({acceptance}),input={id:p.id,transactionBase64:p.transactionBase64};
  const [a,b]=await Promise.all([workflow.execute(input),workflow.execute(input)]);
  assert.equal(a.status,'unknown');assert.equal(b.signature,a.signature);assert.equal(f.chain.sent.length,1);
  f.advance(120000);
  const retry=await workflow.prepare({acceptance:await f.acceptance()});
  assert.equal(retry.id,p.id);assert.equal(retry.status,'unknown');assert.equal(retry.signature,a.signature);
  assert.equal((await workflow.receipt()).id,p.id);assert.equal(f.chain.sent.length,1);
});

test('expired unused approval renews only after the original is still proven never submitted, including execute race', async()=>{
  for(const executeFirst of [false,true]) {
    const f=await fixture(),workflow=f.create(),acceptance=await f.acceptance(),p=await workflow.prepare({acceptance});
    f.advance(60001);
    const input={id:p.id,transactionBase64:p.transactionBase64};
    const pending=executeFirst?[workflow.execute(input),workflow.prepare({acceptance})]:[workflow.prepare({acceptance}),workflow.execute(input)];
    const results=await Promise.all(pending),renewed=results[executeFirst?1:0],oldExecution=results[executeFirst?0:1];
    assert.equal(renewed.status,'approved');assert.notEqual(renewed.id,p.id);
    assert.equal(oldExecution.status,'refused');assert.equal(f.chain.sent.length,0);
    assert.equal((await workflow.prepare({acceptance})).id,renewed.id);
  }
});

test('executor cluster, recipient and amount cap must match the configured contractor authority', async()=>{
  const f=await fixture(),acceptance=await f.acceptance();
  for(const change of [{cluster:'mainnet-beta'},{recipient:Keypair.generate().publicKey.toBase58()},{maxLamports:999999},{maxLamports:2000000}]) {
    const executor={...f.executor,policy:{...f.executor.policy,...change}},workflow=f.create({executor});
    const result=await workflow.prepare({acceptance});
    assert.equal(result.code,'EXECUTOR_POLICY_MISMATCH');assert.equal(result.status,'refused');assert.equal(result.transactionBase64,undefined);
  }
  const executor={...f.executor,policy:{...f.executor.policy}},workflow=f.create({executor});
  const p=await workflow.prepare({acceptance});executor.policy.recipient=Keypair.generate().publicKey.toBase58();
  assert.equal((await workflow.execute({id:p.id,transactionBase64:p.transactionBase64})).code,'EXECUTOR_POLICY_MISMATCH');
  assert.equal(f.chain.sent.length,0);
});

test('known simulation preflight refusal can restart safely, while uncertain preparation remains reserved', async()=>{
  const f=await fixture(),workflow=f.create(),acceptance=await f.acceptance();
  f.chain.simulate=async()=>({err:{InstructionError:[0,'fixture failure']}});
  const p=await workflow.prepare({acceptance});
  assert.equal((await workflow.execute({id:p.id,transactionBase64:p.transactionBase64})).code,'SIMULATION_FAILED');
  f.chain.simulate=async()=>({err:null});
  const replacement=await workflow.prepare({acceptance});
  assert.equal(replacement.status,'approved');assert.notEqual(replacement.id,p.id);assert.equal(f.chain.sent.length,0);
  const uncertainFixture=await fixture();
  uncertainFixture.chain.latest=async()=>{throw Error('upstream unavailable')};
  const uncertainWorkflow=uncertainFixture.create(),record=await uncertainFixture.acceptance();
  const uncertain=await uncertainWorkflow.prepare({acceptance:record});
  assert.equal(uncertain.status,'unknown');assert.equal(uncertain.code,'PREPARATION_UNCERTAIN');
  uncertainFixture.chain.latest=async()=>({blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:1000});
  assert.deepEqual(await uncertainWorkflow.prepare({acceptance:record}),uncertain);
});

test('mutating caller agreement, acceptance or returned records cannot alter the configured payment authority', async()=>{
  const f=await fixture(),acceptance=await f.acceptance(),workflow=f.create();
  const original=structuredClone(f.agreement),originalAcceptance=structuredClone(acceptance);
  let release;const hold=new Promise(resolve=>{release=resolve});
  f.chain.latest=async()=>{await hold;return {blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:1000}};
  const pending=workflow.prepare({acceptance});
  f.agreement.recipient=Keypair.generate().publicKey.toBase58();f.agreement.lamports=1;
  acceptance.agreement_hash='f'.repeat(64);acceptance.signature_base64='changed';
  release();
  const p=await pending;
  assert.equal(p.status,'approved');assert.deepEqual(p.contractor.agreement,original);assert.deepEqual(p.contractor.acceptance,originalAcceptance);
  const state=workflow.snapshot();state.agreement.recipient=f.agreement.recipient;state.policy.cluster='mainnet-beta';state.approval.contractor.acceptance.accepted_at='changed';
  p.contractor.agreement.lamports=99;p.contractor.acceptance.signature_base64='changed';p.acceptanceGate.verdict='BLOCK';p.expiresAt=0;
  const submitted=await workflow.execute({id:p.id,transactionBase64:p.transactionBase64});
  assert.equal(submitted.status,'submitted');assert.deepEqual(submitted.contractor.agreement,original);
  const transfer=SystemInstruction.decodeTransfer(Transaction.from(f.chain.sent[0]).instructions[0]);
  assert.equal(transfer.toPubkey.toBase58(),original.recipient);assert.equal(Number(transfer.lamports),original.lamports);
});

test('altered transaction or extra execution fields never broadcast, while exact original can still submit', async()=>{
  const f=await fixture(),workflow=f.create(),p=await workflow.prepare({acceptance:await f.acceptance()});
  const tx=Transaction.from(Buffer.from(p.transactionBase64,'base64'));
  tx.instructions[0]=SystemProgram.transfer({fromPubkey:f.wallet.publicKey,toPubkey:f.recipient,lamports:999999});
  const changed=tx.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64');
  assert.equal((await workflow.execute({id:p.id,transactionBase64:changed})).code,'TRANSACTION_CHANGED');
  assert.equal((await workflow.execute({id:p.id,transactionBase64:p.transactionBase64,quorumSigned:true})).code,'INVALID_EXECUTION');
  assert.equal((await workflow.execute({id:'caller_alias',transactionBase64:p.transactionBase64})).code,'APPROVAL_NOT_FOUND');
  assert.equal(f.chain.sent.length,0);
  assert.equal((await workflow.execute({id:p.id,transactionBase64:p.transactionBase64})).status,'submitted');
  assert.equal(f.chain.sent.length,1);
});

test('preparation during execution checking keeps the original transaction, even after unused TTL has elapsed', async()=>{
  const f=await fixture(),workflow=f.create(),acceptance=await f.acceptance(),p=await workflow.prepare({acceptance});
  let entered,release;const started=new Promise(resolve=>{entered=resolve}),hold=new Promise(resolve=>{release=resolve});
  f.chain.broadcast=async raw=>{f.chain.sent.push(Buffer.from(raw));entered();await hold;return require('bs58').encode(Transaction.from(raw).signature)};
  const execution=workflow.execute({id:p.id,transactionBase64:p.transactionBase64});
  await started;f.advance(120000);
  const preparation=workflow.prepare({acceptance});
  release();
  const [submitted,repeated]=await Promise.all([execution,preparation]);
  assert.equal(submitted.status,'submitted');assert.equal(repeated.id,p.id);assert.equal(repeated.signature,submitted.signature);
  assert.equal(f.chain.sent.length,1);
});

test('confirmed and failed terminal receipts retain the original signature after expiry and new preparation', async()=>{
  for(const failed of [false,true]) {
    const f=await fixture(),workflow=f.create(),p=await workflow.prepare({acceptance:await f.acceptance()});
    const submitted=await workflow.execute({id:p.id,transactionBase64:p.transactionBase64});
    const signed=Transaction.from(f.chain.sent[0]),keys=signed.compileMessage().accountKeys;
    const pre=keys.map(()=>0),post=keys.map(()=>0);pre[0]=100000000;post[0]=98995000;
    post[keys.findIndex(key=>key.equals(f.recipient))]=1000000;
    f.chain.transaction=async()=>({slot:123,transaction:[f.chain.sent[0].toString('base64'),'base64'],
      meta:{err:failed?{InstructionError:[0,'failed']}:null,fee:5000,preBalances:pre,postBalances:post}});
    const receipt=await workflow.receipt();assert.equal(receipt.status,failed?'failed':'confirmed');
    f.advance(120000);
    const repeated=await workflow.prepare({acceptance:await f.acceptance()});
    const retried=await workflow.execute({id:p.id,transactionBase64:p.transactionBase64});
    assert.equal(repeated.id,p.id);assert.equal(repeated.signature,submitted.signature);assert.equal(retried.signature,submitted.signature);
    assert.equal(repeated.status,receipt.status);assert.equal(f.chain.sent.length,1);
  }
});

test('unavailable, malformed or foreign chain receipts during unknown outcome never permit replacement', async()=>{
  for(const kind of ['unavailable','malformed','foreign','foreign_failed']) {
    const f=await fixture(),workflow=f.create(),p=await workflow.prepare({acceptance:await f.acceptance()});
    f.chain.broadcast=async raw=>{f.chain.sent.push(Buffer.from(raw));throw Error('response lost')};
    const unknown=await workflow.execute({id:p.id,transactionBase64:p.transactionBase64});
    assert.equal(unknown.status,'unknown');
    f.chain.transaction=async()=>{
      if(kind==='unavailable') throw Error('RPC unavailable');
      if(kind==='malformed') return {transaction:['invalid','base64'],meta:{},slot:123};
      const other=Transaction.from(f.chain.sent[0]);
      other.instructions[0]=SystemProgram.transfer({fromPubkey:f.wallet.publicKey,toPubkey:f.recipient,lamports:1});other.sign(f.wallet);
      return {transaction:[other.serialize().toString('base64'),'base64'],slot:123,
        meta:{err:kind==='foreign_failed'?{InstructionError:[0,'foreign failure']}:null,fee:5000,preBalances:[100000000,0,0,0],postBalances:[99995000,0,0,0]}};
    };
    f.advance(120000);
    const repeated=await workflow.prepare({acceptance:await f.acceptance()}),receipt=await workflow.receipt();
    assert.equal(repeated.status,'unknown');assert.equal(repeated.id,p.id);assert.equal(receipt.id,p.id);
    assert.equal(receipt.signature,unknown.signature);assert.equal(f.chain.sent.length,1);
  }
});

test('a malformed or foreign execution-boundary receipt cannot overwrite the original approval identity or trace', async()=>{
  for(const kind of ['malformed','foreign']) {
    const f=await fixture();
    const executor={...f.executor,receipt:async id=>{
      const original=await f.executor.receipt(id);
      return kind==='malformed'?{status:'approved',expiresAt:0}:
        {...original,id:'foreign_approval',contractor:{agreement:{invoice_id:'foreign_invoice'}}};
    }};
    const workflow=f.create({executor}),p=await workflow.prepare({acceptance:await f.acceptance()});
    f.chain.broadcast=async raw=>{f.chain.sent.push(Buffer.from(raw));throw Error('response lost')};
    const unknown=await workflow.execute({id:p.id,transactionBase64:p.transactionBase64});f.advance(120000);
    const receipt=await workflow.prepare({acceptance:await f.acceptance()});
    assert.equal(receipt.status,'unknown');assert.equal(receipt.code,'EXECUTOR_RECEIPT_MISMATCH');
    assert.equal(receipt.id,p.id);assert.equal(receipt.signature,unknown.signature);
    assert.deepEqual(receipt.contractor,p.contractor);assert.equal(f.chain.sent.length,1);
  }
});
