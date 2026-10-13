const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const readline=require('node:readline');
const {pathToFileURL}=require('node:url');
const {createHash,generateKeyPairSync,randomUUID,sign}=require('node:crypto');
const {Keypair}=require('@solana/web3.js');
const {createExecutor,DEVNET_GENESIS}=require('./executor.cjs');
const {createDevnetChain}=require('./chain.cjs');
const {createContractorWorkflow}=require('./contractor.cjs');

async function contractorPolicy() {
  const local=path.join(__dirname,'contractor-policy.mjs');
  return import(pathToFileURL(fs.existsSync(local)?local:path.resolve(__dirname,'../../solana/bound-payout/contractor-policy.mjs')).href);
}

function createContractorServer({workflow,chain}) {
  const server=http.createServer(async(req,res)=>{
    const port=server.address().port,origin=`http://127.0.0.1:${port}`;
    const reply=(status,body)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(body));};
    if(req.headers.host!==`127.0.0.1:${port}` || (req.headers.origin && req.headers.origin!==origin)) return reply(403,{code:'LOCAL_ORIGIN_REQUIRED'});
    try {
      const url=new URL(req.url,origin);
      if(req.method==='GET' && url.pathname==='/api/state') {
        const state=workflow.snapshot();
        return reply(200,{...state,balanceLamports:chain?await chain.balance(state.policy.sender):undefined});
      }
      if(req.method==='GET' && url.pathname==='/api/receipt') {
        if(url.search) return reply(400,{code:'RECEIPT_SCOPE_FIXED'});
        return reply(200,await workflow.receipt());
      }
      if(req.method!=='POST' || !['/api/prepare','/api/execute'].includes(url.pathname)) return reply(404,{code:'NOT_FOUND'});
      if(req.headers.origin!==origin) return reply(403,{code:'LOCAL_ORIGIN_REQUIRED'});
      if(req.headers['content-type']!=='application/json' || req.headers['x-demo-intent']!=='devnet-only') return reply(403,{code:'DEMO_INTENT_REQUIRED'});
      let bodyText='';
      for await(const chunk of req) {bodyText+=chunk;if(Buffer.byteLength(bodyText)>8192) return reply(413,{code:'BODY_TOO_LARGE'});}
      let body;try {body=JSON.parse(bodyText);} catch {return reply(400,{code:'INVALID_JSON'});}
      return reply(200,await (url.pathname==='/api/prepare'?workflow.prepare(body):workflow.execute(body)));
    } catch {return reply(503,{status:'unavailable',code:'CONTRACTOR_DEPENDENCY_UNAVAILABLE'});}
  });
  const listen=server.listen.bind(server);
  server.listen=(port,host,callback)=>{
    if(!Number.isInteger(port) || port<0 || port>65535) throw Error('INVALID_LOCAL_PORT');
    if(typeof host==='function') {callback=host;host='127.0.0.1';}
    if(host!==undefined && host!=='127.0.0.1') throw Error('LOCAL_BIND_REQUIRED');
    return listen(port,'127.0.0.1',callback);
  };
  return server;
}

async function defaultDecide(input,context) {
  const agreement=context.agreement,verified=context.acceptanceGate?.verdict==='APPROVE';
  if(!verified) throw Error('OWNER_ACCEPTANCE_REQUIRED');
  const response=await fetch('https://www.krafthaus.app/api/solana-decision',{method:'POST',
    headers:{'content-type':'application/json',origin:'https://www.krafthaus.app'},
    body:JSON.stringify({proposalName:`Fictional contractor invoice ${agreement.invoice_id}, milestone ${agreement.milestone_id}`,
      daoName:'Fictional local contractor test mandate',solAmount:input.lamports/1000000000,riskLevel:'low',evidenceLevel:'strong',
      quorumSigned:verified,budgetWithinPolicy:input.lamports===agreement.lamports && input.lamports<=1000000,
      recipientVerified:input.recipient===agreement.recipient}),signal:AbortSignal.timeout(15000)});
  const body=await response.json();
  if(!response.ok || !body.ok) throw Error('DECIDE_UNAVAILABLE');
  return body.decision;
}

async function startContractorDemo({chain=createDevnetChain(),decide=defaultDecide,port=0,now=Date.now,operatorInput,operatorOutput}={}) {
  if(!Number.isInteger(port) || port<0 || port>65535) throw Error('INVALID_LOCAL_PORT');
  if(await chain.genesis()!==DEVNET_GENESIS) throw Error('DEVNET_REQUIRED');
  const wallet=Keypair.generate(),recipient=Keypair.generate().publicKey;
  const owner=generateKeyPairSync('ed25519');
  const trustedOwnerKey=owner.publicKey.export({type:'spki',format:'der'}).toString('base64');
  const runId=randomUUID().replaceAll('-','');
  const agreement=Object.freeze({schema_version:'krafthaus_contractor_agreement_v1',obligation_id:`demo_obligation_${runId}`,
    invoice_id:`demo_invoice_${runId}`,milestone_id:'fictional_delivery_01',
    delivery_sha256:createHash('sha256').update('Fictional contractor delivery fixture. No customer obligation.').digest('hex'),
    recipient:recipient.toBase58(),lamports:1000000,cluster:'devnet'});
  let workflow;
  const executor=createExecutor({wallet,recipient,chain,now,decide:input=>{
    const state=workflow.snapshot();
    return decide(structuredClone(input),{agreement:state.agreement,acceptanceGate:state.approval?.acceptanceGate});
  }});
  workflow=createContractorWorkflow({agreement,trustedOwnerKey,executor,now});
  const ownerConsole=Object.freeze({async accept() {
    const policy=await contractorPolicy();
    const record={schema_version:'krafthaus_owner_acceptance_v1',agreement_hash:await policy.agreementHash(agreement),accepted_at:new Date(now()).toISOString()};
    return {...record,signature_base64:sign(null,policy.acceptanceSigningBytes(record),owner.privateKey).toString('base64')};
  }});
  const server=createContractorServer({workflow,chain});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});
  const url=`http://127.0.0.1:${server.address().port}`;
  const ready={status:'ready',url,cluster:'devnet',signer:'ephemeral-process-only',ownerAcceptance:'awaiting_explicit_owner_console_accept',...workflow.snapshot()};
  if(operatorOutput) operatorOutput.write(JSON.stringify(ready)+'\n');
  if(operatorInput) {
    const lines=readline.createInterface({input:operatorInput,terminal:false});
    lines.on('line',async command=>{
      if(command.trim()!=='accept') {if(operatorOutput) operatorOutput.write(JSON.stringify({type:'owner_console',code:'ACCEPT_COMMAND_REQUIRED'})+'\n');return;}
      try {const acceptance=await ownerConsole.accept();if(operatorOutput) operatorOutput.write(JSON.stringify({type:'owner_acceptance',acceptance})+'\n');}
      catch {if(operatorOutput) operatorOutput.write(JSON.stringify({type:'owner_console',code:'OWNER_ACCEPTANCE_UNAVAILABLE'})+'\n');}
    });
    server.once('close',()=>lines.close());
  }
  return Object.freeze({server,workflow,url,ownerConsole,ready:structuredClone(ready)});
}

if(require.main===module) {
  startContractorDemo({port:Number(process.env.SOLANA_CONTRACTOR_LOCAL_PORT || 0),operatorInput:process.stdin,operatorOutput:process.stdout})
    .then(demo=>{for(const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>demo.server.close(()=>process.exit(0)));})
    .catch(()=>{console.error('CONTRACTOR_DEMO_START_FAILED');process.exitCode=1;});
}
module.exports={createContractorServer,startContractorDemo};
