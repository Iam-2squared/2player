'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),M=require('../public/war-math.js'),W=require('../server/war.cjs'),C=require('../public/color-rules.js'),S=require('../server/color-ranking.cjs'),{requestUrl}=require('../server/router.cjs');
const A={memberId:'11111111-1111-4111-8111-111111111111',name:'A'},B={memberId:'22222222-2222-4222-8222-222222222222',name:'B'},D={memberId:'33333333-3333-4333-8333-333333333333',name:'C'};
function rng(seed=17){return()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);}
test('safe graph parsing supports left/right polynomial shots and connected circles',()=>{
 assert.throws(()=>M.paths('alert(1)',[500,500]));
 assert.throws(()=>M.paths('y=x+1',[500,500]),/原点/);
 assert.ok(M.paths('y=x/2',[500,500],1)[0].at(-1)[0]>500);
 assert.ok(M.paths('y=x/2',[500,500],-1)[0].at(-1)[0]<500);
 const circle=M.paths('x²+y²=300x',[500,500]);assert.ok(circle.length);
 const points=circle.flat();assert.ok(Math.max(...points.map(p=>p[0]))>790);assert.ok(Math.max(...points.map(p=>p[1]))>630);assert.ok(Math.min(...points.map(p=>p[1]))<370);
 assert.ok(points.every(p=>Math.abs((p[0]-650)**2+(p[1]-500)**2-22500)<350));
});
test('obstacles block shots and shrink; unblocked opponents can be hit',()=>{
 const players=[{id:'a',x:100,y:500,alive:true},{id:'b',x:600,y:500,alive:true}],paths=M.paths('y=0',[100,500]);
 const blocked=M.resolve(paths,players,[{id:'o',x:400,y:500,r:55}],'a');assert.deepEqual(blocked.killed,[]);assert.equal(blocked.obstacles[0].r,41);
 assert.deepEqual(M.resolve(paths,players,[],'a').killed,['b']);
});
test('automatic join, turn cycle, respawn and empty-world reset',()=>{
 const r=rng();let s=W.mutate(W.empty(),'poll',A,{},1000,r);assert.equal(s.players.length,1);assert.equal(s.obstacles.length,0);
 s=W.mutate(s,'poll',B,{},1001,r);assert.equal(s.players.length,2);assert.equal(s.obstacles.length,1);
 s=W.mutate(s,'poll',D,{},1002,r);assert.equal(s.players.length,3);assert.equal(s.obstacles.length,2);
 s.obstacles=[];Object.assign(s.players[0],{x:100,y:500});Object.assign(s.players[1],{x:600,y:500});Object.assign(s.players[2],{x:1000,y:800});
 assert.throws(()=>W.mutate(s,'fire',B,{serial:0,equation:'y=0',direction:1},1003,r),/順番/);
 s=W.mutate(s,'fire',A,{serial:0,equation:'y=0',direction:1},1003,r);assert.equal(s.players.find(p=>p.id===B.memberId).alive,false);assert.equal(s.queue[0],D.memberId);
 s=W.mutate(s,'pass',D,{serial:s.serial},1004,r);assert.equal(s.players.find(p=>p.id===B.memberId).alive,false);
 s=W.mutate(s,'pass',A,{serial:s.serial},1005,r);assert.equal(s.players.find(p=>p.id===B.memberId).alive,true);
 s=W.mutate(s,'leave',A,{},1006,r);s=W.mutate(s,'leave',B,{},1007,r);s=W.mutate(s,'leave',D,{},1008,r);assert.deepEqual(s,W.empty());
});
test('only remaining dead player revives; expired presence resets world',()=>{
 const r=rng();let s=W.mutate(W.empty(),'poll',A,{},1000,r);s=W.mutate(s,'poll',B,{},1001,r);s.obstacles=[];Object.assign(s.players[0],{x:100,y:500});Object.assign(s.players[1],{x:600,y:500});
 s=W.mutate(s,'fire',A,{serial:0,equation:'y=0',direction:1},1002,r);assert.equal(s.players[1].alive,false);s=W.mutate(s,'leave',A,{},1003,r);assert.equal(s.players[0].alive,true);
 s=W.mutate(s,'poll',A,{},1003+W.TTL+1,r);assert.equal(s.players.length,1);assert.equal(s.obstacles.length,0);
});
test('Color? compares meaning not ink and checks exactly 50 correct answers',()=>{
 const key='test-key-'.repeat(6),run=S.issue(A.memberId,key,100000),q=C.questions(run.seed);assert.equal(q.length,50);assert.ok(q.some(v=>v.word!==v.ink));
 const answers=[[0,(q[0].word+1)%3],...q.map((v,i)=>[100+i*150,v.word])];assert.equal(C.replay(run.seed,answers),7450);assert.equal(S.verify(A.memberId,key,{token:run.token,answers},111000),8000);
 assert.throws(()=>S.verify(B.memberId,key,{token:run.token,answers},111000));
 assert.throws(()=>S.verify(A.memberId,key,{token:run.token,answers:answers.slice(0,-1)},111000));
 assert.throws(()=>S.verify(A.memberId,key,{token:run.token,answers},103100));
 assert.throws(()=>S.dto({ranking:[{rank:1,name:'A',time_ms:1000,isYou:true},{rank:2,name:'B',time_ms:900,isYou:false}]}));
});
test('new independent API routes',()=>{for(const route of ['war/poll','war/fire','war/pass','war/leave','color/ranking','color/start','color/finish'])assert.equal(requestUrl({url:'/api/index?route='+encodeURIComponent(route)+'&path='+encodeURIComponent(route)}).pathname,'/api/'+route);});
