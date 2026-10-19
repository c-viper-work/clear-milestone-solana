/* Called by check-frontend.py with independent contract-derived test vectors. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');
const fixture = JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const context = vm.createContext({console,TextEncoder,TextDecoder,Uint8Array,DataView,ArrayBuffer,Buffer,crypto:webcrypto,setTimeout,clearTimeout,setInterval,clearInterval,URL,AbortSignal,fetch});
vm.runInContext(fs.readFileSync('app/vendor/solana-web3-1.98.4.min.js','utf8'),context);
const appSource=fs.readFileSync('app/app.js','utf8');
vm.runInContext(appSource,context);
const C=context.ClearMilestone, W=context.solanaWeb3;
const json=v=>JSON.parse(JSON.stringify(v));
let checks=0;
function check(fn){fn();checks++;}
async function reject(fn,pattern){await assert.rejects(fn,pattern);checks++;}
(async()=>{
 check(()=>{
   const browserSource=fs.readFileSync('scripts/check-frontend-browser.cjs','utf8');
   const readyText=browserSource.match(/getByText\('([^']*Ready\.[^']*)'/)?.[1];
   assert(readyText && appSource.includes(readyText),'App must include the readiness text awaited by the browser check');
 });
 check(()=>assert.deepEqual(json(C.SCHEMA),fixture.schemas));
 check(()=>assert.deepEqual(json(C.ACCOUNT_FIELDS),fixture.fields));
 check(()=>assert.equal(C.SPACE,fixture.space));
 context.phantom={solana:{connect(){}}};context.solflare={connect(){}};context.backpack={connect(){}};
 check(()=>assert.equal(C.walletProvider('Phantom'),context.phantom.solana));
 check(()=>assert.equal(C.walletProvider('Solflare'),context.solflare));
 check(()=>assert.equal(C.walletProvider('Backpack'),context.backpack));
 context.backpack={solana:{connect(){}}};check(()=>assert.equal(C.walletProvider('Backpack'),context.backpack.solana));
 const args={...fixture.values};for(const name of ['spec_hash','deliverable_hash','dispute_hash'])args[name]=Uint8Array.from(args[name]);
 for(const [name,hex] of Object.entries(fixture.vectors)){const encoded=await C.encodeInstruction(name,args);check(()=>assert.equal(C.hex(encoded),hex));}
 check(()=>assert.equal(C.hex(C.le('-9223372036854775808',8,true)),'0000000000000080'));
 for(const n of ['18446744073709551616','-1','1.1','1e3'])check(()=>assert.throws(()=>C.le(n,8)));
 check(()=>assert.equal(C.sol('18446744073.709551615'),(1n<<64n)-1n));
 check(()=>assert.throws(()=>C.sol('0.0000000001')));
 const hash=await C.sha256(new TextEncoder().encode('abc'));check(()=>assert.equal(C.hex(hash),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'));
 await reject(()=>C.encodeInstruction('submit_deliverable',{...args,deliverable_uri:'ż'.repeat(65)}),/128/);
 const program=new W.PublicKey(fixture.program),address=new W.PublicKey(fixture.pda);
 const parties=Object.fromEntries(['client','contractor','arbiter'].map(r=>[r,new W.PublicKey(fixture[r])]));
 const [derived,bump]=C.pda(program,parties.client,parties.contractor,args.sprint_id);
 check(()=>assert.equal(derived.toBase58(),fixture.pda));check(()=>assert.equal(bump,fixture.bump));
 for(const account of fixture.accounts){
  const info={owner:program,data:Buffer.from(account.hex,'hex')};const result=await C.decodeAccount(info,address,program);
  check(()=>assert.equal(result.sprint_id,(1n<<64n)-1n));check(()=>assert.equal(result.amount_lamports,(1n<<64n)-1n));
  check(()=>assert.equal(result.deliverable_uri,account.uri));check(()=>assert.equal(C.hex(result.dispute_hash),'cd'.repeat(32)));
  check(()=>assert.equal(result.created_at,-123n));check(()=>assert.equal(result.status,5));check(()=>assert.equal(result.bump,fixture.bump));
 }
 const valid=Buffer.from(fixture.accounts[1].hex,'hex');
 await reject(()=>C.decodeAccount({owner:parties.client,data:valid},address,program),/owner/);
 const badDisc=Buffer.from(valid);badDisc[0]^=1;
 await reject(()=>C.decodeAccount({owner:program,data:badDisc},address,program),/discriminator/);
 await reject(()=>C.decodeAccount({owner:program,data:valid.subarray(0,385)},address,program),/386/);
 const badLength=Buffer.from(valid);badLength.writeUInt32LE(129,220);
 await reject(()=>C.decodeAccount({owner:program,data:badLength},address,program),/URI/);
 const badUTF=Buffer.from(valid);badUTF[224]=255;
 await reject(()=>C.decodeAccount({owner:program,data:badUTF},address,program),/encoded|encoding/i);
 await reject(()=>C.decodeAccount({owner:program,data:valid},parties.client,program),/PDA/);
 const badBump=Buffer.from(valid);badBump[257+Buffer.byteLength(fixture.accounts[1].uri)]^=1;
 await reject(()=>C.decodeAccount({owner:program,data:badBump},address,program),/PDA/);
 for(const name of Object.keys(fixture.schemas)){
  const ix=await C.instruction(name,args,program,address,parties.contractor,parties);
  const init=name==='initialize_sprint';const expected=init?fixture.metas.initialize:fixture.metas.act;
  check(()=>assert.deepEqual(json(ix.keys.map(k=>[k.isWritable,k.isSigner])),expected.map(k=>k.slice(1))));
  check(()=>assert.deepEqual(ix.keys.map(k=>k.pubkey.toBase58()).join(','),(init?[address,parties.client,parties.contractor,parties.arbiter,W.SystemProgram.programId]:[address,parties.contractor,parties.client,parties.contractor,parties.arbiter]).map(k=>k.toBase58()).join(',')));
  check(()=>assert.equal(C.hex(ix.data),fixture.vectors[name]));
  const tx=new W.Transaction({recentBlockhash:fixture.program,feePayer:parties.client}).add(ix);
  const parsed=W.Transaction.from(tx.serialize({requireAllSignatures:false,verifySignatures:false}));
  check(()=>assert.equal(C.hex(parsed.instructions[0].data),fixture.vectors[name]));
 }
 const actions=['submit_deliverable','approve_deliverable','claim_after_timeout','cancel_before_submission','raise_dispute','resolve_dispute'];
 for(const line of fixture.oracle){const [kind,...v]=line.split(',');if(kind==='A'){const [status,role,now,action,ok]=v;check(()=>assert.equal(C.allowed(actions[Number(action)],{status:Number(status),auto_release_at:100n},['client','contractor','arbiter','stranger'][Number(role)],BigInt(now)),ok==='true',line));}else{const [amount,share,contractor,client,fee]=v;const out=C.payouts({amount_lamports:BigInt(amount),kill_fee_bps:5000,arbiter_fee_bps:500},share);check(()=>assert.equal([out.contractor,out.client,out.fee].join(','),[contractor,client,fee].join(',')));check(()=>assert.equal(out.kill+out.refund,BigInt(amount)));}}
 check(()=>assert.equal(C.safeURI('javascript:alert(1)'),null));check(()=>assert.equal(C.safeURI('data:text/html,x'),null));check(()=>assert.equal(C.safeURI('https://example.test/a'),'https://example.test/a'));
 check(()=>assert.equal(C.losslessJSON(JSON.stringify({memo:'123 and "value": 999'}).replace('}',',"value":18446744073709551615}')).value,'18446744073709551615'));
 check(()=>assert.equal(C.losslessJSON('{"memo":"18446744073709551615"}').memo,'18446744073709551615'));
 const kp=W.Keypair.generate();const signer={keypair:kp,publicKey:kp.publicKey};const ix=W.SystemProgram.transfer({fromPubkey:kp.publicKey,toPubkey:parties.client,lamports:1n});
 let sends=0,signs=0,broadcasts=[],confirmation='ok',sendFailure=false,localSignature;
 for(const [bytes,encoded] of fixture.signature_vectors)check(()=>assert.equal(C.base58(Uint8Array.from(bytes)),encoded));
 const conn={getGenesisHash:async()=>C.DEVNET_GENESIS,getLatestBlockhash:async()=>({blockhash:fixture.program,lastValidBlockHeight:123}),sendRawTransaction:async bytes=>{sends++;const tx=W.Transaction.from(bytes);assert(tx.verifySignatures());localSignature=C.base58(tx.signature);if(sendFailure)throw new Error('broadcast response lost');return localSignature;},confirmTransaction:async()=>{assert.equal(broadcasts.at(-1),localSignature);if(confirmation==='timeout')throw new Error('confirmation timeout');return {value:{err:confirmation==='fail'?{InstructionError:[0,'Custom']}:null}};}};
 await C.sendTransaction(conn,ix,signer,s=>broadcasts.push(s));check(()=>assert.equal(sends,1));
 const wallet={publicKey:kp.publicKey,provider:{signTransaction:async()=>{signs++;throw new Error('User rejected request');}}};
 await reject(()=>C.sendTransaction(conn,ix,wallet,()=>{}),/rejected/);check(()=>assert.equal(sends,1));
 await reject(()=>C.sendTransaction({...conn,getGenesisHash:async()=> 'mainnet'},ix,wallet,()=>{}),/Wrong network/);check(()=>assert.equal(signs,1));
 for(const mode of ['timeout','fail']){confirmation=mode;await reject(()=>C.sendTransaction(conn,ix,signer,s=>broadcasts.push(s)),/Signature: [1-9A-HJ-NP-Za-km-z]+.*Check Explorer/);}
 check(()=>assert.equal(sends,3));
 const changed={publicKey:kp.publicKey,provider:{signTransaction:async tx=>{tx.add(ix);return tx;}}};
 await reject(()=>C.sendTransaction(conn,ix,changed,()=>{}),/changed/);check(()=>assert.equal(sends,3));
 sendFailure=true;
 await reject(()=>C.sendTransaction(conn,ix,signer,s=>broadcasts.push(s)),/broadcast response lost.*Signature: [1-9A-HJ-NP-Za-km-z]+.*Check Explorer before retrying; this transaction may already have landed/);
 check(()=>assert.equal(broadcasts.at(-1),localSignature));check(()=>assert.equal(broadcasts.length,4));
 // External wallet signing exercises the same locally extracted signature path.
 const external={publicKey:kp.publicKey,provider:{signTransaction:async tx=>{tx.sign(kp);return tx;}}};
 await reject(()=>C.sendTransaction(conn,ix,external,s=>broadcasts.push(s)),/broadcast response lost.*Check Explorer/);
 check(()=>assert.equal(broadcasts.at(-1),localSignature));
 C.distinctParties(address,parties);
 const keys=[address,parties.client,parties.contractor,parties.arbiter];
 for(let i=0;i<4;i++)for(let j=i+1;j<4;j++){const k=[...keys];k[j]=k[i];check(()=>assert.throws(()=>C.distinctParties(k[0],{client:k[1],contractor:k[2],arbiter:k[3]}),/distinct/));}
 let balances={},lengths={},reads=[];
 const rentConn={...conn,getAccountInfo:async key=>{reads.push(key.toBase58());const k=key.toBase58();return Object.hasOwn(balances,k)?{lamports:balances[k],data:Buffer.alloc(lengths[k]||0)}:null;},getMinimumBalanceForRentExemption:async len=>100+len*10,getFeeForMessage:async()=>({value:5})};
 const state={...parties,amount_lamports:20n,kill_fee_bps:5000,arbiter_fee_bps:500};
 for(const name of ['approve_deliverable','claim_after_timeout','cancel_before_submission','resolve_dispute']){
   balances={};lengths={};reads=[];
   const topups=await C.settlementTopups(rentConn,name,state,{contractor_share_bps:'5000'},kp.publicKey);
   const expected=name==='cancel_before_submission'?{contractor:90n,client:90n}:name==='resolve_dispute'?{contractor:91n,client:90n,arbiter:99n}:{contractor:80n};
   check(()=>assert.equal(topups.length,Object.keys(expected).length));
   for(const transfer of topups){const t=W.SystemInstruction.decodeTransfer(transfer);const role=Object.keys(expected).find(r=>parties[r].equals(t.toPubkey));check(()=>assert.equal(t.lamports,expected[role]));check(()=>assert(t.fromPubkey.equals(kp.publicKey)));}
 }
 balances={[fixture.contractor]:79};
 let topups=await C.settlementTopups(rentConn,'approve_deliverable',state,{},kp.publicKey);
 check(()=>assert.equal(W.SystemInstruction.decodeTransfer(topups[0]).lamports,1n));
 for(const balance of [80,81]){balances[fixture.contractor]=balance;check(()=>assert.equal(balance+20>=100,true));const t=await C.settlementTopups(rentConn,'approve_deliverable',state,{},kp.publicKey);check(()=>assert.equal(t.length,0));}
 lengths[fixture.contractor]=8;balances[fixture.contractor]=80;
 topups=await C.settlementTopups(rentConn,'approve_deliverable',state,{},kp.publicKey);
 check(()=>assert.equal(W.SystemInstruction.decodeTransfer(topups[0]).lamports,80n));
 await reject(()=>C.settlementTopups(rentConn,'claim_after_timeout',state,{},parties.contractor),/needs 80 lamports.*Fund this signer/);
 reads=[];
 await C.settlementTopups(rentConn,'resolve_dispute',{...state,arbiter_fee_bps:0},{contractor_share_bps:'0'},kp.publicKey);
 check(()=>assert.deepEqual(reads,[fixture.client]));
 reads=[];const noTopups=await C.settlementTopups(rentConn,'raise_dispute',state,{},kp.publicKey);check(()=>assert.equal(noTopups.length,0));check(()=>assert.equal(reads.length,0));
 balances[fixture.contractor]=Number.MAX_SAFE_INTEGER+1;
 await reject(()=>C.settlementTopups(rentConn,'approve_deliverable',state,{},kp.publicKey),/precision/);
 balances[kp.publicKey.toBase58()]=184;
 const sendsBefore=sends;
 await reject(()=>C.sendTransaction(rentConn,ix,signer,()=>{},topups),/needs 1 additional lamports.*top-ups 80, fee 5, retained rent 100/);
 check(()=>assert.equal(sends,sendsBefore));
 balances[kp.publicKey.toBase58()]=185;sendFailure=false;confirmation='ok';
 const ordered={...rentConn,sendRawTransaction:async bytes=>{const tx=W.Transaction.from(bytes);check(()=>assert.equal(tx.instructions.length,2));check(()=>assert.equal(W.SystemInstruction.decodeTransfer(tx.instructions[0]).lamports,80n));check(()=>assert.equal(C.hex(tx.instructions[1].data),C.hex(ix.data)));localSignature=C.base58(tx.signature);return localSignature;}};
 await C.sendTransaction(ordered,ix,signer,s=>broadcasts.push(s),topups);
 console.log(`PASS: ${checks} offline checks; 7 Rust-derived Borsh/discriminator vectors, independent PDA, account layouts, real Rust role/state/time oracle, exact payouts, four-address uniqueness, recipient rent top-ups, wallet rejection and broadcast/confirmation failures.`);
 console.log('No Devnet transaction or deployment was performed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
