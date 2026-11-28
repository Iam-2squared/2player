'use strict';
const crypto=require('node:crypto'),M=require('../public/war-math.js'),{HttpError}=require('./errors.cjs');
const empty=()=>({players:[],obstacles:[],queue:[],deadline:0,shot:null,serial:0});
const TTL=45000,TURN=25000;
const invalid=(message='操作を確認してください。')=>new HttpError(400,message,'INVALID_WAR_ACTION');
function spawn(s,rng){
 for(let i=0;i<500;i++){const x=Math.round(45+rng()*(M.W-90)),y=Math.round(45+rng()*(M.H-90));if(s.players.every(p=>!p.alive||Math.hypot(x-p.x,y-p.y)>65)&&s.obstacles.every(o=>Math.hypot(x-o.x,y-o.y)>o.r+35))return {x,y};}
 throw new HttpError(409,'フィールドに空きがありません。','WAR_FULL');
}
function obstacle(s,p,rng){const others=s.players.filter(q=>q.id!==p.id&&q.alive);if(!others.length||s.obstacles.length>=128)return;const q=others[Math.floor(rng()*others.length)];for(let i=0;i<25;i++){const t=.25+rng()*.5,x=Math.round(p.x+(q.x-p.x)*t),y=Math.round(p.y+(q.y-p.y)*t),r=Math.round(24+rng()*48);if(x<r||x>M.W-r||y<r||y>M.H-r||s.players.some(v=>v.alive&&Math.hypot(x-v.x,y-v.y)<r+M.R+15)||s.obstacles.some(v=>Math.hypot(x-v.x,y-v.y)<r+v.r+10))continue;s.obstacles.push({id:crypto.randomUUID(),x,y,r});return;}}
function normalize(s,now,rng){
 const active=new Set(s.players.filter(p=>now-p.seen<TTL).map(p=>p.id));s.players=s.players.filter(p=>active.has(p.id));s.queue=s.queue.filter(id=>active.has(id)&&s.players.some(p=>p.id===id&&p.alive));
 for(const p of s.players)p.wait=p.wait.filter(id=>active.has(id));
 if(!s.players.length){Object.assign(s,empty());return;}
 for(const p of s.players){if(!p.alive&&(!p.wait.length||!s.players.some(q=>q.id!==p.id&&q.alive))){Object.assign(p,spawn(s,rng),{alive:true,wait:[]});s.queue.push(p.id);}}
 if(s.queue.length&&!s.deadline)s.deadline=now+TURN;
 if(!s.queue.length)s.deadline=0;
}
function advance(s,actor,now,rng){s.queue=s.queue.filter(id=>id!==actor);if(s.players.some(p=>p.id===actor&&p.alive))s.queue.push(actor);for(const p of s.players)if(!p.alive)p.wait=p.wait.filter(id=>id!==actor);s.deadline=now+TURN;normalize(s,now,rng);}
function mutate(original,action,actor,body,now=Date.now(),rng=Math.random){
 const s=structuredClone(original),oldTurn=s.queue[0];normalize(s,now,rng);if(oldTurn!==s.queue[0])s.deadline=s.queue.length?now+TURN:0;
 if(s.queue.length&&now>=s.deadline)advance(s,s.queue[0],now,rng);
 let p=s.players.find(p=>p.id===actor.memberId);
 if(action==='leave'){if(p){s.players=s.players.filter(q=>q!==p);s.queue=s.queue.filter(id=>id!==p.id);for(const q of s.players)q.wait=q.wait.filter(id=>id!==p.id);if(oldTurn===p.id)s.deadline=now+TURN;normalize(s,now,rng);}return s;}
 if(!p){if(action==='fire'||action==='pass')throw invalid('参加し直してください。');if(s.players.length>=41)throw new HttpError(409,'参加人数の上限です。','WAR_FULL');p={id:actor.memberId,name:actor.name,...spawn(s,rng),alive:true,seen:now,wait:[]};obstacle(s,p,rng);s.players.push(p);s.queue.push(p.id);if(s.queue.length===1)s.deadline=now+TURN;}
 else if(now-p.seen>=10000||action!=='poll'){p.seen=now;p.name=actor.name;}
 if(action==='fire'||action==='pass'){
  if(!p.alive||s.queue[0]!==p.id||s.queue.length<2)throw new HttpError(409,'まだ自分の順番ではありません。','WAR_TURN');
  if(body.serial!==s.serial)throw new HttpError(409,'ターンが更新されました。','WAR_TURN');
  if(action==='fire'){
   let lines;try{lines=M.paths(body.equation,[p.x,p.y],body.direction);}catch(e){throw invalid(e.message);}
   if(!lines.length)throw invalid('フィールド内に軌道がありません。');
   const result=M.resolve(lines,s.players,s.obstacles,p.id);s.obstacles=result.obstacles;
   const dead=new Set(result.killed),wait=s.players.filter(q=>q.alive&&!dead.has(q.id)).map(q=>q.id);
   for(const q of s.players)if(dead.has(q.id)){q.alive=false;q.wait=[...wait];}
   s.queue=s.queue.filter(id=>!dead.has(id));s.shot={serial:s.serial+1,by:p.id,paths:result.trails,at:now,killed:result.killed};
   advance(s,p.id,now,rng); // shooter has just acted; a full next cycle is required
   for(const q of s.players)if(dead.has(q.id)&&!q.alive&&!q.wait.includes(p.id))q.wait.push(p.id);
  }else advance(s,p.id,now,rng);
  s.serial++;
 }else if(s.queue.length===1&&s.players.length===1)s.deadline=now+TURN;
 return s;
}
function dto(s,actor,now){return {ok:true,world:{players:s.players.map(({id,name,x,y,alive})=>({id,name,x,y,alive})),obstacles:s.obstacles,turn:s.queue[0]||null,deadline:s.deadline,serverNow:now,serial:s.serial,shot:s.shot,you:actor.memberId}};}
async function handle(rpc,action,actor,body,config){
 for(let i=0;i<5;i++){const current=await rpc('read',actor,config),now=Date.now(),s=current.state||empty(),next=mutate(s,action,actor,body,now);
  if(JSON.stringify(s)===JSON.stringify(next))return dto(next,actor,now);
  const saved=await rpc('cas',{...actor,revision:current.revision,state:next},config);if(saved.applied)return dto(next,actor,now);
 }
 throw new HttpError(409,'更新が競合しました。もう一度お試しください。','WAR_CONFLICT');
}
module.exports={empty,mutate,dto,handle,TTL,TURN};