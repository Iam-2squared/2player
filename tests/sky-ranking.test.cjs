'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),R=require('../public/sky-rules.js'),S=require('../server/sky-ranking.cjs'),{requestUrl}=require('../server/router.cjs');
const actor='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',key='test-only-key-'.repeat(4),at=100000;
test('replay awards only genuine physics hits and rejects forged scores or cooldown violations',()=>{
 const run=S.issue(actor,key,at),t=R.schedule(run.seed)[15],ms=15500,p=R.position(t,ms/1000),shot=[ms,Math.round(p.x*100),Math.round(p.y*100)];
 assert.equal(S.verify(actor,key,{token:run.token,shots:[shot]},at+65000),5);
 for(const [owner,k,body,now] of [[other,key,{token:run.token,shots:[shot]},at+65000],[actor,key+'x',{token:run.token,shots:[shot]},at+65000],[actor,key,{token:run.token,shots:[shot],score:72},at+65000],[actor,key,{token:run.token,shots:[shot,[ms+100,shot[1],shot[2]]]},at+65000],[actor,key,{token:run.token,shots:[shot]},at+1000],[actor,key,{token:run.token,shots:[shot]},at+901000]])assert.throws(()=>S.verify(owner,k,body,now));
 assert.equal(S.verify(actor,key,{token:run.token,shots:[]},at+65000),0);
});
test('private DTO and independent API routes',()=>{assert.throws(()=>S.dto({ranking:[{rank:1,name:'A',score:73,isYou:true}]}));assert.deepEqual(S.dto({ranking:[{rank:1,name:'A',score:72,isYou:true,memberId:actor}]}),{ok:true,ranking:[{rank:1,name:'A',score:72,isYou:true}]});for(const route of ['ranking','start','finish'])assert.equal(requestUrl({url:'/api/index?route=sky%2F'+route+'&path=sky%2F'+route}).pathname,'/api/sky/'+route);});
