'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {createServer}=require('../scripts/dev.cjs');
const {HttpError}=require('../server/errors.cjs');
const {stampDTO,socialDTO,liveGamesDTO,spectateDTO,requestUrl}=require('../server/router.cjs');
const physics=require('../public/physics.js');
const actor={id:'11111111-1111-4111-8111-111111111111',name:'観戦ユーザー'};
const matchId='22222222-2222-4222-8222-222222222222';
const token='S'.repeat(43);
const now='2026-11-12T03:00:00.000Z';
function currentMatch(){
 return {id:matchId,status:'playing',turn:'host',round:5,version:2,
  host:{name:'A',memberId:'PRIVATE'},guest:{name:'B',memberId:'PRIVATE'},
  scores:{host:1,guest:0},state:physics.initialState(),
  turnStartedAt:now,turnExpiresAt:'2026-11-12T03:01:00.000Z',serverNow:now,
  lastRound:{round:4,goal:null,frames:[physics.initialState()],inputs:{private:'not exposed'}},
  code:'SECRET',pot:10000000,escrow:10000000,stake:5000000,
  _processing:{claimToken:'PRIVATE'},wallet:{balance:123}};
}
const stamp={id:'42',stampId:3,fromName:'A',sentAt:now};
const social={viewers:['観戦ユーザー'],stamp};
test('social DTO strict fixed stamps, small spectator list and no financial secrets',()=>{
 assert.deepEqual(stampDTO(stamp),stamp);
 assert.deepEqual(socialDTO({social}),social);
 for(const bad of [null,{...stamp,stampId:6},{...stamp,id:'a'}, {...stamp,fromName:''},{...stamp,stampId:'1'}]){
  assert.throws(()=>stampDTO(bad),error=>error.code==='INVALID_SOCIAL');
 }
 for(const bad of [{viewers:['good',42],stamp:null},{viewers:Array(21).fill('A'),stamp:null},{viewers:[],stamp:{...stamp,stampId:6}}]){
  assert.throws(()=>socialDTO({social:bad}),error=>error.code==='INVALID_SOCIAL');
 }
 const raw=currentMatch(),out=spectateDTO({match:raw,social});
 assert.equal(out.match.lastRound.round,4);
 assert.deepEqual(out.match.lastRound.frames,[physics.initialState()]);
 const serialized=JSON.stringify(out);
 for(const secret of ['PRIVATE','SECRET','claimToken','"wallet"','"stake"','"pot"','"escrow"','"code"','"memberId"'])
  assert(!serialized.includes(secret),'spectator must not receive '+secret);
 assert.deepEqual(out.social,social);
 const games=liveGamesDTO({games:[{id:matchId,host:'A',guest:'B',scores:{host:1,guest:0},round:5}]});
 assert.equal(games.games.length,1);
 assert.throws(()=>spectateDTO({match:{...raw,round:4},social}),error=>error.code==='INVALID_SPECTATE');
 assert.throws(()=>liveGamesDTO({games:[{id:matchId,host:'A',guest:'B',scores:{host:4,guest:0},round:5}]}),error=>error.code==='INVALID_SPECTATE');
});
test('spectator and stamps require a real KGS session, exact inputs, and same-origin authorisation',async t=>{
 const calls=[];
 const config={test:true,origins:[],cookieSecret:'c'.repeat(40),sessionCookie:'two_player_session',attemptCookie:'two_player_attempt'};
 const server=createServer({getConfig:()=>config,
  identity:{requireMember:async req=>{
   if(req.headers.cookie!=='two_player_session='+token)throw new HttpError(401,'ログインしてください。','AUTHENTICATION_REQUIRED');
   return actor;
  }},
  socialRpc:async(action,input)=>{
   calls.push({action,input});
   if(action==='list')return {ok:true,games:[{id:matchId,host:'A',guest:'B',scores:{host:1,guest:0},round:5}]};
   if(action==='watch')return {ok:true,match:currentMatch(),social};
   if(action==='feed')return {ok:true,social};
   if(action==='stamp')return {ok:true,stamp};
   if(action==='leave')return {ok:true};
   throw Error('Unexpected action');
  },
  rpc:async()=>{throw Error('Read-only spectator route used game mutator');},
  lobbyRpc:async()=>{throw Error('Read-only spectator route used the lobby writer');},
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 const origin='http://127.0.0.1:'+server.address().port;
 config.origins=[origin];
 const req=(p,body,options={})=>fetch(origin+'/api/'+p,{
  method:body===undefined?'GET':'POST',
  headers:{origin,cookie:'two_player_session='+token,...(body===undefined?{}:{'content-type':'application/json'}),...options},
  ...(body===undefined?{}:{body:JSON.stringify(body)})
 });
 assert.equal((await req('watch/games',undefined,{cookie:''})).status,401);
 assert.equal((await req('watch?matchId='+matchId+'&afterRound=0',undefined,{origin:'https://other.invalid'})).status,403);
 assert.equal((await req('social/stamp',{matchId,stampId:1},{origin:'https://other.invalid'})).status,403);
 assert.equal(calls.length,0,'security checks before reaching Target');
 assert.equal((await req('watch/games?extra=1')).status,400);
 assert.equal((await req('watch?matchId='+matchId+'&afterRound=-1')).status,400);
 assert.equal((await req('watch?matchId='+matchId+'&afterRound=0&memberId='+actor.id)).status,400);
 assert.equal((await req('social/stamp',{matchId,stampId:1,text:'custom'})).status,400);
 assert.equal((await req('social/stamp',{matchId,stampId:6})).status,400);
 assert.equal((await req('social/stamp',{matchId,stampId:'1'})).status,400);
 assert.equal((await req('social/feed?matchId='+matchId+'&other=1')).status,400);
 assert.equal(calls.length,0,'invalid requests cannot touch database');
 const games=await req('index?route=watch%2Fgames&path=watch%2Fgames');
 assert.equal(games.status,200);
 assert.equal((await games.json()).games.length,1);
 const watch=await req('index?route=watch&path=watch&matchId='+matchId+'&afterRound=0');
 assert.equal(watch.status,200);
 const result=await watch.json();
 assert.equal(result.match.host.name,'A');
 assert(!JSON.stringify(result).includes('SECRET'));
 assert(!JSON.stringify(result).includes('claimToken'));
 const event=await req('social/stamp',{matchId,stampId:3});
 assert.equal(event.status,200);
 assert.deepEqual((await event.json()).stamp,stamp);
 const feed=await req('social/feed?matchId='+matchId);
 assert.deepEqual((await feed.json()).social,social);
 assert.equal((await req('watch/leave',{matchId})).status,200);
 assert.deepEqual(calls.map(c=>c.action),['list','watch','stamp','feed','leave']);
 for(const call of calls){
  assert.equal(call.input.memberId,actor.id);
  assert.equal(call.input.name,actor.name);
 }
 assert.equal(requestUrl({url:'/api/index?route=watch%2Fgames&path=watch%2Fgames'}).pathname,'/api/watch/games');
 assert.equal(requestUrl({url:'/api/index?route=social%2Fstamp&path=social%2Fstamp'}).pathname,'/api/social/stamp');
});
test('only five built-in text labels are displayed at the center of the court',()=>{
 const html=fs.readFileSync(require.resolve('../public/index.html'),'utf8');
 const app=fs.readFileSync(require.resolve('../public/app.js'),'utf8');
 const css=fs.readFileSync(require.resolve('../public/style.css'),'utf8');
 for(const word of ['おつw','うっまw','お願いします','あざした〜w','もう一戦しよ']) assert(html.includes('>'+word+'</button>'));
 for(const id of ['pitch-stamp','spectate-stamp','spectate-pitch','watching-status','live-games','exit-spectate'])
  assert(html.includes('id="'+id+'"'));
 assert(html.includes('aria-label="観戦中のコート。操作はできません。"'));
 assert(css.includes('top:54%'));
 assert(app.includes("S.watch?2000:S.match?1800:2500"));
 assert(app.includes('await refreshSpectate()'));
 assert(app.includes('function processSocial'));
 assert(app.includes('function showStamp'));
 assert(app.includes('if(!S.user||S.match||S.watch||S.busy'));
});
