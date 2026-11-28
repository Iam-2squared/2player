(() => {
'use strict';
const R=SkyTarget,$=id=>document.getElementById(id),canvas=$('scene'),ctx=canvas.getContext('2d'),W=R.W,H=R.H;
const land=matchMedia('(orientation: landscape)'),bg=document.createElement('canvas'),grass=document.createElement('canvas');bg.width=grass.width=W;bg.height=grass.height=H;
let state='intro',elapsed=0,lastFrame=performance.now(),spawned=0,targets=[],pieces=[],score=0,lastShot=-Infinity,aim={x:W/2,y:H/2},drag=null,flash=0;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
let rankToken=null,rankShots=[],scheduled=null,starting=false,submitting=false,rankVersion=0;
async function api(route,body){const response=await fetch('/api/sky/'+route,{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(8000),...(body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});if(!response.ok)throw Error(response.status===401?'ランキングはログイン後に利用できます。':'ランキングに接続できません。');const value=await response.json();if(value.ok!==true)throw Error('ランキングを取得できません。');return value;}
function displayRanking(rows){$('ranking-list').replaceChildren();for(const r of rows){const li=document.createElement('li');if(r.isYou)li.className='self';const rank=document.createElement('span'),name=document.createElement('strong'),points=document.createElement('span');rank.textContent=r.rank;name.textContent=r.name+(r.isYou?'（自分）':'');points.textContent=r.score+' pt';li.append(rank,name,points);$('ranking-list').append(li);}$('ranking-status').textContent=rows.length?'歴代最高得点':'まだ記録がありません。';}
async function loadRanking(){const seq=++rankVersion;$('ranking-refresh').disabled=true;try{const r=await api('ranking');if(seq===rankVersion)displayRanking(r.ranking);}catch(e){if(seq===rankVersion)$('ranking-status').textContent=e.message;}finally{if(seq===rankVersion)$('ranking-refresh').disabled=false;}}
function finishRanking(){const token=rankToken,shots=rankShots.slice(),expected=score;rankToken=null;$('rank-result').textContent=token?'ランキングに記録中…':'練習モード · ランキング対象外';if(!token)return;submitting=true;$('again').disabled=true;void api('finish',{token,shots}).then(r=>{if(r.score!==expected)throw Error('得点の照合に失敗しました。');rankVersion++;displayRanking(r.ranking);const own=r.ranking.find(x=>x.isYou);$('rank-result').textContent=own?'ランキング '+own.rank+'位 · 最高 '+own.score+' pt':'記録完了';}).catch(e=>{$('rank-result').textContent=e.message;}).finally(()=>{submitting=false;$('again').disabled=false;$('ranking-refresh').disabled=false;});}

function randomSeed(s){return()=>((s=(Math.imul(s,1664525)+1013904223)>>>0)/4294967296);}
function sceneArt(){
 const b=bg.getContext('2d'),r=randomSeed(194);let gradient=b.createLinearGradient(0,0,0,H);gradient.addColorStop(0,'#388bc9');gradient.addColorStop(.68,'#c7e7f1');gradient.addColorStop(1,'#cce8c5');b.fillStyle=gradient;b.fillRect(0,0,W,H);
 for(const [x,y,size] of [[130,90,1],[360,50,.8],[700,105,1.25],[900,42,.65]]){b.fillStyle='#f7fcffdb';for(const [dx,dy,rx,ry] of [[0,0,68,18],[-34,-7,31,18],[4,-17,39,26],[41,-3,32,17]]){b.beginPath();b.ellipse(x+dx*size,y+dy*size,rx*size,ry*size,0,0,Math.PI*2);b.fill();}}
 for(let layer=0;layer<3;layer++){b.fillStyle=['#a1c593','#7da86b','#659650'][layer];b.beginPath();b.moveTo(0,H);for(let x=0;x<=W;x+=8)b.lineTo(x,385+layer*26+Math.sin(x*.009+layer)*25+Math.cos(x*.019+layer)*11);b.lineTo(W,H);b.fill();}
 const g=grass.getContext('2d');g.fillStyle='#416b36';g.fillRect(0,496,W,44);
 for(let i=0;i<1800;i++){const x=r()*W,y=502+r()*48,edge=Math.max(0,1-Math.min(x,W-x)/220),h=22+r()*36+edge*(30+r()*57),bend=(r()-.5)*32;g.fillStyle=['#416e36','#5c903d','#76a448','#91b653','#345f34'][Math.floor(r()*5)];g.beginPath();g.moveTo(x-3,y);g.quadraticCurveTo(x+bend*.4,y-h*.65,x+bend,y-h);g.quadraticCurveTo(x+5,y-h*.45,x+5,y);g.fill();}
}
function targetArt(p,gold){ctx.save();ctx.translate(p.x,p.y);const rings=gold?['#ab7a24','#ffe7a0','#cf9c35','#fff0b6','#bd8c28']:['#334b57','#fff8e9','#c65e50','#fff8e9','#c65e50'];for(let i=0;i<5;i++){ctx.beginPath();ctx.arc(0,0,R.R*(1-i*.19),0,Math.PI*2);ctx.fillStyle=rings[i];ctx.fill();}ctx.restore();}
function breakTarget(p,gold){for(let i=0;i<10;i++){const a=Math.random()*Math.PI*2;pieces.push({x:p.x,y:p.y,vx:Math.cos(a)*(45+Math.random()*100),vy:p.vy*.2+Math.sin(a)*90,age:0,angle:a,color:gold?['#ffe4a1','#b8852d'][i%2]:['#f8f1dc','#b75c4c'][i%2]});}}
function draw(){
 const kickAge=elapsed-lastShot,kick=kickAge>=0&&kickAge<.18?10*Math.exp(-kickAge*24)*(1-kickAge/.18):0;
 const scope={x:aim.x,y:clamp(aim.y-kick,0,H)};
 ctx.drawImage(bg,0,0);const now=elapsed;
 for(const t of targets){const p=R.position(t,now);targetArt(p,t.gold);}
 for(const p of pieces){ctx.save();ctx.translate(p.x+p.vx*p.age,p.y+p.vy*p.age+R.G*p.age*p.age/2);ctx.rotate(p.angle+p.age*5);ctx.fillStyle=p.color;ctx.beginPath();ctx.moveTo(-6,-4);ctx.lineTo(8,-2);ctx.lineTo(1,7);ctx.closePath();ctx.fill();ctx.restore();}
 ctx.drawImage(grass,0,0);
 if(state==='play'){
  const radius=115;ctx.save();ctx.fillStyle='rgba(7,20,29,.42)';ctx.beginPath();ctx.rect(0,0,W,H);ctx.arc(scope.x,scope.y,radius,0,Math.PI*2,true);ctx.fill('evenodd');ctx.beginPath();ctx.arc(scope.x,scope.y,radius,0,Math.PI*2);ctx.strokeStyle='#142b37';ctx.lineWidth=9;ctx.stroke();ctx.strokeStyle='#f3f7f0';ctx.lineWidth=1;ctx.stroke();ctx.strokeStyle='#16272d';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(scope.x-radius,scope.y);ctx.lineTo(scope.x-9,scope.y);ctx.moveTo(scope.x+9,scope.y);ctx.lineTo(scope.x+radius,scope.y);ctx.moveTo(scope.x,scope.y-radius);ctx.lineTo(scope.x,scope.y-9);ctx.moveTo(scope.x,scope.y+9);ctx.lineTo(scope.x,scope.y+radius);ctx.stroke();ctx.fillStyle=flash>0?'#fff':'#b63f35';ctx.beginPath();ctx.arc(scope.x,scope.y,2.5,0,Math.PI*2);ctx.fill();ctx.restore();
 }
}
function view(next){state=next;$('intro').hidden=next!=='intro';$('count').hidden=next!=='count';$('result').hidden=next!=='result';$('hud').hidden=next!=='play';$('aim-zone').hidden=next!=='play';$('shoot').hidden=next!=='play';drag=null;}
async function start(){if(!land.matches||starting||submitting||state==='count'||state==='play')return;starting=true;$('start').disabled=true;$('again').disabled=true;rankToken=null;rankShots=[];scheduled=null;try{const r=await api('start',{});if(typeof r.token==='string'&&Number.isInteger(r.seed)){rankToken=r.token;scheduled=R.schedule(r.seed);}}catch{}finally{starting=false;$('start').disabled=false;$('again').disabled=false;}if(!land.matches)return;lastFrame=performance.now();elapsed=0;spawned=0;score=0;lastShot=-Infinity;targets=[];pieces=[];flash=0;aim={x:W/2,y:H/2};$('count').textContent='3';view('count');}
function syncFire(){const cooling=!R.canFire(elapsed,lastShot);$('shoot').classList.toggle('is-cooling',cooling);$('shoot').setAttribute('aria-disabled',String(cooling));}
function shoot(){if(state!=='play'||!land.matches||document.hidden||!R.canFire(Math.floor(elapsed*1000)/1000,lastShot))return;lastShot=Math.floor(elapsed*1000)/1000;flash=.075;syncFire();const sx=Math.round(aim.x*100),sy=Math.round(aim.y*100),time=lastShot;const covered=grass.getContext('2d').getImageData(Math.min(W-1,Math.floor(sx/100)),Math.min(H-1,Math.floor(sy/100)),1,1).data[3]>0;if(rankToken&&!covered)rankShots.push([Math.round(time*1000),sx,sy]);const hit=covered?null:R.hit(targets.filter(t=>t.born<=time),time,sx/100,sy/100);if(hit){const visible=targets.filter(t=>t.born<=time),t=visible[hit.index];targets=targets.filter(v=>v.id!==t.id);score+=hit.points;breakTarget(hit.p,t.gold);$('score').textContent=score;} }
function update(dt){
 if(state==='count'){elapsed+=dt;if(elapsed>=3){dt=elapsed-3;elapsed=0;view('play');$('score').textContent='0';$('time').textContent='60';}else $('count').textContent=Math.ceil(3-elapsed);}
 if(state==='play'){
  elapsed=Math.min(R.DURATION,elapsed+dt);while(spawned<R.DURATION&&spawned<=elapsed){targets.push(scheduled?scheduled[spawned]:R.target(spawned));spawned++;}
  targets=targets.filter(t=>R.alive(R.position(t,elapsed)));for(const p of pieces)p.age+=dt;pieces=pieces.filter(p=>p.y+p.vy*p.age+R.G*p.age*p.age/2<H+40&&p.age<3);
  flash=Math.max(0,flash-dt);$('time').textContent=Math.ceil(R.DURATION-elapsed);syncFire();
  if(elapsed>=R.DURATION){$('final').textContent=score;view('result');finishRanking();}
 }
}
function frame(now){const dt=Math.max(0,(now-lastFrame)/1000);lastFrame=now;if(land.matches&&!document.hidden){update(dt);draw();}requestAnimationFrame(frame);}
function release(e){if(drag?.id===e.pointerId)drag=null;}
$('aim-zone').addEventListener('pointerdown',e=>{if(state!=='play'||!land.matches||drag)return;e.preventDefault();drag={id:e.pointerId,x:e.clientX,y:e.clientY};e.currentTarget.setPointerCapture(e.pointerId);});
$('aim-zone').addEventListener('pointermove',e=>{if(drag?.id!==e.pointerId)return;const rect=canvas.getBoundingClientRect();aim.x=clamp(aim.x+(e.clientX-drag.x)*W/rect.width*1.7,0,W);aim.y=clamp(aim.y+(e.clientY-drag.y)*H/rect.height*1.7,0,H);drag.x=e.clientX;drag.y=e.clientY;});
for(const event of ['pointerup','pointercancel','lostpointercapture'])$('aim-zone').addEventListener(event,release);
// A second finger is not a primary pointer; fire on its own pointerdown, not on a synthetic click.
$('shoot').addEventListener('pointerdown',e=>{if(e.pointerType==='mouse'&&e.button!==0)return;e.preventDefault();shoot();});
$('shoot').addEventListener('click',e=>{if(e.detail===0)shoot();});$('start').onclick=start;$('again').onclick=start;
land.addEventListener('change',()=>{drag=null;lastFrame=performance.now();$('rotate-message').textContent=state==='play'||state==='count'?'横向きにすると再開':'横向きにしてプレイ';if(!land.matches&&!submitting)void loadRanking();});document.addEventListener('visibilitychange',()=>{drag=null;lastFrame=performance.now();});
document.addEventListener('keydown',e=>{if(state!=='play'||!land.matches||e.repeat)return;if(e.code==='Space'){e.preventDefault();shoot();}const d={ArrowLeft:[-14,0],ArrowRight:[14,0],ArrowUp:[0,-14],ArrowDown:[0,14]}[e.key];if(d){e.preventDefault();aim.x=clamp(aim.x+d[0],0,W);aim.y=clamp(aim.y+d[1],0,H);}});
$('ranking-refresh').onclick=loadRanking;sceneArt();view('intro');draw();if(!land.matches)void loadRanking();requestAnimationFrame(frame);
})();