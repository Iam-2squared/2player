/* GRAPH ROCKET: local, turn-based coordinate-plane puzzle. */
(() => {
'use strict';
const R=GraphRocket,$=id=>document.getElementById(id),ns='http://www.w3.org/2000/svg';
const el=(tag,attrs={})=>{const n=document.createElementNS(ns,tag);for(const [k,v] of Object.entries(attrs))n.setAttribute(k,String(v));return n;};
const X=x=>40+36*x,Y=y=>400-36*y;
const pathData=points=>points.map((p,i)=>(i?'L':'M')+X(p.x).toFixed(2)+' '+Y(p.y).toFixed(2)).join(' ');
let level=0,ammo=0,bases=[],incoming=[],busy=false,ended=false,won=false,animation=0,generation=0;
const equation=$('equation'),fire=$('fire');
function text(id,value){$(id).textContent=value;}
function ship(p={x:0,y:0},angle=45){$('ship').setAttribute('transform','translate('+X(p.x)+' '+Y(p.y)+') rotate('+angle+')');}
function drawLabels(){
 const labels=$('labels');$('axes').append(el('path',{d:'M76 396V404M400 396V404M36 364H44M36 40H44'}));for(const i of [1,10]){for(const [x,y] of [[X(i),419],[22,Y(i)]]){const n=el('text',{x,y});n.textContent=i;labels.append(n);}}
 for(const [x,y,label] of [[18,419,'0'],[420,400,'x'],[40,20,'y']]){const n=el('text',{x,y});n.textContent=label;labels.append(n);}
}
function drawTargets(){
 const layer=$('targets');layer.replaceChildren();
 for(const t of [...bases,...incoming]){
  const g=el('g',{transform:'translate('+X(t.x)+' '+Y(t.y)+')','data-target':t.id});
  if(t.kind==='base'){
   g.append(el('circle',{r:15,fill:'#fa716e',opacity:.13}),el('path',{d:'M-13 5L-8 -8H8L13 5L8 10H-8Z',fill:'#53394e',stroke:'#ff857f','stroke-width':1.5}),el('path',{d:'M-6 -8V-14H6V-8M-17 -3H-11M11 -3H17M-6 4H6',stroke:'#ffb0a6','stroke-width':1.5,fill:'none'}),el('circle',{r:3,fill:'#ff857f'}));
  }else{
   const angle=Math.atan2(t.vy,t.vx)*180/Math.PI;
   const rock=el('g',{transform:'rotate('+(-angle)+')'});
   rock.append(el('path',{d:'M-4 -4L-17 -7M-4 0H-21M-4 4L-17 7',stroke:'#d79770','stroke-width':2,'stroke-linecap':'round'}),el('path',{d:'M-8 -3L-3 -9L5 -7L9 0L3 8L-6 6Z',fill:'#9d735f',stroke:'#ffe0b2','stroke-width':1.5}),el('circle',{cx:1,cy:-3,r:2,fill:'#684f4a'}));g.append(rock);
  }
  const label=el('text',{x:0,y:-17,fill:'#e0edf9','font-size':10,'text-anchor':'middle'});label.textContent='('+Number(t.x.toFixed(2))+', '+Number(t.y.toFixed(2))+')';g.append(label);layer.append(g);
 }
}
function hud(){text('stage',String(level+1).padStart(2,'0'));text('ammo',ammo);$('ammo').setAttribute('aria-label','残り発射回数 '+ammo);}
function controls(){equation.disabled=busy||ended;fire.disabled=busy||ended;for(const b of $('symbols').querySelectorAll('button'))b.disabled=busy||ended;$('next').hidden=!ended;text('next',won?(level+1<R.stageCount?'次のステージ':'もう一度'):'リトライ');}
function preview(){
 if(busy||ended)return;
 try{const points=R.trajectory(R.compile(equation.value));if(points.length<2)throw Error('原点から発射できる軌道を入力してください。');$('preview').setAttribute('d',pathData(points));text('status','');}
 catch(e){$('preview').setAttribute('d','');text('status',e.message);}
}
function drawStars(){let seed=914;const rand=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);for(let i=0;i<100;i++)$('stars').append(el('circle',{cx:rand()*440,cy:rand()*440,r:.35+rand()*1.05,fill:'#d6eaff',opacity:.15+rand()*.55}));}
function start(index){
 generation++;cancelAnimationFrame(animation);level=index;const s=R.stage(level);ammo=s.shots;bases=s.bases;incoming=s.incoming;busy=false;ended=false;won=false;equation.value='x';$('trail').setAttribute('d','');$('trail-glow').setAttribute('d','');drawTargets();hud();controls();ship();preview();
}
function end(success){ended=true;won=success;controls();text('status',success?(level+1===R.stageCount?'ALL CLEAR':'STAGE CLEAR'):'FAILED · '+(bases.length+incoming.length)+' LEFT');}
function complete(){busy=false;ship();drawTargets();hud();end(!bases.length&&!incoming.length);}
function launch(e){
 e.preventDefault();if(busy||ended||ammo<1)return;
 let points;try{points=R.trajectory(R.compile(equation.value));if(points.length<2)throw Error('原点から発射できる軌道を入力してください。');}catch(error){text('status',error.message);return;}
 const hits=R.impact(points,[...bases,...incoming]),mine=++generation;let cursor=0;ammo--;busy=true;controls();hud();text('status','');$('preview').setAttribute('d','');
 const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches,duration=reduced?0:850,startTime=performance.now();
 const step=now=>{
  if(mine!==generation)return;
  const progress=duration===0?1:Math.min(1,(now-startTime)/duration),i=Math.min(points.length-1,Math.floor(progress*(points.length-1)));
  while(cursor<hits.length&&hits[cursor].at<=i){const id=hits[cursor++].id;bases=bases.filter(t=>t.id!==id);incoming=incoming.filter(t=>t.id!==id);drawTargets();}
  const trail=pathData(points.slice(0,i+1));$('trail').setAttribute('d',trail);$('trail-glow').setAttribute('d',trail);const a=points[Math.max(0,i-1)],b=points[Math.max(1,i)];ship(points[i],90-Math.atan2(b.y-a.y,b.x-a.x)*180/Math.PI);
  if(progress<1)animation=requestAnimationFrame(step);else complete();
 };animation=requestAnimationFrame(step);
}
$('fire-form').addEventListener('submit',launch);equation.addEventListener('input',preview);
$('reset').onclick=()=>start(level);$('next').onclick=()=>won?start(level+1<R.stageCount?level+1:0):start(level);
for(const button of $('symbols').querySelectorAll('button'))button.onclick=()=>{if(busy||ended)return;const a=equation.selectionStart??equation.value.length,b=equation.selectionEnd??a;equation.setRangeText(button.dataset.symbol,a,b,'end');equation.focus();preview();};
drawStars();drawLabels();start(0);
})();