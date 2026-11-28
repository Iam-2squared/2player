/* GRAPH ROCKET: local, turn-based coordinate-plane puzzle. */
(() => {
'use strict';
const R=GraphRocket,$=id=>document.getElementById(id),ns='http://www.w3.org/2000/svg';
const el=(tag,attrs={})=>{const n=document.createElementNS(ns,tag);for(const [k,v] of Object.entries(attrs))n.setAttribute(k,String(v));return n;};
const X=x=>220+20*x,Y=y=>220-20*y;
const pathData=points=>points.map((p,i)=>(i?'L':'M')+X(p.x).toFixed(2)+' '+Y(p.y).toFixed(2)).join(' ');
let level=0,lives=3,ammo=0,bases=[],incoming=[],direction=1,busy=false,ended=false,won=false,animation=0,generation=0;
const equation=$('equation'),fire=$('fire');
function text(id,value){$(id).textContent=value;}
function ship(p={x:0,y:0},angle=90){$('ship').setAttribute('transform','translate('+X(p.x)+' '+Y(p.y)+') rotate('+angle+')');}
function drawLabels(){
 const labels=$('labels');for(let i=-10;i<=10;i+=2){if(!i)continue;for(const [x,y] of [[X(i),233],[206,Y(i)]]){const n=el('text',{x,y});n.textContent=i;labels.append(n);}}
 for(const [x,y,label] of [[230,233,'0'],[426,233,'x'],[206,12,'y']]){const n=el('text',{x,y});n.textContent=label;labels.append(n);}
}
function drawTargets(){
 const layer=$('targets');layer.replaceChildren();
 for(const t of [...bases,...incoming]){
  const g=el('g',{transform:'translate('+X(t.x)+' '+Y(t.y)+')','data-target':t.id});
  if(t.kind==='base'){
   g.append(el('path',{d:'M-9 8V-5L0 -12L9 -5V8Z',fill:'#754353',stroke:'#ff857f','stroke-width':2}),el('path',{d:'M-3 8V0H3V8',fill:'none',stroke:'#ff857f','stroke-width':2}));
  }else{
   const angle=Math.atan2(t.vy,t.vx)*180/Math.PI;
   const rock=el('g',{transform:'rotate('+(-angle)+')'});
   rock.append(el('path',{d:'M-4 -4L-17 -7M-4 0H-21M-4 4L-17 7',stroke:'#d79770','stroke-width':2,'stroke-linecap':'round'}),el('circle',{r:7,fill:'#e0a77c',stroke:'#ffe0b2','stroke-width':1.5}));g.append(rock);
  }
  const label=el('text',{x:0,y:-17,fill:'#e0edf9','font-size':10,'text-anchor':'middle'});label.textContent='('+Number(t.x.toFixed(2))+', '+Number(t.y.toFixed(2))+')';g.append(label);layer.append(g);
 }
}
function hud(){text('stage',String(level+1).padStart(2,'0'));text('lives','♥'.repeat(lives)+'♡'.repeat(3-lives));text('ammo',ammo);$('lives').setAttribute('aria-label','残りライフ '+lives);$('ammo').setAttribute('aria-label','残り発射回数 '+ammo);}
function controls(){equation.disabled=busy||ended;fire.disabled=busy||ended;$('left').disabled=busy||ended;$('right').disabled=busy||ended;for(const b of $('symbols').querySelectorAll('button'))b.disabled=busy||ended;$('next').hidden=!ended;text('next',won?(level+1<R.stageCount?'次のステージ':'もう一度'):'リトライ');}
function preview(){
 if(busy||ended)return;
 try{const points=R.trajectory(R.compile(equation.value),direction);if(points.length<2)throw Error('原点から発射できる軌道を入力してください。');$('preview').setAttribute('d',pathData(points));text('status','');}
 catch(e){$('preview').setAttribute('d','');text('status',e.message);}
}
function choose(d){if(busy||ended)return;direction=d;$('left').setAttribute('aria-pressed',String(d===-1));$('right').setAttribute('aria-pressed',String(d===1));ship(undefined,d===1?90:-90);preview();}
function start(index,restoreLives=false){
 generation++;cancelAnimationFrame(animation);level=index;if(restoreLives)lives=3;const s=R.stage(level);ammo=s.shots;bases=s.bases;incoming=s.incoming;busy=false;ended=false;won=false;equation.value='x';$('trail').setAttribute('d','');drawTargets();hud();controls();choose(1);
}
function end(success){ended=true;won=success;controls();text('status',success?(level+1===R.stageCount?'ALL CLEAR':'STAGE CLEAR'):'GAME OVER');}
function complete(hits){
 const next=R.advance(incoming);incoming=next.survivors;lives=Math.max(0,lives-next.damage);busy=false;ship(undefined,direction===1?90:-90);drawTargets();hud();controls();
 if(!bases.length&&!incoming.length&&lives>0){end(true);return;}
 if(lives===0||ammo===0){end(false);return;}
 preview();text('status',(hits?hits+' HIT':'MISS')+(next.damage?' · '+next.damage+' DAMAGE':''));
}
function launch(e){
 e.preventDefault();if(busy||ended||ammo<1)return;
 let points;try{points=R.trajectory(R.compile(equation.value),direction);if(points.length<2)throw Error('原点から発射できる軌道を入力してください。');}catch(error){text('status',error.message);return;}
 const hits=R.impact(points,[...bases,...incoming]),mine=++generation;let cursor=0;ammo--;busy=true;controls();hud();text('status','');$('preview').setAttribute('d','');
 const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches,duration=reduced?0:850,startTime=performance.now();
 const step=now=>{
  if(mine!==generation)return;
  const progress=duration===0?1:Math.min(1,(now-startTime)/duration),i=Math.min(points.length-1,Math.floor(progress*(points.length-1)));
  while(cursor<hits.length&&hits[cursor].at<=i){const id=hits[cursor++].id;bases=bases.filter(t=>t.id!==id);incoming=incoming.filter(t=>t.id!==id);drawTargets();}
  $('trail').setAttribute('d',pathData(points.slice(0,i+1)));const a=points[Math.max(0,i-1)],b=points[Math.max(1,i)];ship(points[i],90-Math.atan2(b.y-a.y,b.x-a.x)*180/Math.PI);
  if(progress<1)animation=requestAnimationFrame(step);else complete(hits.length);
 };animation=requestAnimationFrame(step);
}
$('fire-form').addEventListener('submit',launch);equation.addEventListener('input',preview);$('left').onclick=()=>choose(-1);$('right').onclick=()=>choose(1);
$('reset').onclick=()=>start(0,true);$('next').onclick=()=>won&&level+1<R.stageCount?start(level+1):start(0,true);
for(const button of $('symbols').querySelectorAll('button'))button.onclick=()=>{if(busy||ended)return;const a=equation.selectionStart??equation.value.length,b=equation.selectionEnd??a;equation.setRangeText(button.dataset.symbol,a,b,'end');equation.focus();preview();};
drawLabels();start(0,true);
})();