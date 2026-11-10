'use strict';

// Actual browser assets; every API reply is synthetic and remains on loopback.
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs/promises'),path=require('node:path');
const {chromium,webkit}=require('playwright');
const physics=require('../public/physics.js');
const root=path.resolve(__dirname,'..');
const ids={host:'00000000-0000-4000-8000-000000000001',guest:'00000000-0000-4000-8000-000000000002',match:'00000000-0000-4000-8000-000000000003'};
const names={host:'赤',guest:'青'};
const iso=value=>new Date(value).toISOString();
let server,browser,checks=0;
const eq=(a,b,label)=>{checks++;assert.deepEqual(a,b,label);};
const ok=(value,label)=>{checks++;assert.ok(value,label);};
function makeMatch(status='waiting',extra={}){
  const now=Date.now(),funded=status!=='waiting';
  return {id:ids.match,status,mode:'alternating',version:2,round:1,turn:'host',stake:funded?100:null,escrow:status==='playing'?400:0,
    host:{memberId:ids.host,name:names.host,formation:0,offer:100,stake:funded?100:null,ready:funded,inputLocked:false,cancelRequested:false},
    guest:{memberId:ids.guest,name:names.guest,formation:0,offer:300,stake:funded?300:null,ready:funded,inputLocked:false,cancelRequested:false},
    scores:{host:0,guest:0},state:physics.initialState(),updatedAt:iso(now),expiresAt:iso(now+600000),
    turnStartedAt:funded?iso(now):null,turnExpiresAt:funded?iso(now+60000):null,serverNow:iso(now),...extra};
}
const json=(route,value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
async function fixture(base,{role='host',initial=makeMatch(),onReady,initialPending}={}){
  const context=await browser.newContext({viewport:{width:320,height:740},reducedMotion:'reduce'});
  if(initialPending)await context.addInitScript(({key,pending})=>localStorage.setItem(key,JSON.stringify(pending)),
    {key:'2player.pending:'+ids[role],pending:initialPending});
  const user={id:ids[role],name:names[role]},wallet={balance:1000000,totalIncome:1000000,spent:0,walletRevision:1,gameNet:0,escrow:0};
  let current=structuredClone(initial),sequence=0;
  const calls=[],errors=[];
  function touch(){if(current)current.updatedAt=iso(Date.now()+ ++sequence*1000);}
  const snapshot=()=>({ok:true,user,wallet,match:current,lobby:{online:[],queue:null,incoming:[],outgoing:[]}});
  await context.route('**/api/**',async route=>{
    const request=route.request(),pathname=new URL(request.url()).pathname;
    const input=request.method()==='POST'?request.postDataJSON():null;
    calls.push({pathname,input});
    if(pathname==='/api/ready'){
      if(onReady&&await onReady({route,input,current,setMatch:value=>{current=value;touch();},snapshot}))return;
      current[role].ready=true;touch();return json(route,snapshot());
    }
    if(pathname==='/api/offer'){
      current[role].offer=input.stake;current.host.ready=false;current.guest.ready=false;touch();return json(route,snapshot());
    }
    if(pathname==='/api/logout')return json(route,{ok:true});
    return json(route,snapshot());
  });
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base);
  await page.locator(initial.status==='waiting'?'#room-view':'#game-view').waitFor({state:'visible'});
  return {context,page,calls,setMatch(value){current=value;touch();},clearMatch(){current=null;},
    readyCalls:()=>calls.filter(call=>call.pathname==='/api/ready'),
    async refresh(){await page.evaluate(()=>window.dispatchEvent(new Event('online')));},
    async close(){await context.close();eq(errors,[],'No uncaught client error');}};
}
async function run(base){
  {
    const f=await fixture(base);
    try{
      eq(await f.page.locator('#host-offer').textContent(),'100 轟');
      eq(await f.page.locator('#guest-offer').textContent(),'300 轟');
      eq(await f.page.locator('#room-pot').textContent(),'400');
      eq(await f.page.locator('#ready-button').textContent(),'許可');
      eq(await f.page.locator('#ready-button').isEnabled(),true,'Different funded offers may be explicitly approved');
      ok(!(await f.page.locator('#room-info').textContent()).includes('合わせ'),'No obsolete equal-stake instruction');
      ok(!(await f.page.locator('#ready-hint').textContent()).includes('同額'),'No obsolete equal-only hint');
      await Promise.all([f.page.waitForResponse(response=>new URL(response.url()).pathname==='/api/ready'),f.page.locator('#ready-button').click()]);
      await f.page.waitForFunction(()=>document.getElementById('ready-button').disabled);
      eq(f.readyCalls().length,1);
      const {requestId,...approved}=f.readyCalls()[0].input;
      ok(/^[a-f0-9-]{36}$/i.test(requestId),'Each consent carries an idempotency key');
      eq(approved,{matchId:ids.match,ready:true,expectedHostOffer:100,expectedGuestOffer:300},'Consent binds the two displayed offers');
      const changed=makeMatch();changed.guest.offer=500;f.setMatch(changed);await f.refresh();
      await f.page.waitForFunction(()=>document.getElementById('guest-offer').textContent==='500 轟');
      eq(await f.page.locator('#ready-button').isEnabled(),true,'A changed offer removes prior ready state');
      eq(await f.page.locator('#room-pot').textContent(),'600');
      eq(f.readyCalls().length,1,'A new offer is never approved automatically');
      await Promise.all([f.page.waitForResponse(response=>new URL(response.url()).pathname==='/api/ready'),f.page.locator('#ready-button').click()]);
      await f.page.waitForFunction(()=>document.getElementById('ready-button').disabled);
      eq(f.readyCalls()[1].input.expectedGuestOffer,500,'Next explicit approval uses the new amount');
      eq(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Narrow room layout has no horizontal overflow');
    }finally{await f.close();}
  }
  {
    const pending={path:'ready',matchId:ids.match,createdAt:Date.now(),body:{requestId:'00000000-0000-4000-8000-000000000004',matchId:ids.match,
      ready:true,expectedHostOffer:100,expectedGuestOffer:200}};
    const f=await fixture(base,{initialPending:pending});
    try{
      eq(f.readyCalls().length,0,'Restoring a stale cached approval never sends it automatically');
      eq(await f.page.locator('#retry-notice').isVisible(),false,'A cached approval for different amounts is retired');
      eq(await f.page.evaluate(key=>localStorage.getItem(key),'2player.pending:'+ids.host),null);
      eq(await f.page.locator('#ready-button').isEnabled(),true);
      await Promise.all([f.page.waitForResponse(response=>new URL(response.url()).pathname==='/api/ready'),f.page.locator('#ready-button').click()]);
      eq(f.readyCalls()[0].input.expectedHostOffer,100);
      eq(f.readyCalls()[0].input.expectedGuestOffer,300,'Only a fresh explicit approval can use the current pair');
    }finally{await f.close();}
  }
  {
    const f=await fixture(base);
    try{
      await f.page.locator('#stake').fill('200');
      eq(await f.page.locator('#ready-button').isDisabled(),true,'An unsaved draft cannot be mistaken for the server offer being approved');
      eq(f.readyCalls().length,0);
      await Promise.all([f.page.waitForResponse(response=>new URL(response.url()).pathname==='/api/offer'),f.page.locator('#offer-submit').click()]);
      await f.page.waitForFunction(()=>document.getElementById('host-offer').textContent==='200 轟');
      eq(await f.page.locator('#ready-button').isEnabled(),true,'Save the offered amount before approving it');
      eq(await f.page.locator('#room-pot').textContent(),'500');
      await Promise.all([f.page.waitForResponse(response=>new URL(response.url()).pathname==='/api/ready'),f.page.locator('#ready-button').click()]);
      eq(f.readyCalls()[0].input.expectedHostOffer,200);
      eq(f.readyCalls()[0].input.expectedGuestOffer,300);
    }finally{await f.close();}
  }
  {
    let rejected=false;
    const f=await fixture(base,{onReady:async({route,current,setMatch,snapshot})=>{
      if(rejected)return false;rejected=true;
      const changed=structuredClone(current);changed.guest.offer=700;changed.host.ready=false;changed.guest.ready=false;setMatch(changed);
      await json(route,{ok:false,error:{code:'STALE_OFFERS',message:'金額が変わりました。'}},409);return true;
    }});
    try{
      await f.page.locator('#ready-button').click();
      await f.page.waitForFunction(()=>document.getElementById('guest-offer').textContent==='700 轟');
      eq(f.readyCalls().length,1,'A stale approval is not retried as consent to a newer amount');
      eq(await f.page.locator('#ready-button').isEnabled(),true);
      eq(await f.page.locator('#room-pot').textContent(),'800');
      await Promise.all([f.page.waitForResponse(response=>new URL(response.url()).pathname==='/api/ready'),f.page.locator('#ready-button').click()]);
      await f.page.waitForFunction(()=>document.getElementById('ready-button').disabled);
      eq(f.readyCalls()[1].input.expectedGuestOffer,700);
      eq(f.readyCalls()[1].input.expectedHostOffer,100);
    }finally{await f.close();}
  }
  for(const role of ['host','guest']){
    const f=await fixture(base,{role,initial:makeMatch('playing')});
    try{
      eq(await f.page.locator('#game-pot').textContent(),'400','Game prize is the sum of both funded amounts');
      eq(await f.page.locator('#escrow-amount').textContent(),role==='host'?'100':'300','Each player sees their own actual deposit');
      eq(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Narrow game layout has no horizontal overflow');
    }finally{await f.close();}
  }
  for(const role of ['host','guest'])for(const outcome of ['win','lose','draw','cancel']){
    const own=role==='host'?100:300,opponent=role==='host'?300:100;
    const winner=outcome==='draw'?'draw':outcome==='win'?role:role==='host'?'guest':'host';
    const f=await fixture(base,{role,initial:makeMatch(outcome==='cancel'?'cancelled':'finished',{winner:outcome==='cancel'?null:winner})});
    try{
      const expected=outcome==='win'?'400 轟獲得':outcome==='lose'?`−${own} 轟`:`${own} 轟返却`;
      eq(await f.page.locator('#result-amount').textContent(),expected,role+' '+outcome+' uses exact own deposit and total prize');
      if(outcome==='win')eq(await f.page.locator('#result-copy').textContent(),`収支 ＋${opponent} 轟`,'Win profit equals the other player\'s stake');
      if(role==='guest'&&outcome==='cancel'){
        f.clearMatch();await f.page.locator('#rematch-button').click();await f.page.locator('#lobby-view').waitFor({state:'visible'});
        eq(await f.page.locator('#lobby-stake').inputValue(),'300','Guest rematch retains the guest deposit rather than the host amount');
      }
    }finally{await f.close();}
  }
  {
    const legacy=makeMatch('playing',{stake:1000,escrow:2000});legacy.host.offer=1000;legacy.guest.offer=1000;delete legacy.host.stake;delete legacy.guest.stake;
    const f=await fixture(base,{role:'guest',initial:legacy});
    try{
      eq(await f.page.locator('#game-pot').textContent(),'2,000','A legacy equal-stake DTO still shows its original pot');
      eq(await f.page.locator('#escrow-amount').textContent(),'1,000','A legacy equal-stake DTO retains the shared amount');
    }finally{await f.close();}
  }
}
(async()=>{
  try{
    server=http.createServer(async(req,res)=>{try{const file={'/':['index.html','text/html'],'/app.js':['app.js','application/javascript'],'/style.css':['style.css','text/css'],'/physics.js':['physics.js','application/javascript']}[new URL(req.url,'http://localhost').pathname];if(!file){res.writeHead(404);return res.end();}res.writeHead(200,{'Content-Type':file[1]});res.end(await fs.readFile(path.join(root,'public',file[0])));}catch{res.writeHead(500);res.end();}});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const engine=process.env.BROWSER==='webkit'?'webkit':'chromium';
    browser=engine==='webkit'?await webkit.launch({headless:true,executablePath:process.env.WEBKIT_PATH||'/workspace/scratch/webkit-runtime/pw-run.sh'}):await chromium.launch({headless:true,executablePath:'/usr/bin/chromium',args:['--no-sandbox']});
    await run('http://127.0.0.1:'+server.address().port);
    await fs.mkdir(path.join(root,'test-results'),{recursive:true});
    await fs.writeFile(path.join(root,'test-results','unequal-stakes-ui-'+engine+'.json'),JSON.stringify({engine,checks,passed:true,hostedWrites:false,syntheticApiOnly:true},null,2));
    console.log(JSON.stringify({engine,checks,passed:true,hostedWrites:false}));
  }finally{if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
