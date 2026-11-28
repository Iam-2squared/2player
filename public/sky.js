(() => {
'use strict';
const R=SkyTarget,$=id=>document.getElementById(id),canvas=$('scene'),ctx=canvas.getContext('2d'),W=R.W,H=R.H;
const land=matchMedia('(orientation: landscape)'),bg=document.createElement('canvas'),grass=document.createElement('canvas');bg.width=grass.width=W;bg.height=grass.height=H;
let state='intro',elapsed=0,lastFrame=performance.now(),spawned=0,targets=[],pieces=[],score=0,lastShot=-Infinity,aim={x:W/2,y:H/2},drag=null,flash=0;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
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
 ctx.drawImage(bg,0,0);const now=elapsed;
 for(const t of targets){const p=R.position(t,now);targetArt(p,t.gold);}
 for(const p of pieces){ctx.save();ctx.translate(p.x+p.vx*p.age,p.y+p.vy*p.age+R.G*p.age*p.age/2);ctx.rotate(p.angle+p.age*5);ctx.fillStyle=p.color;ctx.beginPath();ctx.moveTo(-6,-4);ctx.lineTo(8,-2);ctx.lineTo(1,7);ctx.closePath();ctx.fill();ctx.restore();}
 ctx.drawImage(grass,0,0);
 if(state==='play'){
  const radius=115;ctx.save();ctx.fillStyle='rgba(7,20,29,.42)';ctx.beginPath();ctx.rect(0,0,W,H);ctx.arc(aim.x,aim.y,radius,0,Math.PI*2,true);ctx.fill('evenodd');ctx.beginPath();ctx.arc(aim.x,aim.y,radius,0,Math.PI*2);ctx.strokeStyle='#142b37';ctx.lineWidth=9;ctx.stroke();ctx.strokeStyle='#f3f7f0';ctx.lineWidth=1;ctx.stroke();ctx.strokeStyle='#16272d';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(aim.x-radius,aim.y);ctx.lineTo(aim.x-9,aim.y);ctx.moveTo(aim.x+9,aim.y);ctx.lineTo(aim.x+radius,aim.y);ctx.moveTo(aim.x,aim.y-radius);ctx.lineTo(aim.x,aim.y-9);ctx.moveTo(aim.x,aim.y+9);ctx.lineTo(aim.x,aim.y+radius);ctx.stroke();ctx.fillStyle=flash>0?'#fff':'#b63f35';ctx.beginPath();ctx.arc(aim.x,aim.y,2.5,0,Math.PI*2);ctx.fill();ctx.restore();
 }
}
function view(next){state=next;$('intro').hidden=next!=='intro';$('count').hidden=next!=='count';$('result').hidden=next!=='result';$('hud').hidden=next!=='play';$('aim-zone').hidden=next!=='play';$('shoot').hidden=next!=='play';drag=null;}
function start(){if(!land.matches)return;elapsed=0;spawned=0;score=0;lastShot=-Infinity;targets=[];pieces=[];flash=0;aim={x:W/2,y:H/2};$('count').textContent='3';view('count');}
function shoot(){if(state!=='play'||!land.matches||document.hidden||!R.canFire(elapsed,lastShot))return;lastShot=elapsed;flash=.075;const hit=R.hit(targets,elapsed,aim.x,aim.y);if(hit){const [t]=targets.splice(hit.index,1);score+=hit.points;breakTarget(hit.p,t.gold);$('score').textContent=score;} }
function update(dt){
 if(state==='count'){elapsed+=dt;if(elapsed>=3){elapsed=0;view('play');$('score').textContent='0';$('time').textContent='60';}else $('count').textContent=Math.ceil(3-elapsed);}
 if(state==='play'){
  elapsed=Math.min(R.DURATION,elapsed+dt);while(spawned<R.DURATION&&spawned<=elapsed){targets.push(R.target(spawned));spawned++;}
  targets=targets.filter(t=>R.alive(R.position(t,elapsed)));for(const p of pieces)p.age+=dt;pieces=pieces.filter(p=>p.y+p.vy*p.age+R.G*p.age*p.age/2<H+40&&p.age<3);
  flash=Math.max(0,flash-dt);$('time').textContent=Math.ceil(R.DURATION-elapsed);$('shoot').disabled=!R.canFire(elapsed,lastShot);
  if(elapsed>=R.DURATION){$('final').textContent=score;view('result');}
 }
}
function frame(now){const dt=Math.max(0,(now-lastFrame)/1000);lastFrame=now;if(land.matches&&!document.hidden){update(dt);draw();}requestAnimationFrame(frame);}
function release(e){if(drag?.id===e.pointerId)drag=null;}
$('aim-zone').addEventListener('pointerdown',e=>{if(state!=='play'||!land.matches||drag)return;e.preventDefault();drag={id:e.pointerId,x:e.clientX,y:e.clientY};e.currentTarget.setPointerCapture(e.pointerId);});
$('aim-zone').addEventListener('pointermove',e=>{if(drag?.id!==e.pointerId)return;const rect=canvas.getBoundingClientRect();aim.x=clamp(aim.x+(e.clientX-drag.x)*W/rect.width*1.7,0,W);aim.y=clamp(aim.y+(e.clientY-drag.y)*H/rect.height*1.7,0,H);drag.x=e.clientX;drag.y=e.clientY;});
for(const event of ['pointerup','pointercancel','lostpointercapture'])$('aim-zone').addEventListener(event,release);
$('shoot').addEventListener('click',shoot);$('start').onclick=start;$('again').onclick=start;
land.addEventListener('change',()=>{drag=null;lastFrame=performance.now();});document.addEventListener('visibilitychange',()=>{drag=null;lastFrame=performance.now();});
document.addEventListener('keydown',e=>{if(state!=='play'||!land.matches||e.repeat)return;if(e.code==='Space'){e.preventDefault();shoot();}const d={ArrowLeft:[-14,0],ArrowRight:[14,0],ArrowUp:[0,-14],ArrowDown:[0,14]}[e.key];if(d){e.preventDefault();aim.x=clamp(aim.x+d[0],0,W);aim.y=clamp(aim.y+d[1],0,H);}});
sceneArt();view('intro');draw();requestAnimationFrame(frame);
})();