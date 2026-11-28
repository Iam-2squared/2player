'use strict';
const crypto=require('node:crypto'),{HttpError}=require('./errors.cjs');
const TTL=45000,INVITE=60000,TURN=60000;
const empty=()=>({players:[],invites:[],matches:[]});

const error=(message,code='SUBMARINE_STATE')=>new HttpError(409,message,code);
const seat=id=>({id,ready:false,ships:[],shots:[],seq:0});
const matchFor=(s,id)=>s.matches.find(m=>m.seats.some(p=>p.id===id));
function finish(m,winner,now,forfeit=false){m.phase='finished';m.winner=winner;m.until=now+60000;m.forfeit=forfeit;m.turn=null;}
function normalize(s,now){
 s.players=s.players.filter(p=>now-p.seen<TTL);
 const online=new Set(s.players.map(p=>p.id));s.invites=s.invites.filter(i=>i.until>now&&online.has(i.from)&&online.has(i.to));
 for(const m of s.matches){
  if(m.phase==='finished')continue;
  const present=m.seats.filter(p=>online.has(p.id));
  if(present.length<2){finish(m,present[0]?.id??null,now,true);continue;}
  if(m.phase==='play'&&now>=m.until){m.turn=m.ids.find(id=>id!==m.turn);m.until=now+TURN;m.event++;}
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
   s.matches.push({id:crypto.randomUUID(),seats:[seat(i.from),seat(id)],names,ids:[i.from,id],phase:'setup',until:0,winner:null,turn:null,event:0,lastShot:null,forfeit:false});
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
 if(body.seq<=self.seq)return s;
 if(body.seq!==self.seq+1)throw error('操作順が更新されました。');
 if(action==='ready'){
  if(m.phase!=='setup'||self.ready||!validFleet(body.ships))throw error('潜水艦を正しく配置してください。');
  self.ships=structuredClone(body.ships);self.ready=true;
  if(other?.ready){m.phase='play';m.turn=m.ids[crypto.randomInt(2)];m.until=now+TURN;m.event++;}
 }else if(action==='fire'){
  if(m.phase!=='play'||m.turn!==id||body.event!==m.event||!other||!Number.isInteger(body.cell)||body.cell<0||body.cell>=50||self.shots.some(q=>q.cell===body.cell))throw error('攻撃できません。');
  const hit=other.ships.some(v=>cells(v).includes(body.cell));
  self.shots.push({cell:body.cell,hit});m.lastShot={by:id,cell:body.cell,hit,event:++m.event,at:now};
  if(self.shots.filter(q=>q.hit).length===14)finish(m,id,now);else if(!hit){m.turn=other.id;m.until=now+TURN;}
 }else throw error('操作を確認してください。');
 self.seq=body.seq;return s;
}
function cells(ship){if(!Array.isArray(ship)||ship.length!==3)return [];const [size,start,d]=ship;if(![2,3,4,5].includes(size)||!Number.isInteger(start)||start<0||start>=50||!['h','v'].includes(d))return [];if(d==='h'&&start%10+size>10||d==='v'&&Math.floor(start/10)+size>5)return [];return Array.from({length:size},(_,i)=>start+i*(d==='h'?1:10));}
function validFleet(ships){return Array.isArray(ships)&&ships.length===4&&new Set(ships.map(s=>s?.[0])).size===4&&ships.every(s=>cells(s).length===s[0])&&new Set(ships.flatMap(cells)).size===14;}
function dto(s,actor,now){
 const id=actor.memberId,m=matchFor(s,id),self=m?.seats.find(p=>p.id===id),other=m?.seats.find(p=>p.id!==id);
 const name=x=>s.players.find(p=>p.id===x)?.name||'対戦相手';
 const invitations=s.invites.filter(i=>i.from===id||i.to===id).map(i=>({id:i.id,incoming:i.to===id,name:name(i.to===id?i.from:i.to),until:i.until}));
 const online=s.players.filter(p=>p.id!==id).map(p=>({id:p.id,name:p.name,busy:!!matchFor(s,p.id)||s.invites.some(i=>i.from===p.id||i.to===p.id)}));
 return {ok:true,serverNow:now,online,invitations,match:m?{id:m.id,phase:m.phase,until:m.until,you:id,opponentName:m.names[1-m.ids.indexOf(id)],ready:self.ready,otherReady:other?.ready??false,ships:self.ships,shots:self.shots,incoming:other?.shots||[],seq:self.seq,event:m.event,turn:m.turn,winner:m.winner,forfeit:m.forfeit,lastShot:m.lastShot}:null};
}
async function handle(rpc,action,actor,body,config){
 for(let i=0;i<6;i++){const current=await rpc('read',actor,config),now=Date.now(),s=current.state||empty(),next=mutate(s,action,actor,body,now);if(JSON.stringify(s)===JSON.stringify(next))return dto(next,actor,now);const saved=await rpc('cas',{...actor,revision:current.revision,state:next},config);if(saved.applied)return dto(next,actor,now);}
 throw error('更新が競合しました。再試行してください。','SUBMARINE_CONFLICT');
}
module.exports={empty,mutate,dto,handle,cells,validFleet,TURN,TTL};
