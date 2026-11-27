(() => {
 'use strict';
 const R=TenLink,$=id=>document.getElementById(id),ns='http://www.w3.org/2000/svg',fmt=n=>n.toLocaleString('ja-JP');
 const make=(tag,attrs={})=>{const e=document.createElementNS(ns,tag);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,String(v));return e;};
 const pos=i=>[50+(i%5)*100,50+Math.floor(i/5)*100];
 const recordKey='2player.ten-link.best.v1';
 const getBest=()=>{try{const n=Number(localStorage.getItem(recordKey));return Number.isSafeInteger(n)&&n>=0?n:0;}catch{return 0;}};
 let board=[],path=[],score=0,deadline=0,timer=0,active=false,pointer=null,lastPoint=null,dragged=false;
 const nodes=[];let chain;
 function draw(svg,values,chosen=[],interactive=false){
  svg.replaceChildren();const wires=make('g',{class:'wire','aria-hidden':'true'});svg.append(wires);
  for(let i=0;i<25;i++)for(let j=i+1;j<25;j++)if(R.adjacent(i,j)){const [x1,y1]=pos(i),[x2,y2]=pos(j);wires.append(make('line',{x1,y1,x2,y2}));}
  const line=make('polyline',{class:'chain',points:chosen.map(i=>pos(i).join(',')).join(' ')});svg.append(line);if(interactive)chain=line;
  for(let i=0;i<25;i++){const [cx,cy]=pos(i),g=make('g',{class:'node'+(chosen.includes(i)?' selected':''),'data-index':i,'data-number':values[i]});
   if(interactive){g.setAttribute('role','button');g.setAttribute('tabindex','0');g.setAttribute('aria-label','行'+(Math.floor(i/5)+1)+' 列'+(i%5+1)+' 数字'+values[i]);g.setAttribute('aria-pressed',String(chosen.includes(i)));nodes[i]=g;}
   const t=make('text',{x:cx,y:cy});t.textContent=values[i];g.append(make('circle',{cx,cy,r:41}),t);svg.append(g);}
 }
 function paintPath(){chain.setAttribute('points',path.map(i=>pos(i).join(',')).join(' '));nodes.forEach((n,i)=>{n.classList.toggle('selected',path.includes(i));n.setAttribute('aria-pressed',String(path.includes(i)));});$('sum').textContent=R.total(board,path);$('commit').disabled=!R.moveType(board,path);$('clear').disabled=!path.length;}
 function tick(){if(!active)return false;const left=Math.max(0,deadline-performance.now());$('timer').value=left/1000;$('seconds').textContent=Math.ceil(left/1000);if(left<=0){finish();return false;}return true;}
 function clear(){path=[];if(active)paintPath();}
 function extend(i){if(!tick())return;path=R.extend(board,path,i);paintPath();}
 function commit(){if(!tick())return;const move=R.apply(board,path);if(!move){$('feedback').textContent='合計10、または10同士をつなげてください。';clear();return;}board=move.board;score+=move.points;path=[];$('score').textContent=fmt(score);draw($('board'),board,[],true);paintPath();$('feedback').textContent='+'+fmt(move.points)+(move.type==='gold'?' · GOLD BONUS':'')+(move.reshuffled?' · 盤面を更新しました':'');}
 function start(){clearInterval(timer);board=R.newBoard();path=[];score=0;pointer=null;lastPoint=null;dragged=false;active=true;deadline=performance.now()+60000;$('intro').hidden=true;$('result').hidden=true;$('play').hidden=false;$('score').textContent='0';$('feedback').textContent='数字をつないで10を作る';draw($('board'),board,[],true);paintPath();tick();timer=setInterval(tick,100);}
 function finish(){if(!active)return;active=false;clearInterval(timer);pointer=null;lastPoint=null;const best=getBest();if(score>best){try{localStorage.setItem(recordKey,String(score));}catch{}}
  $('final-score').textContent=fmt(score);$('record').textContent=score>best?'NEW BEST · '+fmt(score):'最高得点 '+fmt(best);$('best').textContent=fmt(Math.max(best,score));$('play').hidden=true;$('result').hidden=false;}
 const svg=$('board');
 function point(e){const rect=svg.getBoundingClientRect();return [(e.clientX-rect.left)*500/rect.width,(e.clientY-rect.top)*500/rect.height];}
 function hit([x,y]){const col=Math.round((x-50)/100),row=Math.round((y-50)/100);if(col<0||col>4||row<0||row>4||Math.hypot(x-(50+100*col),y-(50+100*row))>43)return null;return row*5+col;}
 function trace(p){if(!lastPoint){lastPoint=p;return;}const [x,y]=lastPoint,steps=Math.max(1,Math.ceil(Math.hypot(p[0]-x,p[1]-y)/15));for(let k=1;k<=steps;k++){const i=hit([x+(p[0]-x)*k/steps,y+(p[1]-y)*k/steps]);if(i!==null&&i!==path.at(-1))extend(i);}lastPoint=p;}
 svg.addEventListener('pointerdown',e=>{if(!tick()||pointer!==null||e.button!==0)return;const p=point(e),i=hit(p);if(i===null)return;e.preventDefault();pointer=e.pointerId;lastPoint=p;dragged=false;svg.setPointerCapture(pointer);if(path.length&&!R.adjacent(path.at(-1),i)&&path.at(-1)!==i)clear();extend(i);});
 svg.addEventListener('pointermove',e=>{if(pointer!==e.pointerId||!active)return;e.preventDefault();const p=point(e);if(Math.hypot(p[0]-lastPoint[0],p[1]-lastPoint[1])>2)dragged=true;trace(p);});
 svg.addEventListener('pointerup',e=>{if(pointer!==e.pointerId)return;trace(point(e));pointer=null;lastPoint=null;if(active&&R.moveType(board,path))commit();else if(active&&dragged)clear();});
 svg.addEventListener('pointercancel',()=>{pointer=null;lastPoint=null;clear();});
 svg.addEventListener('lostpointercapture',()=>{if(pointer!==null){pointer=null;lastPoint=null;clear();}});
 svg.addEventListener('keydown',e=>{const g=e.target.closest('.node');if(!g)return;const i=Number(g.dataset.index);if(e.key==='Enter'||e.key===' '){e.preventDefault();extend(i);if(R.moveType(board,path)){commit();nodes[i].focus();}}else if(e.key==='Escape'){e.preventDefault();clear();}else{const d={ArrowLeft:-1,ArrowRight:1,ArrowUp:-5,ArrowDown:5}[e.key];if(d&&R.adjacent(i,i+d)){e.preventDefault();nodes[i+d].focus();}}});
 $('start').onclick=start;$('again').onclick=start;$('quit').onclick=finish;$('commit').onclick=commit;$('clear').onclick=clear;
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)tick();else if(active){pointer=null;lastPoint=null;clear();}});
 $('best').textContent=fmt(getBest());draw($('demo'),[1,2,3,4,5,3,2,4,5,10,2,5,1,3,10,3,1,1,1,2,4,3,2,2,5],[6,11,16,22]);
})();