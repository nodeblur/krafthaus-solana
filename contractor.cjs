// Local authority wrapper: the agreement and owner key come from operator configuration.
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const policyPath=fs.existsSync(path.join(__dirname,'contractor-policy.mjs'))?path.join(__dirname,'contractor-policy.mjs'):
  path.resolve(__dirname,'../../solana/bound-payout/contractor-policy.mjs');
const sharedPolicy = () => import(pathToFileURL(policyPath).href);
const clone = value => structuredClone(value);
const plain=value=>value && typeof value==='object' && !Array.isArray(value);
const exactKeys=(value,allowed)=>plain(value) && Object.keys(value).every(key=>allowed.includes(key));
const DECIDE_INPUT_INTERPRETATION=Object.freeze({
  quorumSigned:'Verified Ed25519 acceptance from the single configured owner. This is not a DAO quorum.',
  recipientVerified:'Exact match to the configured allowlisted address. This is not identity verification.',
});
// Existing executor sets these refusal codes only before broadcast begins.
// Restart requires a fresh receipt proving refused and no submission signature.
const SAFE_PREFLIGHT_CODES=new Set(['DEVNET_REQUIRED','BLOCKHASH_EXPIRED','INSUFFICIENT_DEVNET_BALANCE','SIMULATION_FAILED','APPROVAL_EXPIRED','PREFLIGHT_UNAVAILABLE']);
function freeze(value) {
  if (value && typeof value === 'object') {Object.values(value).forEach(freeze);Object.freeze(value);}
  return value;
}
function createContractorWorkflow({agreement,trustedOwnerKey,executor,now=Date.now}) {
  const configuredAgreement=freeze(clone(agreement));
  const configuredPolicy=freeze(clone(executor.policy));
  const ownerKey=String(trustedOwnerKey);
  const preparePayment=executor.prepare.bind(executor),executePayment=executor.execute.bind(executor),paymentReceipt=executor.receipt.bind(executor);
  let approval=null;
  let replacementForbidden=false;
  function policyMatches() {
    const policy=executor.policy;
    return configuredPolicy.cluster==='devnet' && configuredPolicy.recipient===configuredAgreement.recipient &&
      Number.isSafeInteger(configuredPolicy.maxLamports) && configuredPolicy.maxLamports<=1000000 &&
      configuredAgreement.lamports<=configuredPolicy.maxLamports &&
      JSON.stringify(policy)===JSON.stringify(configuredPolicy);
  }
  const policyRefusal=()=>({status:'refused',verdict:'BLOCK',code:'EXECUTOR_POLICY_MISMATCH'});
  // Reserve synchronously before any verification/RPC await. Every request for
  // this configured obligation enters the same process-lifetime ledger.
  let queue=Promise.resolve();
  function exclusive(action) {
    const result=queue.then(action);
    queue=result.catch(()=>{});
    return result.then(clone);
  }
  const snapshot=()=>clone({agreement:configuredAgreement,trustedOwnerKey:ownerKey,policy:configuredPolicy,decideInputInterpretation:DECIDE_INPUT_INTERPRETATION,approval});
  function update(result) {
    if(result.signature || ['submitted','unknown','confirmed','failed'].includes(result.status)) replacementForbidden=true;
    approval=freeze(clone({...approval,...result}));return approval;
  }
  function applyOutcome(result,code) {
    const statuses=['approved','checking','submitted','unknown','confirmed','failed','refused'];
    const boundFields=['id','cluster','recipient','lamports','expiresAt','policyHash','messageHash','transactionBase64'];
    if(!plain(result) || !statuses.includes(result.status) ||
      boundFields.some(key=>Object.hasOwn(result,key) && result[key]!==approval[key]) ||
      (approval.signature && Object.hasOwn(result,'signature') && result.signature!==approval.signature) ||
      (Object.hasOwn(result,'decision') && JSON.stringify(result.decision)!==JSON.stringify(approval.decision))) {
      return update({status:'unknown',code});
    }
    // Only outcome fields may evolve. The accepted agreement, owner trace and
    // original transaction identity are never replaced by a provider receipt.
    return update({status:result.status,code:result.code,signature:result.signature || approval.signature,
      proof:result.proof || approval.proof});
  }
  async function reconcile() {
    if(!approval) return {status:'refused',code:'APPROVAL_NOT_FOUND'};
    if(!approval.id) return approval;
    try {return applyOutcome(clone(await paymentReceipt(approval.id)),'EXECUTOR_RECEIPT_MISMATCH');}
    catch {return update({status:'unknown',code:'RECEIPT_UNAVAILABLE'});}
  }
  function prepare(input={}) {
    if(!exactKeys(input,['acceptance'])) return {status:'refused',verdict:'BLOCK',code:'INVALID_PROPOSAL'};
    let accepted;try {accepted=clone(input.acceptance);} catch {return {status:'refused',verdict:'BLOCK',code:'INVALID_PROPOSAL'};}
    return exclusive(async()=>{
      const gate=await (await sharedPolicy()).verifyAcceptance(configuredAgreement,accepted,ownerKey,{now:now()});
      if(gate.verdict!=='APPROVE') return {status:gate.verdict==='DEFER'?'deferred':'refused',...gate};
      if(!policyMatches()) return policyRefusal();
      if(approval) {
        if(replacementForbidden) return reconcile();
        if(approval.status==='approved' && now()<approval.expiresAt) return approval;
        const original=await reconcile();
        const unusedExpired=original.status==='approved' && now()>=original.expiresAt;
        const safePreflight=original.status==='refused' && SAFE_PREFLIGHT_CODES.has(original.code);
        if((!unusedExpired && !safePreflight) || original.signature || replacementForbidden) return original;
      }
      const trace=approval?{acceptanceGate:approval.acceptanceGate,contractor:approval.contractor,decideInputInterpretation:approval.decideInputInterpretation}:
        {acceptanceGate:gate,contractor:{agreement:configuredAgreement,agreementHash:gate.agreementHash,acceptance:accepted},decideInputInterpretation:DECIDE_INPUT_INTERPRETATION};
      approval=freeze(clone({status:'preparing',...trace}));
      try {
        const result=await preparePayment({recipient:configuredAgreement.recipient,lamports:configuredAgreement.lamports});
        if(!policyMatches()) return update({status:'unknown',code:'EXECUTOR_POLICY_CHANGED'});
        return update(result);
      } catch {return update({status:'unknown',code:'PREPARATION_UNCERTAIN'});}
    });
  }
  function execute(input) {
    if(!exactKeys(input,['id','transactionBase64']) || typeof input.id!=='string' || typeof input.transactionBase64!=='string') return {status:'refused',code:'INVALID_EXECUTION'};
    const requested=clone(input);
    return exclusive(async()=>{
      if(!policyMatches()) return policyRefusal();
      if(!approval || requested.id!==approval.id) return {status:'refused',code:'APPROVAL_NOT_FOUND'};
      if(requested.transactionBase64!==approval.transactionBase64) return {status:'refused',code:'TRANSACTION_CHANGED'};
      if(approval.status!=='approved') return reconcile();
      update({status:'checking'});
      try {return applyOutcome(clone(await executePayment(requested)),'EXECUTOR_OUTCOME_MISMATCH');}
      catch {return update({status:'unknown',code:'EXECUTION_UNCERTAIN'});}
    });
  }
  const receipt=()=>exclusive(reconcile);
  return Object.freeze({prepare,execute,receipt,snapshot});
}
module.exports={createContractorWorkflow};
