'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {matchDTO}=require('../server/router.cjs');

function sample(){
 return {id:'11111111-1111-4111-8111-111111111111',status:'playing',mode:'alternating',
  code:'AAAAAA',version:2,round:5,turn:'guest',pot:200,stake:100,escrow:200,
  host:{memberId:'11111111-1111-4111-8111-111111111111',name:'A',offer:100,stake:100,
    formation:0,ready:true,inputLocked:false,cancelRequested:false,timeoutStreak:2},
  guest:{memberId:'22222222-2222-4222-8222-222222222222',name:'B',offer:100,stake:100,
    formation:0,ready:true,inputLocked:false,cancelRequested:false,timeoutStreak:1},
  scores:{host:1,guest:1},state:null,winner:null,reason:null};
}
test('server match DTO exposes authoritative per-player timeout streaks and cannot accept malformed values',()=>{
 const raw=sample(),dto=matchDTO(raw);
 assert.equal(dto.host.timeoutStreak,2);
 assert.equal(dto.guest.timeoutStreak,1);
 for(const bad of [-1,4,1.5,'3',null,NaN]){
   raw.host.timeoutStreak=bad;
   assert.throws(()=>matchDTO(raw),error=>error.code==='INVALID_MATCH_STATE');
 }
 raw.host.timeoutStreak=3;
 assert.equal(matchDTO(raw).host.timeoutStreak,3);
 delete raw.host.timeoutStreak;
 assert.equal(Object.hasOwn(matchDTO(raw).host,'timeoutStreak'),false,
   'old server snapshots still decode during staged rollout');
});
test('finished timeouts keep verified score and payout fields and have no browser-settlement route',()=>{
 const ended=sample();
 ended.status='finished'; ended.winner='guest'; ended.reason='three_timeouts';ended.escrow=0;
 ended.host.timeoutStreak=3;ended.guest.timeoutStreak=0;
 const result=matchDTO(ended);
 assert.equal(result.winner,'guest');
 assert.equal(result.reason,'three_timeouts');
 assert.deepEqual(result.scores,{host:1,guest:1});
 assert.equal(result.pot,200);
 const client=fs.readFileSync(require.resolve('../public/app.js'),'utf8');
 const markup=fs.readFileSync(require.resolve('../public/index.html'),'utf8');
 assert(client.includes("match.reason==='three_timeouts'"));
 assert(client.includes('3回連続で時間切れとなったため敗北'));
 assert(client.includes('時間切れ '+String.fromCharCode(36)+'{count}/3'));
 assert(markup.includes('id="score-host-timeouts"'));
 assert(markup.includes('id="score-guest-timeouts"'));
});
