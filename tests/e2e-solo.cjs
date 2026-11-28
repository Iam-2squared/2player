'use strict';
const assert=require('node:assert/strict'),{chromium,webkit}=require('playwright'),{createServer}=require('../scripts/dev.cjs');
async function main(){
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 try{for(const [name,engine] of [['chromium',chromium],['webkit',webkit]]){
  const browser=await engine.launch({headless:true});const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
  const errors=[],api=[];try{
   await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!==base)return route.abort();if(url.pathname.startsWith('/api/')){api.push(url.pathname);return route.abort();}return route.continue();});
   const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
   await page.goto(base+'/solo.html');await page.clock.install();
   await page.locator('#start').click();await page.locator('#board').waitFor({state:'visible'});assert.equal(await page.locator('#board .node').count(),25);
   const move=()=>page.evaluate(()=>TenLink.findMove([...document.querySelectorAll('#board .node')].map(n=>Number(n.dataset.number))));
   const p=await move(),centers=await page.locator('#board .node').evaluateAll(ns=>ns.map(n=>{const r=n.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};}));
   await page.mouse.move(centers[p[0]].x,centers[p[0]].y);await page.mouse.down();for(const i of p.slice(1))await page.mouse.move(centers[i].x,centers[i].y,{steps:5});await page.mouse.up();
   await page.waitForFunction(()=>Number(document.querySelector('#score').textContent.replaceAll(',',''))>0);
   const scored=Number((await page.locator('#score').textContent()).replaceAll(',',''));
   const next=await move();for(const i of next){const node=page.locator('#board .node[data-index="'+i+'"]');await node.focus();await node.press('Enter');}
   assert.ok(Number((await page.locator('#score').textContent()).replaceAll(',',''))>scored);
   await page.clock.fastForward(61000);await page.locator('#result').waitFor({state:'visible'});
   const result=Number((await page.locator('#final-score').textContent()).replaceAll(',',''));assert.ok(result>scored);
   await page.reload();assert.equal(Number((await page.locator('#best').textContent()).replaceAll(',','')),result);
   await page.locator('#start').click();await page.locator('#board').waitFor({state:'visible'});assert.equal(await page.locator('#score').textContent(),'0');await page.locator('#quit').click();await page.locator('#again').click();await page.locator('#board').waitFor({state:'visible'});assert.equal(await page.locator('#score').textContent(),'0');
   for(const width of [320,390,1280]){await page.setViewportSize({width,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));}
   assert.ok(api.every(p=>['/api/solo/ranking','/api/solo/start'].includes(p)),'offline practice never sends a score or calls wallet');assert.deepEqual(errors,[]);console.log(name+': solo browser checks passed');
  }finally{await context.close();await browser.close();}
 }}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
