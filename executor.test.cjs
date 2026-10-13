const test = require('node:test');
const assert = require('node:assert/strict');
const { Keypair, Transaction, SystemInstruction, SystemProgram } = require('@solana/web3.js');
const { createExecutor, DEVNET_GENESIS } = require('./executor.cjs');

function fixture() {
  const wallet = Keypair.generate();
  const recipient = Keypair.generate().publicKey;
  const chain = {
    genesis: async () => DEVNET_GENESIS,
    latest: async () => ({blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:1000}),
    height:async()=>100,
    balance:async()=>100000000,
    simulate:async()=>({err:null}),
    broadcast:async raw=>{chain.sent.push(Buffer.from(raw));return require('bs58').encode(Transaction.from(raw).signature)},
    sent:[],
  };
  const decide = async () => ({application_verdict:'APPROVE',decision_id:'fixture_decision',record_hash:'a'.repeat(64)});
  return {wallet,recipient,chain,decide};
}

test('approved proposal returns an actual unsigned Solana transfer bound to its decision', async () => {
  const f=fixture(); const executor=createExecutor(f);
  const proposal=await executor.prepare({recipient:f.recipient.toBase58(),lamports:1000000});
  assert.equal(proposal.status,'approved');
  const tx=Transaction.from(Buffer.from(proposal.transactionBase64,'base64'));
  const transfer=SystemInstruction.decodeTransfer(tx.instructions[0]);
  assert.equal(transfer.toPubkey.toBase58(),f.recipient.toBase58());
  assert.equal(Number(transfer.lamports),1000000);
  assert.equal(proposal.decision.decision_id,'fixture_decision');
  assert.equal(tx.signatures.every(s=>s.signature===null),true);
});
test('out-of-policy proposals never receive a signable transaction', async () => {
  const f=fixture(); const executor=createExecutor(f);
  for(const input of [
    {recipient:f.recipient.toBase58(),lamports:2000000},
    {recipient:Keypair.generate().publicKey.toBase58(),lamports:1000000},
    {recipient:f.recipient.toBase58(),lamports:-1},
    {recipient:f.recipient.toBase58(),lamports:1.5},
    {recipient:f.recipient.toBase58(),lamports:1000000,cluster:'mainnet-beta'},
  ]) {
    const result=await executor.prepare(input);
    assert.equal(result.status,'refused');
    assert.equal(result.transactionBase64,undefined);
  }
});

test('wrong network or an unavailable/non-approving Decide result cannot issue approval', async () => {
  const f=fixture(); const input={recipient:f.recipient.toBase58(),lamports:1000000};
  assert.equal((await createExecutor({...f,chain:{...f.chain,genesis:async()=>'mainnet'}}).prepare(input)).code,'DEVNET_REQUIRED');
  for(const application_verdict of ['BLOCK','DEFER',undefined]) {
    const result=await createExecutor({...f,decide:async()=>({application_verdict})}).prepare(input);
    assert.equal(result.status,'refused');assert.equal(result.transactionBase64,undefined);
  }
});

test('changed transaction bytes are refused before signing or broadcasting', async () => {
  const f=fixture(); const executor=createExecutor(f);
  const p=await executor.prepare({recipient:f.recipient.toBase58(),lamports:1000000});
  for(const mutate of [
    tx=>{tx.instructions[0]=SystemProgram.transfer({fromPubkey:f.wallet.publicKey,toPubkey:f.recipient,lamports:999999})},
    tx=>{tx.instructions[0]=SystemProgram.transfer({fromPubkey:f.wallet.publicKey,toPubkey:Keypair.generate().publicKey,lamports:1000000})},
    tx=>{tx.recentBlockhash=Keypair.generate().publicKey.toBase58()},
    tx=>{tx.add(SystemProgram.transfer({fromPubkey:f.wallet.publicKey,toPubkey:f.recipient,lamports:1}))},
  ]) {
    const tx=Transaction.from(Buffer.from(p.transactionBase64,'base64'));mutate(tx);
    const result=await executor.execute({id:p.id,transactionBase64:tx.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64')});
    assert.equal(result.code,'TRANSACTION_CHANGED');
    assert.equal(result.signature,undefined);
  }
});

test('an expired approval or wrong RPC network never reaches signing', async () => {
  const f=fixture();let clock=1000;const executor=createExecutor({...f,now:()=>clock});
  const p=await executor.prepare({recipient:f.recipient.toBase58(),lamports:1000000});
  clock=p.expiresAt;
  assert.equal((await executor.execute({id:p.id,transactionBase64:p.transactionBase64})).code,'APPROVAL_EXPIRED');
  clock=1000;f.chain.genesis=async()=>'mainnet';
  assert.equal((await executor.execute({id:p.id,transactionBase64:p.transactionBase64})).code,'DEVNET_REQUIRED');
});

test('approved transaction is signed once and identical retries return the same submission', async () => {
  const f=fixture(); const executor=createExecutor(f);
  const p=await executor.prepare({recipient:f.recipient.toBase58(),lamports:1000000});
  const input={id:p.id,transactionBase64:p.transactionBase64};
  const result=await executor.execute(input);const retry=await executor.execute(input);
  assert.equal(result.status,'submitted');assert.equal(retry.signature,result.signature);
  assert.equal(f.chain.sent.length,1);
  const signed=Transaction.from(f.chain.sent[0]);
  assert.equal(signed.verifySignatures(),true);
  assert.deepEqual(signed.serializeMessage(),Transaction.from(Buffer.from(p.transactionBase64,'base64')).serializeMessage());
});

test('the session allowance is reserved across approvals and released only on unused expiry', async () => {
  const f=fixture();let clock=1000;const executor=createExecutor({...f,now:()=>clock});
  const input={recipient:f.recipient.toBase58(),lamports:1000000};
  for(let n=0;n<3;n++) assert.equal((await executor.prepare(input)).status,'approved');
  assert.equal((await executor.prepare(input)).code,'SESSION_LIMIT');
  clock+=60001;
  assert.equal((await executor.prepare(input)).status,'approved');
});

test('confirmation requires the exact successful chain transaction and matching receiver balance change', async()=>{
  const f=fixture();let evidence=null;f.chain.transaction=async()=>evidence;
  const executor=createExecutor(f);const p=await executor.prepare({recipient:f.recipient.toBase58(),lamports:1000000});
  await executor.execute({id:p.id,transactionBase64:p.transactionBase64});
  assert.equal((await executor.receipt(p.id)).status,'submitted');
  const signed=Transaction.from(f.chain.sent[0]);const keys=signed.compileMessage().accountKeys;
  const pre=keys.map(()=>0),post=keys.map(()=>0);pre[0]=100000000;post[0]=98995000;
  post[keys.findIndex(k=>k.equals(f.recipient))]=1000000;
  evidence={slot:123,transaction:[f.chain.sent[0].toString('base64'),'base64'],meta:{err:null,fee:5000,preBalances:pre,postBalances:post}};
  const receipt=await executor.receipt(p.id);
  assert.equal(receipt.status,'confirmed');assert.equal(receipt.messageHash,p.messageHash);
  assert.equal(receipt.proof.recipientDeltaLamports,1000000);assert.equal(receipt.proof.slot,123);
});

test('simulation failure, expired blockhash and missing funding never broadcast',async()=>{
  for(const [change,code] of [
    [f=>{f.chain.simulate=async()=>({err:{InstructionError:[0,'Custom']}})},'SIMULATION_FAILED'],
    [f=>{f.chain.height=async()=>1001},'BLOCKHASH_EXPIRED'],
    [f=>{f.chain.balance=async()=>0},'INSUFFICIENT_DEVNET_BALANCE'],
  ]) {
    const f=fixture();change(f);const executor=createExecutor(f);
    const p=await executor.prepare({recipient:f.recipient.toBase58(),lamports:1000000});
    const result=await executor.execute({id:p.id,transactionBase64:p.transactionBase64});
    assert.equal(result.code,code);assert.equal(f.chain.sent.length,0);
  }
});

test('concurrent execution and a lost broadcast response cannot create another payment',async()=>{
  const f=fixture();f.chain.broadcast=async raw=>{f.chain.sent.push(Buffer.from(raw));throw Error('lost response')};
  f.chain.transaction=async()=>null;
  const executor=createExecutor(f);const p=await executor.prepare({recipient:f.recipient.toBase58(),lamports:1000000});
  const input={id:p.id,transactionBase64:p.transactionBase64};
  await Promise.all([executor.execute(input),executor.execute(input)]);
  const retry=await executor.execute(input);
  assert.equal(retry.status,'unknown');assert.equal(f.chain.sent.length,1);
  assert.equal((await executor.receipt(p.id)).status,'unknown');
});

test('non-successful or altered chain evidence is never called confirmed',async()=>{
  for(const kind of ['failed','wrong_amount']) {
    const f=fixture();const executor=createExecutor(f);
    const p=await executor.prepare({recipient:f.recipient.toBase58(),lamports:1000000});
    await executor.execute({id:p.id,transactionBase64:p.transactionBase64});
    f.chain.transaction=async()=>({slot:123,transaction:[f.chain.sent[0].toString('base64'),'base64'],meta:{err:kind==='failed'?{InstructionError:[0,'bad']}:null,fee:5000,preBalances:[100000000,0,0,0],postBalances:[99995000,0,0,0]}});
    assert.notEqual((await executor.receipt(p.id)).status,'confirmed');
  }
});

test('a foreign failed chain transaction is not a failed receipt for the original approved payment',async()=>{
  const f=fixture(),executor=createExecutor(f);
  const p=await executor.prepare({recipient:f.recipient.toBase58(),lamports:1000000});
  const submitted=await executor.execute({id:p.id,transactionBase64:p.transactionBase64});
  const foreign=Transaction.from(f.chain.sent[0]);
  foreign.instructions[0]=SystemProgram.transfer({fromPubkey:f.wallet.publicKey,toPubkey:f.recipient,lamports:1});foreign.sign(f.wallet);
  f.chain.transaction=async()=>({slot:123,transaction:[foreign.serialize().toString('base64'),'base64'],
    meta:{err:{InstructionError:[0,'foreign failure']},fee:5000,preBalances:[100000000,0,0,0],postBalances:[99995000,0,0,0]}});
  const receipt=await executor.receipt(p.id);
  assert.equal(receipt.status,'unknown');assert.equal(receipt.code,'CHAIN_EVIDENCE_MISMATCH');
  assert.equal(receipt.id,p.id);assert.equal(receipt.signature,submitted.signature);
  assert.equal((await executor.execute({id:p.id,transactionBase64:p.transactionBase64})).signature,submitted.signature);
  assert.equal(f.chain.sent.length,1);
});

test('mutating a returned approval cannot alter server-held signing authority',async()=>{
  const f=fixture();const executor=createExecutor(f);const p=await executor.prepare({recipient:f.recipient.toBase58(),lamports:1000000});
  p.status='confirmed';p.expiresAt=0;p.decision.application_verdict='BLOCK';p.lamports=999999;
  const result=await executor.execute({id:p.id,transactionBase64:p.transactionBase64});
  assert.equal(result.status,'submitted');assert.equal(f.chain.sent.length,1);
});

test('changing the caller proposal while remote evaluation awaits cannot change the bound transfer',async()=>{
  const f=fixture();let release;f.decide=()=>new Promise(r=>{release=r});
  const executor=createExecutor(f),input={recipient:f.recipient.toBase58(),lamports:1000000};
  const pending=executor.prepare(input);await new Promise(r=>setImmediate(r));
  input.lamports=9000000;input.recipient=Keypair.generate().publicKey.toBase58();
  release({application_verdict:'APPROVE',decision_id:'fixture_decision',record_hash:'a'.repeat(64)});
  const p=await pending;const tx=Transaction.from(Buffer.from(p.transactionBase64,'base64'));
  const transfer=SystemInstruction.decodeTransfer(tx.instructions[0]);
  assert.equal(Number(transfer.lamports),1000000);assert.equal(transfer.toPubkey.toBase58(),f.recipient.toBase58());
});
