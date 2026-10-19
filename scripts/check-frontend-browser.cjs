/* Optional real-browser smoke checks. No live RPC, wallets or transactions.
 * Requires playwright 1.58.2 (or playwright-core) and an available Chromium binary.
 * PLAYWRIGHT_MODULE may point to an already-installed module; CHROME_PATH to a binary.
 */
'use strict';
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const app=path.resolve(__dirname,'../app');
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
 try {
  const context=await browser.newContext();let fallback=0;const errors=[];
  await context.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.hostname!=='clearmilestone.test')return route.abort();
   const relative=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname.slice(1));
   const file=path.resolve(app,relative);assert(file.startsWith(app+path.sep));
   if(relative.startsWith('vendor/'))fallback++;
   await route.fulfill({status:200,contentType:relative.endsWith('.css')?'text/css':relative.endsWith('.js')?'application/javascript':'text/html',body:fs.readFileSync(file)});
  });
  await context.addInitScript(()=>{window.phantom={solana:{connect:async()=>{throw new Error('User rejected connection (synthetic wallet)');}}};});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.setViewportSize({width:1440,height:1000});await page.goto('https://clearmilestone.test/');
  await page.getByText('Ready. Connect a wallet or create ephemeral judge signers.',{exact:false}).waitFor();
  assert(fallback>0,'Local library fallback must have loaded');
  await page.keyboard.press('Tab');assert.equal(await page.locator(':focus').textContent(),'Skip to workspace');
  await page.getByRole('button',{name:'Connect Phantom',exact:true}).click();
  await page.getByText('User rejected connection (synthetic wallet)',{exact:true}).first().waitFor();
  await page.locator('#create-judges').click();await page.locator('#judge-roles').waitFor();
  const keys=await Promise.all(['client','contractor','arbiter'].map(r=>page.locator('#'+r).inputValue()));assert.equal(new Set(keys).size,3);
  for(const [i,role] of ['client','contractor','arbiter'].entries()){
   await page.locator(`[data-role="${role}"]`).click();assert((await page.locator('#signer').textContent()).includes(keys[i]));
   assert.equal(await page.locator(`[data-role="${role}"]`).getAttribute('aria-pressed'),'true');
  }
  assert.equal(await page.locator('[data-action]:enabled').count(),0);
  const spec='Zażółć gęślą jaźń\n交付';await page.locator('#spec').fill(spec);await page.locator('#hash-spec').click();
  const expected=createHash('sha256').update(spec).digest('hex');await page.waitForFunction(h=>document.querySelector('#spec-hash').textContent===h,expected);
  await page.locator('#deliverable-file').setInputFiles({name:'delivery.txt',mimeType:'text/plain',buffer:Buffer.from('abc')});
  await page.locator('#hash-deliverable').click();await page.waitForFunction(()=>document.querySelector('#deliverable-hash').textContent==='ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  for(const width of [1440,390]){
   await page.setViewportSize({width,height:1000});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Horizontal overflow');
   await page.screenshot({path:path.join(process.env.SCREENSHOT_DIR || '/tmp',`clearmilestone-${width}.png`),fullPage:true});
  }
  assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);
  await page.reload();await page.locator('#create-judges:enabled').waitFor();assert.equal(await page.locator('#signer').textContent(),'No signer connected');
  console.log('PASS: CDN fallback, keyboard entry, wallet rejection, three signer switches, real WebCrypto, file hashing, no persistent keys, desktop/mobile overflow. Screenshots need visual review. No live Devnet calls.');
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
