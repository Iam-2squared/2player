'use strict';
const assert=require('node:assert/strict'),{chromium,webkit}=require('playwright'),{createServer}=require('../scripts/dev.cjs');
(async()=>{const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
try{for(const engine of [chromium,webkit]){const browser=await engine.launch();try{const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce',hasTouch:true,isMobile:true});const page=await context.newPage(),errors=[],api=[];
page.on('pageerror',e=>errors.push(e.message));await context.route('**/*',r=>{const u=new URL(r.request().url());if(u.origin!==base)return r.abort();if(u.pathname.startsWith('/api/')){api.push(u.pathname);return r.abort();}return r.continue();});
await page.goto(base+'/rocket.html');await page.locator('#fire').waitFor();
assert.equal(await page.locator('#left,#right,#grid,#lives').count(),0);
assert.equal(await page.locator('#stars circle').count(),100);
assert.deepEqual(await page.locator('#labels text').allTextContents(),['1','1','10','10','0','x','y']);
assert.equal(await page.locator('#symbols [data-symbol="^3"],#symbols [data-symbol="^4"]').count(),2);
assert.match(await page.locator('#ship').getAttribute('transform'),/^translate\(40 400\)/);
assert.equal(await page.locator('#targets [data-target]').count(),2);
await page.locator('#equation').fill('x+1');assert.match(await page.locator('#status').textContent(),/原点/);await page.locator('#fire').click();assert.equal(await page.locator('#ammo').textContent(),'1');
await page.locator('#equation').fill('x');await page.locator('#fire').click();await page.locator('#next').waitFor();
assert.match(await page.locator('#status').textContent(),/^FAILED/);assert.equal(await page.locator('#targets [data-target]').count(),1);assert.equal(await page.locator('#ammo').textContent(),'0');assert.ok(await page.locator('#fire').isDisabled());
await page.locator('#next').click();assert.equal(await page.locator('#stage').textContent(),'01');assert.equal(await page.locator('#ammo').textContent(),'1');assert.equal(await page.locator('#targets [data-target]').count(),2);
const solutions=['x²/8','x(10-x)/3','x(x-6)²/8+x/4','x(10-x)(x-5)²/20+x/10'];
for(let i=0;i<solutions.length;i++){
 assert.equal(await page.locator('#stage').textContent(),String(i+1).padStart(2,'0'));assert.equal(await page.locator('#ammo').textContent(),'1');
 // Exercise direct higher powers as well as factored polynomial notation.
 if(i===2)await page.locator('#equation').fill('x³/8-3x²/2+19x/4');
 else if(i===3)await page.locator('#equation').fill('-x⁴/20+x³-25x²/4+63x/5');
 else await page.locator('#equation').fill(solutions[i]);
 await page.locator('#fire').click();await page.locator('#next').waitFor();
 assert.equal(await page.locator('#status').textContent(),i===3?'ALL CLEAR':'STAGE CLEAR');assert.equal(await page.locator('#targets [data-target]').count(),0);await page.locator('#next').click();
}
assert.equal(await page.locator('#stage').textContent(),'01');
for(const width of [320,390,1280]){await page.setViewportSize({width,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));}
assert.deepEqual(api,[]);assert.deepEqual(errors,[]);console.log(engine.name()+': GRAPH ROCKET browser checks passed');await context.close();
}finally{await browser.close();}}}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}})().catch(e=>{console.error(e);process.exitCode=1;});
