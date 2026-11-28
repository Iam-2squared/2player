'use strict';
const crypto=require('node:crypto'),{HttpError}=require('./errors.cjs');
const TTL=45000,INVITE=60000,COUNT=3000,INTERMISSION=1800,RELOAD=1500,COOLDOWN=120,MAX_ROUND=3;
const empty=()=>({players:[],invites:[],matches:[]});
const opposite=d=>({left:'right',right:'left',up:'up'})[d]||null;
const error=(message,code='DUEL_STATE')=>new HttpError(409,message,code);
const seat=id=>({id,ready:false,peek:null,ammo:10,reloadAt:0,lastShot:0,seq:0});
const matchFor=(s,id)=>s.matches.find(m=>m.seats.some(p=>p.id===id));
function finish(m,winner,now,forfeit=false){m.phase='finished';m.winner=winner;m.until=now+60000;m.forfeit=forfeit;for(const p of m.seats)p.peek=null;}
function normalize(s,now){
 s.players=s.players.filter(p=>now-p.seen<TTL);
 const online=new Set(s.players.map(p=>p.id));s.invites=s.invites.filter(i=>i.until>now&&online.has(i.from)&&online.has(i.to));
 for(const m of s.matches){
  if(m.phase==='finished')continue;
  const present=m.seats.filter(p=>online.has(p.id));
  if(present.length<2){finish(m,present[0]?.id??null,now,true);continue;}
  if(m.phase==='countdown'&&now>=m.until){m.phase='play';m.until=0;}
  if(m.phase==='roundEnd'&&now>=m.until){m.round++;m.seats=m.seats.map(p=>({...seat(p.id),ready:p.ready,seq:p.seq}));m.shots=[];m.roundWinner=null;m.phase='countdown';m.until=now+COUNT;}
  if(m.phase==='play')for(const p of m.seats)if(p.reloadAt&&now>=p.reloadAt){p.ammo=10;p.reloadAt=0;}
 }
 s.matches=s.matches.filter(m=>m.phase!=='finished'||m.until>now&&m.seats.some(p=>online.has(p.id)));
}
function mutate(original,action,actor,body={},now=Date.now()){
 const s=structuredClone(original),id=actor.memberId;let p=s.players.find(p=>p.id===id);
 // An active client renews presence before pruning; a stale client cannot revive an expired match.
 if(p&&now-p.seen<TTL&&(action!=='poll'||now-p.seen>=8000)){p.seen=now;p.name=actor.name;}
 normalize(s,now);p=s.players.find(p=>p.id===id);
 if(action==='leave'){
  s.players=s.players.filter(p=>p.id!==id);s.invites=s.invites.filter(i=>i.from!==id&&i.to!==id);
  const m=matchFor(s,id);if(m){if(m.phase==='finished'){m.seats=m.seats.filter(p=>p.id!==id);}else{const other=m.seats.find(p=>p.id!==id);finish(m,other?.id??null,now,true);m.seats=m.seats.filter(p=>p.id!==id);}}
  normalize(s,now);return s;
 }
 if(!p){if(action!=='poll')throw error('対戦一覧を開き直してください。');if(s.players.length>=41)throw error('参加人数の上限です。');p={id,name:actor.name,seen:now};s.players.push(p);}
 let m=matchFor(s,id);
 if(action==='poll')return s;
 if(action==='invite'){
  const target=s.players.find(p=>p.id===body.targetId&&p.id!==id);
  if(m||!target||matchFor(s,target.id)||s.invites.some(i=>i.from===id||i.to===id||i.from===target.id||i.to===target.id))throw error('この相手には招待できません。');
  s.invites.push({id:crypto.randomUUID(),from:id,to:target.id,until:now+INVITE});return s;
 }
 if(['accept','decline','cancel'].includes(action)){
  const i=s.invites.find(i=>i.id===body.inviteId);
  if(!i||(action==='cancel'?i.from!==id:i.to!==id))throw error('招待が見つかりません。');
  if(action==='accept'){
   if(m||matchFor(s,i.from)||!s.players.some(p=>p.id===i.from)||s.matches.length>=20)throw error('対戦を開始できません。');
   const names=[i.from,id].map(v=>s.players.find(p=>p.id===v).name);
   s.matches.push({id:crypto.randomUUID(),seats:[seat(i.from),seat(id)],names,ids:[i.from,id],wins:[0,0],round:1,phase:'ready',until:0,roundWinner:null,winner:null,shots:[],event:0,forfeit:false});
   s.invites=s.invites.filter(v=>![i.from,id].includes(v.from)&&![i.from,id].includes(v.to));
  }else s.invites=s.invites.filter(v=>v.id!==i.id);
  return s;
 }
 if(action==='return'){
  if(!m||m.id!==body.matchId||m.phase!=='finished')throw error('対戦はまだ終了していません。');
  m.seats=m.seats.filter(p=>p.id!==id);if(!m.seats.length)s.matches=s.matches.filter(v=>v!==m);return s;
 }
 if(!m||m.id!==body.matchId)throw error('対戦が見つかりません。');
 const self=m.seats.find(p=>p.id===id),other=m.seats.find(p=>p.id!==id);
 if(body.round!==m.round)throw error('ラウンドが更新されました。');
 if(body.seq<=self.seq) return s; // duplicate/reordered mutations cannot fire twice
 if(body.seq!==self.seq+1)throw error('操作順が更新されました。');
 if(action==='ready'){
  if(m.phase!=='ready')throw error('準備時間は終了しました。');
  self.ready=body.landscape===true;if(m.seats.length===2&&m.seats.every(p=>p.ready)){m.phase='countdown';m.until=now+COUNT;}
 }else if(action==='cover'){
  if(m.phase==='ready'){self.ready=false;}else if(m.phase==='countdown'){self.ready=false;m.phase='ready';m.until=0;}else if(m.phase==='play')self.peek=null;
 }else if(action==='peek'){
  if(m.phase!=='play'||!['left','right','up'].includes(body.direction))throw error('まだプレイできません。');self.peek=body.direction;
 }else if(action==='fire'){
  if(m.phase!=='play'||!self.peek||!other)throw error('覗いてから発射してください。');
  if(self.reloadAt||self.ammo<=0||now-self.lastShot<COOLDOWN)throw error('発射間隔を確認してください。','DUEL_COOLDOWN');
  self.lastShot=now;self.ammo--;if(self.ammo===0)self.reloadAt=now+RELOAD;
  const hit=other.peek===opposite(self.peek);m.shots.push({id:++m.event,by:id,direction:self.peek,at:now,hit});m.shots=m.shots.slice(-20);
  if(hit){const i=m.ids.indexOf(id);m.wins[i]++;m.roundWinner=id;
   if(m.wins[i]>=2)finish(m,id,now);else{m.phase='roundEnd';m.until=now+INTERMISSION;for(const p of m.seats)p.peek=null;}}
 }else throw error('操作を確認してください。');
 self.seq=body.seq;return s;
}
function dto(s,actor,now){
 const id=actor.memberId,m=matchFor(s,id),self=m?.seats.find(p=>p.id===id),other=m?.seats.find(p=>p.id!==id);
 const name=x=>s.players.find(p=>p.id===x)?.name||'対戦相手';
 const invitations=s.invites.filter(i=>i.from===id||i.to===id).map(i=>({id:i.id,incoming:i.to===id,name:name(i.to===id?i.from:i.to),until:i.until}));
 const online=s.players.filter(p=>p.id!==id).map(p=>({id:p.id,name:p.name,busy:!!matchFor(s,p.id)||s.invites.some(i=>i.from===p.id||i.to===p.id)}));
 const index=m?.ids.indexOf(id);
 return {ok:true,serverNow:now,online,invitations,match:m?{id:m.id,round:m.round,phase:m.phase,until:m.until,wins:[m.wins[index],m.wins[1-index]],you:id,opponent:m.ids[1-index],opponentName:m.names[1-index],ready:self.ready,otherReady:other?.ready??false,peek:self.peek,otherPeek:self.peek?opposite(other?.peek):null,ammo:self.ammo,reloadAt:self.reloadAt,seq:self.seq,roundWinner:m.roundWinner,winner:m.winner,forfeit:m.forfeit,shots:m.shots}:null};
}
async function handle(rpc,action,actor,body,config){
 for(let i=0;i<6;i++){const current=await rpc('read',actor,config),now=Date.now(),s=current.state||empty(),next=mutate(s,action,actor,body,now);if(JSON.stringify(s)===JSON.stringify(next))return dto(next,actor,now);const saved=await rpc('cas',{...actor,revision:current.revision,state:next},config);if(saved.applied)return dto(next,actor,now);}
 throw error('更新が競合しました。再試行してください。','DUEL_CONFLICT');
}
module.exports={empty,opposite,mutate,dto,handle,COUNT,INTERMISSION,RELOAD,COOLDOWN,TTL};
