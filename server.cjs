const http=require('node:http');const fs=require('node:fs');const path=require('node:path');
const {Keypair,Transaction,SystemProgram}=require('@solana/web3.js');
const {createExecutor,DEVNET_GENESIS}=require('./executor.cjs');
const {createDevnetChain}=require('./chain.cjs');

function createDemoServer({executor,chain}) {
  let fundingAttempted=false;let funding={status:'not_requested'};
  const server=http.createServer(async(req,res)=>{
    const origin=`http://127.0.0.1:${server.address().port}`;
    const reply=(status,body)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(body))};
    if(req.headers.host!==`127.0.0.1:${server.address().port}` || (req.headers.origin && req.headers.origin!==origin)) return reply(403,{code:'LOCAL_ORIGIN_REQUIRED'});
    try {
      const url=new URL(req.url,origin);
      if(req.method==='GET' && url.pathname==='/api/state') return reply(200,{policy:executor.policy,balanceLamports:await chain.balance(executor.policy.sender),funding});
      if(req.method==='GET' && url.pathname==='/api/receipt') return reply(200,await executor.receipt(url.searchParams.get('id')));
      if(req.method==='GET' && ['/','/app.js','/style.css'].includes(url.pathname)) {
        const file=url.pathname==='/'?'index.html':url.pathname.slice(1);
        if(!fs.existsSync(path.join(__dirname,file))) return reply(404,{code:'UI_NOT_BUILT'});
        res.writeHead(200,{'content-type':file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.js')?'application/javascript':'text/css',
          'cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"});
        return fs.createReadStream(path.join(__dirname,file)).pipe(res);
      }
      if(req.method!=='POST') return reply(404,{code:'NOT_FOUND'});
      if(req.headers['content-type']!=='application/json' || req.headers['x-demo-intent']!=='devnet-only') return reply(403,{code:'DEMO_INTENT_REQUIRED'});
      let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>8192) return reply(413,{code:'BODY_TOO_LARGE'})}
      let body;try{body=JSON.parse(text)}catch{return reply(400,{code:'INVALID_JSON'})}
      if(url.pathname==='/api/prepare') return reply(200,await executor.prepare(body));
      if(url.pathname==='/api/execute') return reply(200,await executor.execute(body));
      if(url.pathname==='/api/fund') {
        if(fundingAttempted) return reply(200,funding);
        fundingAttempted=true;funding={status:'requesting'};
        try {funding={status:'requested',signature:await chain.fund(executor.policy.sender)}}
        catch(error){funding={status:'unavailable',code:/^DEVNET_(HTTP|RPC)_[-0-9]+$/.test(error.message)?error.message:'FAUCET_UNAVAILABLE'}}
        return reply(200,funding);
      }
      if(url.pathname==='/api/tamper') {
        const tx=Transaction.from(Buffer.from(body.transactionBase64,'base64'));
        const transfer=tx.instructions[0];
        const recipient=body.kind==='recipient'?Keypair.generate().publicKey:transfer.keys[1].pubkey;
        const lamports=body.kind==='amount'?999999:1000000;
        if(!['amount','recipient'].includes(body.kind)) return reply(400,{code:'INVALID_MUTATION'});
        tx.instructions[0]=SystemProgram.transfer({fromPubkey:transfer.keys[0].pubkey,toPubkey:recipient,lamports});
        return reply(200,await executor.execute({id:body.id,transactionBase64:tx.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64')}));
      }
      return reply(404,{code:'NOT_FOUND'});
    } catch {return reply(503,{status:'unavailable',code:'DEMO_DEPENDENCY_UNAVAILABLE'})}
  });
  return server;
}

async function startDemo() {
  const chain=createDevnetChain();
  if(await chain.genesis()!==DEVNET_GENESIS) throw new Error('DEVNET_REQUIRED');
  const wallet=Keypair.generate();const recipient=Keypair.generate().publicKey;
  async function decide(input) {
    const response=await fetch('https://www.krafthaus.app/api/solana-decision',{method:'POST',headers:{'content-type':'application/json','origin':'https://www.krafthaus.app'},
      body:JSON.stringify({proposalName:'Devnet agent payout to server-allowlisted recipient',daoName:'Fictional local test mandate',solAmount:input.lamports/1000000000,
        riskLevel:'low',evidenceLevel:'strong',quorumSigned:true,budgetWithinPolicy:input.lamports<=1000000,recipientVerified:input.recipient===recipient.toBase58()}),signal:AbortSignal.timeout(15000)});
    const body=await response.json();if(!response.ok || !body.ok) throw new Error('DECIDE_UNAVAILABLE');
    return body.decision;
  }
  const executor=createExecutor({wallet,recipient,chain,decide});
  const server=createDemoServer({executor,chain});
  const requestedPort=Number(process.env.SOLANA_DEMO_LOCAL_PORT || 0);
  await new Promise(r=>server.listen(requestedPort,'127.0.0.1',r));
  console.log(JSON.stringify({status:'ready',url:`http://127.0.0.1:${server.address().port}`,cluster:'devnet',signer:'ephemeral-process-only',maxTransferLamports:1000000,totalLimitLamports:3000000}));
  for(const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>server.close(()=>process.exit(0)));
}
if(require.main===module) startDemo().catch(()=>{console.error('DEVNET_DEMO_START_FAILED');process.exitCode=1});
module.exports={createDemoServer,startDemo};
