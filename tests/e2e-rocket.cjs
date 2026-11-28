'use strict';
const assert=require('node:assert/strict'),{chromium,webkit}=require('playwright'),{createServer}=require('../scripts/dev.cjs');
(async()=>{const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
try{for(const engine of [chromium,webkit]){const browser=await engine.launch();try{const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce',hasTouch:true,isMobile:true});const page=await context.newPage(),errors=[],api=[];
page.on('pageerror',e=>errors.push(e.message));await context.route('**/*',r=>{const u=new URL(r.request().url());if(u.origin!==base)return r.abort();if(u.pathname.startsWith('/api/')){api.push(u.pathname);return r.abort();}return r.continue();});
await page.goto(base+'/rocket.html');await page.locator('#fire').waitFor();assert.equal(await page.locator('#targets [data-target]').count(),2);
await page.locator('#equation').fill('x+1');assert.match(await page.locator('#status').textContent(),/原点/);await page.locator('#fire').click();assert.equal(await page.locator('#ammo').textContent(),'5');
await page.locator('#equation').fill('x');await page.locator('#fire').click();await page.waitForFunction(()=>document.getElementById('status').textContent.includes('HIT'));assert.equal(await page.locator('#targets [data-target]').count(),1);
await page.locator('#equation').fill('2x/7');await page.locator('#fire').click();await page.locator('#next').waitFor();assert.equal(await page.locator('#status').textContent(),'STAGE CLEAR');
await page.locator('#next').click();assert.equal(await page.locator('#stage').textContent(),'02');await page.locator('#left').click();await page.locator('#equation').fill('-x/2');await page.locator('#fire').click();await page.waitForFunction(()=>document.getElementById('status').textContent.includes('HIT'));assert.equal(await page.locator('[data-target="b1"]').count(),0);
await page.locator('#reset').click();assert.equal(await page.locator('#stage').textContent(),'01');
for(const width of [320,390,1280]){await page.setViewportSize({width,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));}
assert.deepEqual(api,[]);assert.deepEqual(errors,[]);console.log(engine.name()+': GRAPH ROCKET browser checks passed');await context.close();
}finally{await browser.close();}}}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}})().catch(e=>{console.error(e);process.exitCode=1;});
