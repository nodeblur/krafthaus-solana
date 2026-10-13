const { createHash, randomUUID } = require('node:crypto');
const bs58 = require('bs58');
const { PublicKey, Transaction, TransactionInstruction, SystemProgram } = require('@solana/web3.js');
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const hash = value => createHash('sha256').update(value).digest('hex');

function createExecutor({wallet,recipient,chain,decide,now=Date.now}) {
  const approvals=new Map();
  const policy=Object.freeze({cluster:'devnet',genesis:DEVNET_GENESIS,sender:wallet.publicKey.toBase58(),recipient:recipient.toBase58(),maxLamports:1000000,totalLamports:3000000,ttlMs:60000});
  async function prepare(input) {
    input=structuredClone(input);
    if(!input || Object.keys(input).some(k=>!['recipient','lamports'].includes(k)) || !Number.isSafeInteger(input.lamports) || input.lamports<=0) return {status:'refused',code:'INVALID_PROPOSAL'};
    if(input.lamports>policy.maxLamports) return {status:'refused',code:'AMOUNT_OUTSIDE_POLICY'};
    if(input.recipient!==policy.recipient) return {status:'refused',code:'RECIPIENT_NOT_ALLOWED'};
    if(approvals.size>=32) return {status:'refused',code:'DEMO_RECORD_LIMIT'};
    const reserved=()=>[...approvals.values()].filter(a=>a.status!=='refused' && !(a.status==='approved' && now()>=a.expiresAt)).reduce((n,a)=>n+a.lamports,0);
    if(reserved()+input.lamports>policy.totalLamports) return {status:'refused',code:'SESSION_LIMIT'};
    if(await chain.genesis()!==DEVNET_GENESIS) return {status:'refused',code:'DEVNET_REQUIRED'};
    const decision=await decide(input);
    if(decision?.application_verdict!=='APPROVE' || !decision.decision_id || !/^[a-f0-9]{64}$/.test(decision.record_hash || '')) return {status:'refused',code:'DECIDE_NOT_APPROVED',decision};
    const latest=await chain.latest();
    // Recheck after remote awaits: concurrent preparations must not over-reserve.
    if(reserved()+input.lamports>policy.totalLamports || approvals.size>=32) return {status:'refused',code:'SESSION_LIMIT'};
    const id=randomUUID();
    const tx=new Transaction({feePayer:wallet.publicKey,recentBlockhash:latest.blockhash});
    tx.add(SystemProgram.transfer({fromPubkey:wallet.publicKey,toPubkey:new PublicKey(input.recipient),lamports:input.lamports}));
    tx.add(new TransactionInstruction({keys:[],programId:MEMO,data:Buffer.from(`krafthaus-bound:v1:${decision.decision_id}:${id}`)}));
    const proposal={id,status:'approved',cluster:'devnet',recipient:input.recipient,lamports:input.lamports,
      expiresAt:now()+60000,policyHash:hash(JSON.stringify(policy)),decision:structuredClone(decision),messageHash:hash(tx.serializeMessage()),
      transactionBase64:tx.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64')};
    approvals.set(id,structuredClone({...proposal,latest}));
    return structuredClone(proposal);
  }
  async function execute({id,transactionBase64}) {
    const approval=approvals.get(id);
    if(!approval) return {status:'refused',code:'APPROVAL_NOT_FOUND'};
    let tx;
    try { tx=Transaction.from(Buffer.from(transactionBase64,'base64')); }
    catch { return {status:'refused',code:'TRANSACTION_CHANGED'}; }
    if(hash(tx.serializeMessage())!==approval.messageHash || tx.signatures.some(s=>s.signature!==null)) return {status:'refused',code:'TRANSACTION_CHANGED'};
    if(approval.status!=='approved') return structuredClone({id,status:approval.status,signature:approval.signature,code:approval.code});
    if(now()>=approval.expiresAt) return {status:'refused',code:'APPROVAL_EXPIRED'};
    approval.status='checking';
    let broadcastStarted=false;
    const refuse=code=>{approval.status='refused';approval.code=code;return {id,status:'refused',code}};
    try {
      if(await chain.genesis()!==DEVNET_GENESIS) return refuse('DEVNET_REQUIRED');
      if(await chain.height()>approval.latest.lastValidBlockHeight) return refuse('BLOCKHASH_EXPIRED');
      if(await chain.balance(wallet.publicKey.toBase58())<approval.lamports+50000) return refuse('INSUFFICIENT_DEVNET_BALANCE');
      tx.sign(wallet);
      const wire=tx.serialize();
      const simulation=await chain.simulate(wire);
      if(simulation.err) return refuse('SIMULATION_FAILED');
      if(now()>=approval.expiresAt) return refuse('APPROVAL_EXPIRED');
      approval.signature=bs58.encode(tx.signature);
      approval.status='submitted';broadcastStarted=true;
      const returned=await chain.broadcast(wire);
      if(returned!==approval.signature) {approval.status='unknown';approval.code='SIGNATURE_MISMATCH'}
      return structuredClone({id,status:approval.status,signature:approval.signature,code:approval.code});
    } catch {
      if(!broadcastStarted) return refuse('PREFLIGHT_UNAVAILABLE');
      approval.status='unknown';approval.code='BROADCAST_UNCERTAIN';
      return {id,status:'unknown',signature:approval.signature,code:approval.code};
    }
  }
  async function receipt(id) {
    const a=approvals.get(id);if(!a) return {status:'refused',code:'APPROVAL_NOT_FOUND'};
    if(['submitted','unknown'].includes(a.status)) {
      try {
        if(await chain.genesis()!==DEVNET_GENESIS) return {status:'unknown',code:'DEVNET_REQUIRED'};
        const evidence=await chain.transaction(a.signature);
        if(evidence) {
          const tx=Transaction.from(Buffer.from(evidence.transaction[0],'base64'));
          const keys=tx.compileMessage().accountKeys;
          const recipientIndex=keys.findIndex(k=>k.toBase58()===a.recipient);
          const meta=evidence.meta;
          if(hash(tx.serializeMessage())!==a.messageHash || bs58.encode(tx.signature)!==a.signature || !tx.verifySignatures() || !meta) {
            a.status='unknown';a.code='CHAIN_EVIDENCE_MISMATCH';
          } else if(meta.err) {a.status='failed';a.code='CHAIN_TRANSACTION_FAILED'}
          else if(recipientIndex<0 || meta.postBalances[recipientIndex]-meta.preBalances[recipientIndex]!==a.lamports || meta.preBalances[0]-meta.postBalances[0]!==a.lamports+meta.fee) {
            a.status='unknown';a.code='CHAIN_EVIDENCE_MISMATCH';
          } else {
            a.status='confirmed';a.code=undefined;
            a.proof={slot:evidence.slot,feeLamports:meta.fee,recipientDeltaLamports:a.lamports,exactMessage:true,
              explorerUrl:`https://explorer.solana.com/tx/${a.signature}?cluster=devnet`};
          }
        }
      } catch { return {...structuredClone(a),status:'unknown',code:'CHAIN_READ_UNAVAILABLE',latest:undefined}; }
    }
    return {...structuredClone(a),latest:undefined};
  }
  return {prepare,execute,receipt,policy};
}
module.exports={createExecutor,DEVNET_GENESIS};
