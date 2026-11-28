'use strict';
const crypto=require('node:crypto'),R=require('../public/solo-rules.js'),{HttpError}=require('./errors.cjs');
const invalid=()=>new HttpError(400,'ゲーム記録を確認できません。','INVALID_SOLO_RUN');
const secret=(key,raw)=>crypto.createHmac('sha256',key).update('ten-link-ranking-v1\0'+raw).digest();
function issue(owner,key,now=Date.now()){
 const seed=crypto.randomBytes(4).readUInt32BE(),raw=Buffer.from(JSON.stringify({v:1,owner,seed,at:now,id:crypto.randomUUID()})).toString('base64url');
 return {seed,token:raw+'.'+secret(key,raw).toString('base64url')};
}
function verify(owner,key,body,now=Date.now()){
 if(!body||Object.keys(body).length!==2||typeof body.token!=='string'||body.token.length>500||!Array.isArray(body.moves)||body.moves.length>120)throw invalid();
 const parts=body.token.split('.');if(parts.length!==2||!parts.every(p=>/^[A-Za-z0-9_-]+$/.test(p)))throw invalid();
 const mac=Buffer.from(parts[1],'base64url'),expected=secret(key,parts[0]);if(mac.length!==expected.length||!crypto.timingSafeEqual(mac,expected))throw invalid();
 let run;try{run=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8'));}catch{throw invalid();}
 if(run.v!==1||run.owner!==owner||!Number.isInteger(run.seed)||run.seed<0||run.seed>4294967295||!Number.isSafeInteger(run.at)||now-run.at<0||now-run.at>180000)throw invalid();
 const rng=R.seeded(run.seed);let board=R.newBoard(rng),score=0,last=-100;
 for(const move of body.moves){
  if(!Array.isArray(move)||move.length!==2||!Number.isSafeInteger(move[0])||move[0]<0||move[0]>=60000||move[0]-last<100||move[0]>now-run.at||!Array.isArray(move[1])||move[1].length>25)throw invalid();
  const result=R.apply(board,move[1],rng);if(!result)throw invalid();
  last=move[0];board=result.board;score+=result.points;
 }
 return score;
}
function dto(result){
 if(!Array.isArray(result?.ranking)||result.ranking.length>500)throw invalid();
 let previous=Infinity,own=0;
 const ranking=result.ranking.map((r,i)=>{
  if(r.rank!==i+1||typeof r.name!=='string'||!r.name.trim()||r.name.length>40||!Number.isSafeInteger(r.score)||r.score<1||r.score>72000000||r.score>previous||typeof r.isYou!=='boolean')throw invalid();
  previous=r.score;if(r.isYou)own++;
  return {rank:r.rank,name:r.name,score:r.score,isYou:r.isYou};
 });
 if(own>1)throw invalid();return {ok:true,ranking};
}
module.exports={issue,verify,dto};
