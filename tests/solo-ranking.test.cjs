'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),R=require('../public/solo-rules.js'),S=require('../server/solo-ranking.cjs'),{requestUrl}=require('../server/router.cjs');
const actor='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',key='test-only-secret-'.repeat(4),at=100000;
test('server replays deterministic board and legal moves, rejecting arbitrary scores',()=>{
 const run=S.issue(actor,key,at),rng=R.seeded(run.seed);let board=R.newBoard(rng),score=0,moves=[];
 for(let i=0;i<20;i++){const p=R.findMove(board),next=R.apply(board,p,rng);moves.push([i*1000,p]);board=next.board;score+=next.points;}
 const body={token:run.token,moves};
 assert.equal(S.verify(actor,key,body,at+60000),score);
 for(const [owner,secret,submission,now] of [[other,key,body,at+60000],[actor,key+'x',body,at+60000],[actor,key,{...body,score:99999999},at+60000],[actor,key,{...body,moves:[[100,[0,24]]]},at+60000],[actor,key,{...body,moves:[[60000,moves[0][1]]]},at+60000],[actor,key,body,at+100],[actor,key,body,at+180001]])assert.throws(()=>S.verify(owner,secret,submission,now),{code:'INVALID_SOLO_RUN'});
 assert.throws(()=>S.verify(actor,key,{...body,moves:[moves[0],[50,moves[1][1]]]},at+60000));
});
test('rank DTO is bounded, sorted and private',()=>{
 const r=S.dto({ranking:[{rank:1,name:'A',score:500,isYou:false,memberId:actor},{rank:2,name:'B',score:200,isYou:true}]});
 assert.deepEqual(r,{ok:true,ranking:[{rank:1,name:'A',score:500,isYou:false},{rank:2,name:'B',score:200,isYou:true}]});
 assert.throws(()=>S.dto({ranking:[{rank:1,name:'A',score:500,isYou:true},{rank:2,name:'B',score:600,isYou:true}]}));
 for(const route of ['ranking','start','finish'])assert.equal(requestUrl({url:'/api/index?route=solo%2F'+route+'&path=solo%2F'+route}).pathname,'/api/solo/'+route);
});
