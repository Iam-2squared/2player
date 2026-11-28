'use strict';
const assert=require('node:assert/strict'),{chromium,webkit}=require('playwright'),{createServer}=require('../scripts/dev.cjs'),W=require('../server/war.cjs'),C=require('../public/color-rules.js');
(async()=>{const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
try{for(const engine of [chromium,webkit]){const browser=await engine.launch();try{const contexts=await Promise.all([1,2].map(()=>browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true})));let state=W.empty(),seed=17,submission=0;const rng=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
const actors=[{memberId:'11111111-1111-4111-8111-111111111111',name:'A'},{memberId:'22222222-2222-4222-8222-222222222222',name:'B'}],errors=[];
for(let i=0;i<2;i++)await contexts[i].route('**/*',async route=>{const u=new URL(route.request().url());if(u.origin!==base)return route.abort();
if(u.pathname.startsWith('/api/war/')){const action=u.pathname.split('/').at(-1);try{state=W.mutate(state,action,actors[i],route.request().postDataJSON(),Date.now(),rng);return route.fulfill({json:W.dto(state,actors[i],Date.now())});}catch(e){return route.fulfill({status:409,json:{ok:false,message:e.message}});}}
if(u.pathname==='/api/session')return route.fulfill({json:{ok:true,user:null,wallet:null}});
if(u.pathname==='/api/color/ranking')return route.fulfill({json:{ok:true,ranking:submission?[{rank:1,name:'A',time_ms:6500,isYou:true}]:[]}});
if(u.pathname==='/api/color/start')return route.fulfill({json:{ok:true,seed:123,token:'synthetic'}});
if(u.pathname==='/api/color/finish'){const data=route.request().postDataJSON();assert.equal(data.token,'synthetic');assert.ok(C.replay(123,data.answers)!==null);submission++;return route.fulfill({json:{ok:true,time_ms:6500,ranking:[{rank:1,name:'A',time_ms:6500,isYou:true}]}});}
if(u.pathname.startsWith('/api/'))throw Error('Unexpected API '+u.pathname);return route.continue();});
const a=await contexts[0].newPage(),b=await contexts[1].newPage();for(const page of [a,b])page.on('pageerror',e=>errors.push(e.message));
await a.goto(base+'/war.html');await a.waitForFunction(()=>document.getElementById('population').textContent==='1 人');
await b.goto(base+'/war.html');await b.waitForFunction(()=>document.getElementById('population').textContent==='2 人');await a.waitForFunction(()=>document.getElementById('population').textContent==='2 人');
assert.equal(await a.locator('#players circle').count(),2);assert.equal(await b.locator('#obstacles circle').count(),1);assert.ok(await a.locator('#field-scroll').evaluate(n=>n.scrollWidth>n.clientWidth));assert.equal(await a.locator('#turn').textContent(),'あなたのターン');
await a.locator('#pass').click();await b.waitForFunction(()=>document.getElementById('turn').textContent==='あなたのターン');await b.locator('#equation').fill('x²+y²=300x');await b.locator('#fire').click();await b.waitForFunction(()=>document.querySelectorAll('#trails path').length>0);await a.waitForFunction(()=>document.querySelectorAll('#trails path').length>0);
await b.locator('#leave').click();await a.waitForFunction(()=>document.getElementById('population').textContent==='1 人');
await a.clock.install();await a.goto(base+'/color.html');await a.locator('#start').click();await a.locator('#count').waitFor();await a.clock.runFor(3100);await a.locator('#play').waitFor();
const qs=C.questions(123);assert.equal(await a.locator('#word').textContent(),C.WORDS[qs[0].word]);await a.locator('[data-answer="'+((qs[0].word+1)%3)+'"]').click();assert.equal(await a.locator('#progress').textContent(),'0 / 50');assert.ok((await a.locator('#choices').getAttribute('class')).includes('shake'));
for(let i=0;i<50;i++){await a.clock.runFor(120);await a.locator('[data-answer="'+qs[i].word+'"]').click();}
await a.locator('#result').waitFor();await a.waitForFunction(()=>document.getElementById('save-status').textContent.includes('ランキング 1位'));assert.equal(submission,1);assert.equal(await a.locator('#final').textContent(),'6.50 s');await a.locator('#menu').click();await a.locator('#ranking-list li.self').waitFor();
assert.deepEqual(errors,[]);await Promise.all(contexts.map(c=>c.close()));console.log(engine.name()+': Graphwar and Color? browser checks passed');
}finally{await browser.close();}}}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}})().catch(e=>{console.error(e);process.exitCode=1;});
