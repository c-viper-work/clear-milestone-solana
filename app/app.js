/* ClearMilestone browser client. No private keys are persisted or exported. */
(function (root) {
  'use strict';
  const UTF8 = new TextEncoder();
  const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
  const PLACEHOLDER = 'Fg6PaFpoGXkYsidMpWxTWqkZ7FEfcYkgMQHGdVQJQ5yQ';
  const SPACE = 386;
  const STATUS = ['Funded', 'Submitted', 'Released', 'Auto released', 'Cancelled', 'Disputed', 'Resolved'];
  // This schema is checked against the actual Rust signatures by scripts/check-frontend.py.
  const SCHEMA = {
    initialize_sprint: [['sprint_id', 'u64'], ['amount_lamports', 'u64'], ['kill_fee_bps', 'u16'], ['arbiter_fee_bps', 'u16'], ['review_window_secs', 'i64'], ['spec_hash', '[u8;32]']],
    submit_deliverable: [['deliverable_hash', '[u8;32]'], ['deliverable_uri', 'String']],
    approve_deliverable: [], claim_after_timeout: [], cancel_before_submission: [],
    raise_dispute: [['dispute_hash', '[u8;32]']], resolve_dispute: [['contractor_share_bps', 'u16']]
  };
  const ACCOUNT_FIELDS = [['client','Pubkey'],['contractor','Pubkey'],['arbiter','Pubkey'],['sprint_id','u64'],['amount_lamports','u64'],['kill_fee_bps','u16'],['arbiter_fee_bps','u16'],['review_window_secs','i64'],['created_at','i64'],['submitted_at','i64'],['auto_release_at','i64'],['spec_hash','[u8;32]'],['deliverable_hash','[u8;32]'],['deliverable_uri','String'],['dispute_hash','[u8;32]'],['status','u8'],['bump','u8']];
  function assert(ok, message) { if (!ok) throw new Error(message); }
  function integer(value, min, max) {
    assert(typeof value === 'bigint' || (typeof value === 'string' && /^-?\d+$/.test(value)), 'Enter an integer without decimals or exponent notation.');
    const n = BigInt(value); assert(n >= min && n <= max, `Integer outside ${min}…${max}.`); return n;
  }
  function le(value, size, signed = false) {
    const bits = BigInt(size * 8), min = signed ? -(1n << (bits - 1n)) : 0n;
    let n = integer(value, min, signed ? (1n << (bits - 1n)) - 1n : (1n << bits) - 1n);
    n = BigInt.asUintN(size * 8, n);
    const out = new Uint8Array(size);
    for (let i = 0; i < size; i++) { out[i] = Number(n & 255n); n >>= 8n; }
    return out;
  }
  function concat(...arrays) { const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0)); let i = 0; for (const a of arrays) { out.set(a, i); i += a.length; } return out; }
  async function sha256(bytes) { assert(root.crypto?.subtle, 'WebCrypto requires HTTPS or http://localhost.'); return new Uint8Array(await root.crypto.subtle.digest('SHA-256', bytes)); }
  async function discriminator(name) { return (await sha256(UTF8.encode(name))).slice(0, 8); }
  const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  async function encodeInstruction(name, args = {}) {
    assert(Object.hasOwn(SCHEMA, name), 'Unknown instruction.');
    const parts = [await discriminator(`global:${name}`)];
    for (const [field, type] of SCHEMA[name]) {
      const v = args[field];
      if (type === 'String') { assert(typeof v === 'string', 'URI must be text.'); const b = UTF8.encode(v); assert(b.length <= 128, 'URI exceeds 128 UTF-8 bytes.'); parts.push(le(BigInt(b.length), 4), b); }
      else if (type === '[u8;32]') { assert(v instanceof Uint8Array && v.length === 32, `${field} must be 32 bytes.`); parts.push(v); }
      else parts.push(le(v, type === 'u16' ? 2 : 8, type === 'i64'));
    }
    return concat(...parts);
  }
  function sdk() { assert(root.solanaWeb3, 'Solana library unavailable.'); return root.solanaWeb3; }
  function pda(program, client, contractor, sprintId) { return sdk().PublicKey.findProgramAddressSync([UTF8.encode('sprint'), client.toBytes(), contractor.toBytes(), le(sprintId, 8)], program); }
  async function decodeAccount(info, address, program) {
    assert(info && info.owner.equals(program), 'Account owner does not match the selected program.');
    const b = new Uint8Array(info.data); assert(b.length === SPACE, `SprintEscrow must be ${SPACE} bytes.`);
    assert(hex(b.slice(0, 8)) === hex(await discriminator('account:SprintEscrow')), 'Invalid SprintEscrow discriminator.');
    const d = new DataView(b.buffer, b.byteOffset, b.byteLength); let offset = 8; const out = {};
    for (const [field, type] of ACCOUNT_FIELDS) {
      if (type === 'Pubkey') { out[field] = new (sdk().PublicKey)(b.slice(offset, offset + 32)); offset += 32; }
      else if (type === '[u8;32]') { out[field] = b.slice(offset, offset + 32); offset += 32; }
      else if (type === 'String') { const length = d.getUint32(offset, true); offset += 4; assert(length <= 128 && offset + length + 34 <= b.length, 'Invalid URI length.'); out[field] = new TextDecoder('utf-8', {fatal:true}).decode(b.slice(offset, offset + length)); offset += length; }
      else if (type === 'u64' || type === 'i64') { out[field] = type === 'i64' ? d.getBigInt64(offset, true) : d.getBigUint64(offset, true); offset += 8; }
      else if (type === 'u16') { out[field] = d.getUint16(offset, true); offset += 2; }
      else { out[field] = d.getUint8(offset++); }
    }
    assert(out.status <= 6, 'Unknown account status.');
    const [expected, bump] = pda(program, out.client, out.contractor, out.sprint_id);
    assert(expected.equals(address) && bump === out.bump, 'Account PDA seeds or bump mismatch.');
    return out;
  }
  async function instruction(name, args, program, address, actor, parties) {
    const {TransactionInstruction, SystemProgram} = sdk();
    const meta = (pubkey, isWritable, isSigner = false) => ({pubkey, isWritable, isSigner});
    const keys = name === 'initialize_sprint'
      ? [meta(address,true),meta(parties.client,true,true),meta(parties.contractor,false),meta(parties.arbiter,false),meta(SystemProgram.programId,false)]
      : [meta(address,true),meta(actor,false,true),meta(parties.client,true),meta(parties.contractor,true),meta(parties.arbiter,true)];
    // web3.js accepts Uint8Array at runtime; no global Buffer shim is necessary.
    return new TransactionInstruction({programId:program,keys,data:await encodeInstruction(name,args)});
  }
  function roleFor(account, key) { return key ? ['client','contractor','arbiter'].find(r => account[r].equals(key)) || 'stranger' : 'stranger'; }
  function allowed(name, s, role, now) {
    if (!s) return false;
    switch (name) {
      case 'submit_deliverable': return role === 'contractor' && s.status === 0;
      case 'approve_deliverable': return role === 'client' && [0,1].includes(s.status);
      case 'cancel_before_submission': return role === 'client' && s.status === 0;
      case 'claim_after_timeout': return role === 'contractor' && s.status === 1 && now !== null && now >= s.auto_release_at;
      case 'raise_dispute': return ['client','contractor'].includes(role) && s.status === 1 && now !== null && now < s.auto_release_at;
      case 'resolve_dispute': return role === 'arbiter' && s.status === 5;
      default: return false;
    }
  }
  function payouts(s, share) {
    const principal = s.amount_lamports;
    const kill = principal * BigInt(s.kill_fee_bps) / 10000n, fee = principal * BigInt(s.arbiter_fee_bps) / 10000n;
    const contractor = (principal - fee) * integer(share,0n,10000n) / 10000n;
    return {kill, refund:principal-kill, fee, contractor, client:principal-fee-contractor};
  }
  function sol(value) { assert(/^\d+(\.\d{1,9})?$/.test(value), 'SOL amount must have at most 9 decimal places.'); const [a,b=''] = value.split('.'); return integer(BigInt(a)*1000000000n+BigInt(b.padEnd(9,'0')),0n,(1n<<64n)-1n); }
  function formatSol(n) { return `${n/1000000000n}.${(n%1000000000n).toString().padStart(9,'0').replace(/0+$/,'') || '0'} SOL`; }
  function safeURI(value) { try { const u = new URL(value); return ['https:','http:'].includes(u.protocol) ? u.href : null; } catch { return null; } }
  const explorer = (kind,value) => `https://explorer.solana.com/${kind}/${encodeURIComponent(value)}?cluster=devnet`;
  // Tokenize JSON strings/numbers together so numeric text inside strings is never altered.
  // RPC integers (including balances > 2^53) are preserved as decimal strings.
  function losslessJSON(text) { return JSON.parse(text.replace(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, token => token[0] === '"' || /[.eE]/.test(token) ? token : `"${token}"`)); }
  async function rpc(url, method, params = []) {
    const response = await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(20000)});
    assert(response.ok, `RPC HTTP ${response.status}. Devnet may be rate limited; try again later.`);
    const data = losslessJSON(await response.text()); assert(!data.error, data.error?.message || 'RPC error.'); return data.result;
  }
  async function verifyDevnet(connection) { assert(await connection.getGenesisHash() === DEVNET_GENESIS, 'Wrong network: only Solana Devnet is allowed.'); }
  function walletProvider(name) {
    if(name==='Phantom')return root.phantom?.solana || (root.solana?.isPhantom ? root.solana : null);
    if(name==='Solflare')return root.solflare;
    if(name==='Backpack')return root.backpack?.solana || (root.backpack?.connect ? root.backpack : null) || (root.solana?.isBackpack ? root.solana : null);
    return null;
  }
  function distinctParties(address, parties) {
    assert(new Set([address,parties.client,parties.contractor,parties.arbiter].map(k=>k.toBase58())).size === 4, 'Escrow, client, contractor and arbiter must be distinct.');
  }
  function exactLamports(n) {
    assert(Number.isSafeInteger(n) && n >= 0, 'RPC balance/rent/fee exceeds exact integer precision; use a lossless RPC client before retrying.');
    return BigInt(n);
  }
  async function settlementTopups(connection, name, account, args, payer) {
    let amounts;
    if (['approve_deliverable','claim_after_timeout'].includes(name)) amounts={contractor:account.amount_lamports};
    else if (name==='cancel_before_submission') { const p=payouts(account,'0'); amounts={contractor:p.kill,client:p.refund}; }
    else if (name==='resolve_dispute') { const p=payouts(account,args.contractor_share_bps); amounts={contractor:p.contractor,client:p.client,arbiter:p.fee}; }
    else return [];
    const instructions=[];
    for (const [role,amount] of Object.entries(amounts)) {
      if (amount===0n) continue;
      const key=account[role], info=await connection.getAccountInfo(key,'confirmed');
      const balance=info ? exactLamports(info.lamports) : 0n;
      const rent=exactLamports(await connection.getMinimumBalanceForRentExemption(info?.data.length || 0));
      const deficit=rent-balance-amount;
      if (deficit<=0n) continue;
      assert(!key.equals(payer), `Recipient ${role} ${key.toBase58()} needs ${deficit} lamports before settlement. Fund this signer from another account, then refresh and retry.`);
      instructions.push(sdk().SystemProgram.transfer({fromPubkey:payer,toPubkey:key,lamports:deficit}));
    }
    return instructions;
  }
  function base58(bytes) {
    const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let n=0n, result='', zeros=0;
    for (const b of bytes) n=n*256n+BigInt(b);
    while (n) { result=alphabet[Number(n%58n)]+result; n/=58n; }
    while (zeros<bytes.length && bytes[zeros]===0) zeros++;
    return '1'.repeat(zeros)+result;
  }
  async function sendTransaction(connection, ix, signer, onBroadcast, topups = []) {
    await verifyDevnet(connection);
    const latest = await connection.getLatestBlockhash('confirmed');
    const tx = new (sdk().Transaction)({...latest,feePayer:signer.publicKey}).add(...topups,ix);
    if (topups.length) {
      const fee=await connection.getFeeForMessage(tx.compileMessage(),'confirmed');
      assert(fee.value!==null, 'Fee estimate unavailable; refresh and retry before signing.');
      const info=await connection.getAccountInfo(signer.publicKey,'confirmed');
      const balance=info ? exactLamports(info.lamports) : 0n;
      const rent=exactLamports(await connection.getMinimumBalanceForRentExemption(info?.data.length || 0));
      const total=topups.reduce((sum,ix)=>sum+sdk().SystemInstruction.decodeTransfer(ix).lamports,0n);
      const required=total+exactLamports(fee.value)+rent;
      assert(balance>=required, `Signer ${signer.publicKey.toBase58()} needs ${required-balance} additional lamports: top-ups ${total}, fee ${fee.value}, retained rent ${rent}. Fund the signer, then refresh and retry.`);
    }
    const original = tx.serializeMessage();
    let signed;
    if (signer.keypair) { tx.sign(signer.keypair); signed = tx; }
    else { signed = await signer.provider.signTransaction(tx); assert(hex(signed.serializeMessage()) === hex(original), 'Wallet changed the transaction message.'); }
    assert(signed.signature?.length===64, 'Wallet did not provide a transaction signature.');
    const signature = base58(signed.signature);
    const raw = signed.serialize();
    await verifyDevnet(connection);
    let recorded=false;
    const record=()=>{ if (!recorded) { recorded=true; onBroadcast(signature); } };
    try {
      await connection.sendRawTransaction(raw,{skipPreflight:false,maxRetries:0,preflightCommitment:'confirmed'});
      record();
      const result = await connection.confirmTransaction({...latest,signature},'confirmed');
      assert(!result.value.err, `Transaction failed on chain: ${JSON.stringify(result.value.err)}`);
    } catch (error) { record(); throw new Error(`${error.message}. Signature: ${signature}. Check Explorer before retrying; this transaction may already have landed.`); }
    return signature;
  }
  const api = {SCHEMA,ACCOUNT_FIELDS,SPACE,STATUS,DEVNET_GENESIS,le,sha256,hex,discriminator,encodeInstruction,pda,decodeAccount,instruction,roleFor,allowed,payouts,sol,formatSol,safeURI,explorer,losslessJSON,verifyDevnet,walletProvider,sendTransaction,distinctParties,settlementTopups,base58};
  root.ClearMilestone = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document !== 'undefined') boot().catch(error => { const el = document.getElementById('feedback'); el.textContent = error.message; el.classList.add('error'); document.querySelectorAll('button').forEach(b => {b.disabled=true;}); });

  async function loadSDK() {
    if (root.solanaWeb3) return;
    const load = src => new Promise((resolve,reject) => {
      const script = document.createElement('script'); script.src=src;
      script.integrity='sha384-I45YF+S0YGWIolUyTksLk9TNtTqaDgZg8e6T1OoBoJvvFmphqYNIPZw3Kl0TkZNN'; script.crossOrigin='anonymous';
      const timeout = setTimeout(() => { script.remove(); reject(new Error('Solana script load timed out.')); },8000);
      script.onload=() => { clearTimeout(timeout); resolve(); }; script.onerror=() => { clearTimeout(timeout); script.remove(); reject(new Error('Solana script unavailable.')); };
      document.head.append(script);
    });
    try { await load('https://cdn.jsdelivr.net/npm/@solana/web3.js@1.98.4/lib/index.iife.min.js'); }
    catch { await load('vendor/solana-web3-1.98.4.min.js'); }
    assert(root.solanaWeb3, 'Solana client failed to load. Check the local vendor file.');
  }
  async function boot() {
    await loadSDK(); assert(root.crypto?.subtle,'Serve this page on HTTPS or http://localhost to enable WebCrypto.');
    const {PublicKey,Keypair,Connection,SystemProgram,SYSVAR_CLOCK_PUBKEY} = sdk();
    const $ = id => document.getElementById(id), value = id => $(id).value.trim();
    const rentNote=document.createElement('p');
    rentNote.textContent='Settlement automatically adds recipient rent top-ups paid by the current signer in the same transaction. The signer must cover top-ups, network fees and retained rent. If the signer itself needs a top-up, fund it from another account first.';
    $('feedback').after(rentNote);
    let signer=null, judges=null, loaded=null, chainNow=null, observedAt=0, busy=false, providerCleanup=null;
    const buttons = [...document.querySelectorAll('button')];
    function notice(message,error=false) { $('feedback').textContent=message; $('feedback').classList.toggle('error',error); }
    function log(message,signature) {
      const list=$('activity'); list.querySelector('.empty')?.remove();
      const li=document.createElement('li'),time=document.createElement('time'); time.textContent=new Date().toLocaleTimeString(); li.append(time,document.createTextNode(message));
      if (signature) { const a=document.createElement('a'); a.textContent=signature; a.href=explorer('tx',signature); a.target='_blank'; a.rel='noopener noreferrer'; li.append(a); }
      list.prepend(li);
    }
    function renderControls() {
      buttons.forEach(b => {b.disabled=busy;});
      $('create-judges').disabled=busy || !!judges;
      $('disconnect').disabled=busy || !signer;
      for (const id of ['airdrop','refresh-balance','transfer','use-signer']) $(id).disabled=busy || !signer;
      $('initialize').disabled=busy || !signer || !!loaded;
      const role=loaded ? roleFor(loaded.account,signer?.publicKey) : 'stranger';
      $('role-status').textContent=role.toUpperCase();
      document.querySelectorAll('[data-action]').forEach(b => { b.disabled=busy || !allowed(b.dataset.action,loaded?.account,role,chainNow); });
      document.querySelectorAll('[data-role]').forEach(b => {b.setAttribute('aria-pressed',String(signer?.keypair === judges?.[b.dataset.role] && !!judges));});
      $('signer').textContent=signer ? `${signer.label} · ${signer.publicKey.toBase58()}` : 'No signer connected';
    }
    async function run(fn) {
      if (busy) return; busy=true; renderControls();
      document.querySelectorAll('input,textarea').forEach(el=>{el.disabled=true;});
      notice('Working… Please wait for the result.');
      try { await fn(); }
      catch(error) { notice(error.message,true); log(error.message); }
      finally {busy=false;document.querySelectorAll('input,textarea').forEach(el=>{el.disabled=false;});renderControls();}
    }
    function bind(id,fn) { $(id).addEventListener('click',() => run(fn)); }
    function endpoint() { const url=new URL(value('rpc')); assert(url.protocol==='https:' || (url.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)), 'Use an HTTPS RPC URL (or localhost).'); return url.href; }
    async function connection() { const url=endpoint(); const conn=new Connection(url,{commitment:'confirmed',confirmTransactionInitialTimeout:45000}); await verifyDevnet(conn); return {url,conn}; }
    async function programContext() {
      const {url,conn}=await connection(), program=new PublicKey(value('program'));
      assert(program.toBase58()!==PLACEHOLDER,'The source ID is a placeholder. Enter your actual deployed program.');
      const info=await conn.getAccountInfo(program,'confirmed'); assert(info?.executable,'Selected program is not executable on Devnet.');
      return {url,conn,program};
    }
    function selection() { return {client:new PublicKey(value('client')),contractor:new PublicKey(value('contractor')),sprint_id:integer(value('sprint-id'),0n,(1n<<64n)-1n)}; }
    function clearLoaded() { loaded=null; chainNow=null; $('pda-link').hidden=true; $('state-badge').textContent='NOT LOADED'; $('observation').textContent='Selection changed. Derive PDA & refresh.'; $('account-summary').replaceChildren(); $('payouts').replaceChildren(); $('deadline').textContent=''; renderControls(); }
    for (const id of ['rpc','program','client','contractor','sprint-id']) $(id).addEventListener('input',clearLoaded);
    async function rawAccount(url,address) {
      const result=await rpc(url,'getAccountInfo',[address.toBase58(),{encoding:'base64',commitment:'confirmed'}]);
      if (!result.value) return {info:null,slot:result.context.slot};
      const v=result.value; assert(v.data[1]==='base64','Unexpected account encoding.');
      return {info:{owner:new PublicKey(v.owner),data:Uint8Array.from(atob(v.data[0]),c=>c.charCodeAt(0)),lamports:BigInt(v.lamports)},slot:result.context.slot};
    }
    function pair(dl,key,text,large=false) { const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=key;dd.textContent=text;if(large)dd.className='principal';dl.append(dt,dd);return dd; }
    function renderPayouts() {
      const box=$('payouts');box.replaceChildren(); if(!loaded) return;
      try {
        const s=loaded.account,p=payouts(s,value('share'));
        for (const [title,body] of [['Approval / timeout',`Contractor: ${formatSol(s.amount_lamports)}`],['Cancellation',`Contractor: ${formatSol(p.kill)} · Client: ${formatSol(p.refund)}`],['Dispute resolution preview',`Contractor: ${formatSol(p.contractor)} · Client: ${formatSol(p.client)} · Arbiter: ${formatSol(p.fee)}`]]) { const div=document.createElement('div'),strong=document.createElement('strong');div.className='payout';strong.textContent=title;div.append(strong,document.createTextNode(body));box.append(div); }
      } catch(error) {box.textContent=error.message;}
    }
    function renderState() {
      const s=loaded.account; $('state-badge').textContent=STATUS[s.status].toUpperCase();
      $('observation').textContent=`Confirmed slot ${loaded.slot} · observed ${new Date(observedAt).toLocaleString()}`;
      const dl=document.createElement('dl');
      pair(dl,'Recorded principal (not current balance)',formatSol(s.amount_lamports),true);
      pair(dl,'Current PDA balance',formatSol(loaded.lamports)); pair(dl,'Rent minimum (retained)',formatSol(loaded.rent));
      pair(dl,'Sprint ID',s.sprint_id.toString());
      for (const role of ['client','contractor','arbiter']) pair(dl,role[0].toUpperCase()+role.slice(1),s[role].toBase58());
      pair(dl,'Terms',`Kill ${s.kill_fee_bps} bps · Arbiter ${s.arbiter_fee_bps} bps · Review ${s.review_window_secs}s`);
      for (const field of ['spec_hash','deliverable_hash','dispute_hash']) pair(dl,field.replaceAll('_',' '),hex(s[field]));
      const uri=pair(dl,'Deliverable URI',s.deliverable_uri || 'Not submitted');const safe=safeURI(s.deliverable_uri);
      if(safe){const a=document.createElement('a');a.href=safe;a.textContent=s.deliverable_uri;a.target='_blank';a.rel='noopener noreferrer';uri.replaceChildren(a);}
      pair(dl,'Chain timestamps (Unix seconds)',`Created ${s.created_at} · Submitted ${s.submitted_at} · Deadline ${s.auto_release_at}`);
      $('account-summary').replaceChildren(dl);renderPayouts();updateDeadline();renderControls();
    }
    function updateDeadline() {
      if (!loaded || loaded.account.status!==1) { $('deadline').textContent='';return; }
      const estimated=chainNow+BigInt(Math.floor((Date.now()-observedAt)/1000)),left=loaded.account.auto_release_at-estimated;
      $('deadline').textContent=`Estimated review time: ${left>0n ? `${left}s remaining` : 'deadline reached'}. Last observed chain Clock: ${chainNow}. Refresh for action eligibility; the chain is authoritative.`;
    }
    async function refresh() {
      clearLoaded();
      const context=await programContext(), selected=selection();
      const [address]=pda(context.program,selected.client,selected.contractor,selected.sprint_id);
      const link=$('pda-link');link.href=explorer('address',address.toBase58());link.textContent=address.toBase58();link.hidden=false;
      const {info,slot}=await rawAccount(context.url,address);
      if(!info){$('state-badge').textContent='NOT CREATED';$('account-summary').textContent='No account at this PDA. The client can fund a new sprint.';$('payouts').replaceChildren();$('deadline').textContent='';$('observation').textContent=`Confirmed slot ${slot} · ${new Date().toLocaleString()}`;return {...context,address,selected};}
      const account=await decodeAccount(info,address,context.program);
      const [clock,rent]=await Promise.all([rawAccount(context.url,SYSVAR_CLOCK_PUBKEY),rpc(context.url,'getMinimumBalanceForRentExemption',[SPACE,{commitment:'confirmed'}])]);
      assert(clock.info?.data.length>=40,'Chain Clock unavailable.');
      chainNow=new DataView(clock.info.data.buffer,clock.info.data.byteOffset,clock.info.data.byteLength).getBigInt64(32,true);observedAt=Date.now();
      loaded={...context,address,account,slot,lamports:info.lamports,rent:BigInt(rent)};renderState();return {...context,address,selected};
    }
    async function balance() {
      assert(signer,'Connect a signer.');const current=signer;const {url}=await connection();const result=await rpc(url,'getBalance',[current.publicKey.toBase58(),{commitment:'confirmed'}]);
      if(signer===current)$('balance').textContent=`${formatSol(BigInt(result.value))} · slot ${result.context.slot}`;
    }
    function selectSigner(next) { providerCleanup?.();providerCleanup=null;signer=next;$('balance').textContent='Balance not fetched';renderControls(); }
    document.querySelectorAll('[data-wallet]').forEach(button=>button.addEventListener('click',()=>run(async()=>{
      const provider=walletProvider(button.dataset.wallet);assert(provider,`${button.dataset.wallet} extension not found. Install it or use judge signers.`);
      await provider.connect();assert(provider.publicKey && provider.signTransaction,'Wallet does not expose transaction signing.');
      selectSigner({publicKey:new PublicKey(provider.publicKey.toBytes()),provider,label:button.dataset.wallet});
      const changed=key=>{if(!key)selectSigner(null);else{signer={publicKey:new PublicKey(key.toBytes()),provider,label:button.dataset.wallet};$('balance').textContent='Balance not fetched';renderControls();}};
      const disconnected=()=>selectSigner(null);provider.on?.('accountChanged',changed);provider.on?.('disconnect',disconnected);
      providerCleanup=()=>{provider.removeListener?.('accountChanged',changed);provider.removeListener?.('disconnect',disconnected);};notice(`${button.dataset.wallet} connected. Transactions are locked to Devnet.`);
    })));
    bind('disconnect',async()=>{const provider=signer?.provider;selectSigner(null);await provider?.disconnect();notice('Signer disconnected. Judge keys remain available until reload.');});
    function fillJudges(){for(const role of ['client','contractor','arbiter'])$(role).value=judges[role].publicKey.toBase58();clearLoaded();}
    bind('create-judges',async()=>{assert(!judges,'Judge keys already exist.');judges={client:Keypair.generate(),contractor:Keypair.generate(),arbiter:Keypair.generate()};$('judge-roles').hidden=false;fillJudges();selectSigner({keypair:judges.client,publicKey:judges.client.publicKey,label:'Judge Client'});notice('Three in-memory judge signers created. Reloading loses their keys.');});
    bind('fill-judges',async()=>{fillJudges();notice('Judge public keys copied into the agreement.');});
    document.querySelectorAll('[data-role]').forEach(button=>button.addEventListener('click',()=>run(async()=>{const keypair=judges[button.dataset.role];selectSigner({keypair,publicKey:keypair.publicKey,label:`Judge ${button.dataset.role}`});notice(`Active signer: ${button.dataset.role}.`);})));
    bind('use-signer',async()=>{$('client').value=signer.publicKey.toBase58();clearLoaded();notice('Active signer set as client.');});
    bind('refresh-balance',async()=>{await balance();notice('Confirmed Devnet balance refreshed.');});
    bind('airdrop',async()=>{
      const {conn,url}=await connection();const address=signer.publicKey;
      const signature=await rpc(url,'requestAirdrop',[address.toBase58(),1000000000,{commitment:'confirmed'}]);log('Airdrop requested',signature);
      // Airdrop has no client-provided blockhash. Poll its own signature, never invent an expiry.
      let confirmed=false;
      for(let i=0;i<20;i++){const result=await conn.getSignatureStatuses([signature]);const s=result.value[0];assert(!s?.err,`Airdrop failed: ${JSON.stringify(s?.err)}`);if(['confirmed','finalized'].includes(s?.confirmationStatus)){confirmed=true;break;}await new Promise(resolve=>setTimeout(resolve,1500));}
      assert(confirmed,`Airdrop confirmation pending. Check Explorer for ${signature}; do not repeatedly request.`);await balance();notice('Devnet airdrop confirmed.');
    });
    async function broadcast(ctx,ix,label,topups=[]){
      const active=signer;assert(active,'Connect a signer.');
      assert([...topups,ix].flatMap(i=>i.keys).filter(k=>k.isSigner).every(k=>k.pubkey.equals(active.publicKey)), 'Signer changed while preparing the transaction. Review and try again.');
      await sendTransaction(ctx.conn,ix,active,sig=>log(`${label} · broadcast`,sig),topups);log(`${label} · confirmed`);
    }
    bind('transfer',async()=>{const ctx=await connection(),to=new PublicKey(value('transfer-to')),amount=sol(value('transfer-amount'));assert(amount>0n,'Transfer amount must be positive.');await broadcast(ctx,SystemProgram.transfer({fromPubkey:signer.publicKey,toPubkey:to,lamports:amount}),'Test SOL transfer');await balance();notice('Test SOL transfer confirmed.');});
    async function hashText(id,out){const hash=await sha256(UTF8.encode($(id).value));$(out).textContent=hex(hash);return hash;}
    async function hashFile(){const file=$('deliverable-file').files[0];assert(file,'Select a deliverable file.');const hash=await sha256(await file.arrayBuffer());$('deliverable-hash').textContent=hex(hash);return hash;}
    for(const [id,input,out] of [['hash-spec','spec','spec-hash'],['hash-dispute','dispute','dispute-hash']])bind(id,async()=>{await hashText(input,out);notice('SHA-256 calculated from exact UTF-8 bytes.');});
    bind('hash-deliverable',async()=>{await hashFile();notice('SHA-256 calculated locally from file bytes. No upload occurred.');});
    for(const [input,out] of [['spec','spec-hash'],['dispute','dispute-hash'],['deliverable-file','deliverable-hash']])$(input).addEventListener('input',()=>{$(out).textContent='Input changed — recalculate hash.';});
    bind('load',async()=>{clearLoaded();await refresh();notice('PDA refreshed from Devnet.');});
    bind('initialize',async()=>{
      const ctx=await refresh();assert(!loaded,'This PDA already exists. Choose a fresh sprint ID.');
      const parties={...ctx.selected,arbiter:new PublicKey(value('arbiter'))};
      assert(signer && signer.publicKey.equals(parties.client),'Only the client may fund this sprint.');
      distinctParties(ctx.address,parties);
      const args={sprint_id:parties.sprint_id,amount_lamports:sol(value('amount')),kill_fee_bps:integer(value('kill-fee'),0n,5000n),arbiter_fee_bps:integer(value('arbiter-fee'),0n,500n),review_window_secs:integer(value('window'),0n,2592000n),spec_hash:await hashText('spec','spec-hash')};
      assert(args.amount_lamports>0n,'Principal must be positive.');
      const ix=await instruction('initialize_sprint',args,ctx.program,ctx.address,signer.publicKey,parties);
      await broadcast(ctx,ix,'Fund sprint');await refresh();notice('Sprint funded and confirmed state loaded.');
    });
    document.querySelectorAll('[data-action]').forEach(button=>button.addEventListener('click',()=>run(async()=>{
      await refresh();const name=button.dataset.action;assert(loaded && allowed(name,loaded.account,roleFor(loaded.account,signer?.publicKey),chainNow),'Action is not allowed for the current account, signer or chain time.');
      let args={};
      if(name==='submit_deliverable')args={deliverable_hash:await hashFile(),deliverable_uri:$('deliverable-uri').value};
      if(name==='raise_dispute')args={dispute_hash:await hashText('dispute','dispute-hash')};
      if(name==='resolve_dispute')args={contractor_share_bps:integer(value('share'),0n,10000n)};
      const ix=await instruction(name,args,loaded.program,loaded.address,signer.publicKey,loaded.account);
      const topups=await settlementTopups(loaded.conn,name,loaded.account,args,signer.publicKey);
      if(topups.length)log(`Settlement includes ${topups.length} recipient rent top-up(s), paid by the signer in the same transaction.`);
      await broadcast(loaded,ix,name,topups);await refresh();notice('Transaction confirmed; account state refreshed.');
    })));
    $('share').addEventListener('input',renderPayouts);
    setInterval(updateDeadline,1000);renderControls();notice('Ready. Connect a wallet or create ephemeral judge signers. Settlement automatically adds recipient rent top-ups from the signer when needed. Enter a deployed program ID to begin.');
  }
})(globalThis);
