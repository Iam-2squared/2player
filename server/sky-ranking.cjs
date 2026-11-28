'use strict';
const crypto=require('node:crypto'),R=require('../public/sky-rules.js'),{HttpError}=require('./errors.cjs'),solo=require('./solo-ranking.cjs');
const invalid=()=>new HttpError(400,'ゲーム記録を確認できません。','INVALID_SKY_RUN');
const mac=(key,raw)=>crypto.createHmac('sha256',key).update('sky-ranking-v1\0'+raw).digest();
function issue(owner,key,now=Date.now()){
 const seed=crypto.randomBytes(4).readUInt32BE(),raw=Buffer.from(JSON.stringify({v:1,owner,seed,at:now,id:crypto.randomUUID()})).toString('base64url');
 return {seed,token:raw+'.'+mac(key,raw).toString('base64url')};
}
function verify(owner,key,body,now=Date.now()){
 if(!body||Object.keys(body).length!==2||typeof body.token!=='string'||body.token.length>500||!Array.isArray(body.shots)||body.shots.length>250)throw invalid();
 const parts=body.token.split('.');if(parts.length!==2||!parts.every(p=>/^[A-Za-z0-9_-]+$/.test(p)))throw invalid();
 const signature=Buffer.from(parts[1],'base64url'),expected=mac(key,parts[0]);if(signature.length!==expected.length||!crypto.timingSafeEqual(signature,expected))throw invalid();
 let run;try{run=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8'));}catch{throw invalid();}
 if(run.v!==1||run.owner!==owner||!Number.isInteger(run.seed)||run.seed<0||run.seed>4294967295||!Number.isSafeInteger(run.at)||now-run.at<60000||now-run.at>900000)throw invalid();
 const targets=R.schedule(run.seed),removed=new Set();let last=-240,score=0;
 for(const s of body.shots){
  if(!Array.isArray(s)||s.length!==3||!s.every(Number.isInteger)||s[0]<0||s[0]>=60000||s[0]-last<240||s[1]<0||s[1]>R.W*100||s[2]<0||s[2]>R.H*100)throw invalid();
  last=s[0];const time=s[0]/1000,available=targets.filter(t=>t.born<=time&&!removed.has(t.id)),h=R.hit(available,time,s[1]/100,s[2]/100);
  if(h){removed.add(available[h.index].id);score+=h.points;}
 }
 return score;
}
function dto(r){const result=solo.dto(r);if(result.ranking.some(x=>x.score>72))throw invalid();return result;}
module.exports={issue,verify,dto};