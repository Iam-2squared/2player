'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {createServer}=require('../scripts/dev.cjs');
const {HttpError}=require('../server/errors.cjs');
const {rankingDTO,requestUrl}=require('../server/router.cjs');
const member={id:'11111111-1111-4111-8111-111111111111',name:'本人'};
const token='R'.repeat(43);

test('ranking DTO accepts only sorted wins and positive points from server',()=>{
 const rows=[
   {rank:1,name:'A',wins:5,points:12,isYou:false},
   {rank:2,name:'本人',wins:3,points:7,isYou:true},
   {rank:3,name:'C',wins:1,points:1,isYou:false}
 ];
 assert.deepEqual(rankingDTO({ranking:rows}),{ok:true,ranking:rows});
 assert.deepEqual(rankingDTO({ranking:[]}),{ok:true,ranking:[]});
 for(const bad of [
  [{...rows[0],wins:0}],
  [{...rows[0],points:16}],
  [{...rows[0],points:4}],
  [{...rows[0],rank:2}],
  [{...rows[0],name:''}],
  [{...rows[0],isYou:'true'}],
  [rows[1],rows[0]],
  [{...rows[0],isYou:true},{...rows[1],rank:2}]
 ]) assert.throws(()=>rankingDTO({ranking:bad}),error=>error instanceof HttpError && error.code==='INVALID_RANKING');
});

test('ranking uses a KGS-authenticated, read-only server call with fixed actor',async t=>{
 const requests=[];
 const config={test:true,origins:[],cookieSecret:'c'.repeat(40),sessionCookie:'two_player_session',attemptCookie:'two_player_attempt'};
 const server=createServer({getConfig:()=>config,
  identity:{requireMember:async req=>{
    if(req.headers.cookie!=='two_player_session='+token)throw new HttpError(401,'ログインしてください。','AUTHENTICATION_REQUIRED');
    return member;
  }},
  rankingRpc:async(action,input)=>{requests.push({action,input});return {ok:true,ranking:[
    {rank:1,name:'本人',wins:2,points:5,isYou:true}
  ]};},
  rpc:async()=>{throw Error('ranking must not hit game mutations');},
  lobbyRpc:async()=>{throw Error('ranking must not touch lobby');},
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 const origin='http://127.0.0.1:'+server.address().port;
 config.origins=[origin];
 const read=(path,opts={})=>fetch(origin+path,{headers:{origin,cookie:'two_player_session='+token,...opts}});
 assert.equal((await read('/api/ranking',{cookie:''})).status,401);
 assert.equal((await read('/api/ranking',{origin:'https://foreign.invalid'})).status,403);
 assert.equal((await read('/api/ranking?memberId=any')).status,400);
 const get=await read('/api/index?route=ranking&path=ranking');
 assert.equal(get.status,200);
 assert.deepEqual(await get.json(),{ok:true,ranking:[{rank:1,name:'本人',wins:2,points:5,isYou:true}]});
 assert.deepEqual(requests,[{action:'list',input:{memberId:member.id,name:member.name}}]);
 assert.equal(requestUrl({url:'/api/index?route=ranking&path=ranking'}).pathname,'/api/ranking');
});

test('lobby presents no stake controls before a verified opponent exists',()=>{
 const html=fs.readFileSync(require.resolve('../public/index.html'),'utf8');
 const js=fs.readFileSync(require.resolve('../public/app.js'),'utf8');
 const lobby=html.split('<section id="lobby-view"')[1].split('<section id="room-view"')[0];
 assert(!/lobby-stake|賭け額|type="number"/.test(lobby));
 assert(lobby.includes('id="random-button"'));
 assert(lobby.includes('id="online-users"'));
 assert(lobby.includes('id="ranking-users"'));
 assert(!js.includes("$('lobby-stake')"));
 assert(js.includes('function preferences() { return { stake: 100 }; }'));
 assert(js.includes('void refreshRanking(true)'));
 assert(html.includes('id="stake"') && html.includes('対戦相手が決まりました'));
});
