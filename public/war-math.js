(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.WarMath=api;})(globalThis,()=>{'use strict';
const functions={sin:Math.sin,cos:Math.cos,tan:Math.tan,sqrt:Math.sqrt,abs:Math.abs,exp:Math.exp,log:Math.log};
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const fail=()=>{throw new Error('数式を確認してください。');};
function compile(raw){
 if(typeof raw!=='string'||raw.length>120)fail();
 const source=raw.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g,s=>'^'+Array.from(s,n=>'⁰¹²³⁴⁵⁶⁷⁸⁹'.indexOf(n)).join('')).normalize('NFKC').toLowerCase().replace(/−/g,'-').replace(/[×·]/g,'*').replace(/÷/g,'/').replace(/π/g,'pi').replace(/²/g,'^2').replace(/³/g,'^3');
 let tokens=[],i=0;
 while(i<source.length){if(/\s/.test(source[i])){i++;continue;}const m=source.slice(i).match(/^(?:\d+(?:\.\d*)?|\.\d+|sin|cos|tan|sqrt|abs|exp|log|pi|x|y|e|[+\-*/^()])/);if(!m)fail();tokens.push(m[0]);i+=m[0].length;if(tokens.length>100)fail();}
 const input=[];for(const t of tokens){const last=input.at(-1);if(last&&(/^(?:\d|\.)/.test(last)||['x','y','pi','e',')'].includes(last))&&(/^(?:\d|\.)/.test(t)||['x','y','pi','e','('].includes(t)||own(functions,t))){if(/^(?:\d|\.)/.test(last)&&/^(?:\d|\.)/.test(t))fail();input.push('*');}input.push(t);}
 let p=0,nodes=0;const node=f=>{if(++nodes>100)fail();return f;};
 function atom(depth){if(depth>32)fail();const t=input[p++];if(t==='('){const f=expr(depth+1);if(input[p++]!==')')fail();return f;}
 if(t==='x')return node(x=>x);if(t==='y')return node((x,y)=>y);if(t==='pi')return node(()=>Math.PI);if(t==='e')return node(()=>Math.E);
 if(t&&/^(?:\d|\.)/.test(t)){const v=Number(t);if(!Number.isFinite(v)||Math.abs(v)>1000000)fail();return node(()=>v);}
 if(own(functions,t)){if(input[p++]!=='(')fail();const f=expr(depth+1);if(input[p++]!==')')fail();return node((x,y)=>functions[t](f(x,y)));}
 fail();}
 function power(d){const a=atom(d);if(input[p]==='^'){p++;const b=unary(d+1);return node((x,y)=>Math.pow(a(x,y),b(x,y)));}return a;}
 function unary(d){if(d>32)fail();if(input[p]==='+'||input[p]==='-'){const sign=input[p++]==='-'?-1:1;const f=unary(d+1);return node((x,y)=>sign*f(x,y));}return power(d);}
 function product(d){let a=unary(d);while(input[p]==='*'||input[p]==='/'){const op=input[p++],left=a,b=unary(d);a=node((x,y)=>op==='*'?left(x,y)*b(x,y):left(x,y)/b(x,y));}return a;}
 function expr(d){let a=product(d);while(input[p]==='+'||input[p]==='-'){const op=input[p++],left=a,b=product(d);a=node((x,y)=>op==='+'?left(x,y)+b(x,y):left(x,y)-b(x,y));}return a;}
 const f=expr(0);if(p!==input.length)fail();return f;
}

const W=2000,H=1000,R=18,STEP=10;
const inside=p=>p[0]>=0&&p[0]<=W&&p[1]>=0&&p[1]<=H;
const dist=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
function equation(raw){if(typeof raw!=='string'||raw.length>120)fail();const s=raw.normalize('NFKC').replace(/＝/g,'=');const parts=s.split('=');if(parts.length>2||parts.some(x=>!x.trim()))fail();if(parts.length===1||(/^\s*y\s*$/.test(parts[0])&&!/y/i.test(parts[1]))){const f=compile(parts.at(-1));if(!Number.isFinite(f(0))||Math.abs(f(0))>1e-6)throw Error('原点を通る式にしてください');return {explicit:f};}const a=compile(parts[0]),b=compile(parts[1]),f=(x,y)=>a(x,y)-b(x,y);if(!Number.isFinite(f(0,0))||Math.abs(f(0,0))>1e-6)throw Error('原点を通る式にしてください');return {implicit:f};}
function paths(raw,origin,direction=1){const eq=equation(raw);if(eq.explicit){const out=[origin];for(let i=1;i<=1000;i++){const x=i*2*direction,y=eq.explicit(x),p=[origin[0]+x,origin[1]+y];if(!Number.isFinite(y)||!inside(p)||dist(p,out.at(-1))>65)break;out.push(p);}return out.length>1?[out]:[];}
 const f=eq.implicit,nx=202,ny=102,x0=-origin[0]-3.7,y0=-origin[1]-3.7,values=Array.from({length:ny},(_,j)=>Array.from({length:nx},(_,i)=>f(x0+i*STEP,y0+j*STEP))),nodes=new Map();
 const edges=new Map();function connect(a,b){if(!a||!b||a===b)return;if(!edges.has(a))edges.set(a,[]);if(!edges.has(b))edges.set(b,[]);edges.get(a).push(b);edges.get(b).push(a);}
 function crossing(i,j,k,l){const a=values[j][i],b=values[l][k];if(!Number.isFinite(a)||!Number.isFinite(b)||(a<0)===(b<0))return null;const key=i<k||i===k&&j<l?i+','+j+':'+k+','+l:k+','+l+':'+i+','+j;if(!nodes.has(key)){const t=a/(a-b);nodes.set(key,[origin[0]+x0+(i+(k-i)*t)*STEP,origin[1]+y0+(j+(l-j)*t)*STEP]);}return key;}
 for(let j=0;j<ny-1;j++)for(let i=0;i<nx-1;i++){const c=[crossing(i,j,i+1,j),crossing(i+1,j,i+1,j+1),crossing(i,j+1,i+1,j+1),crossing(i,j,i,j+1)].filter(Boolean);if(c.length===2)connect(c[0],c[1]);else if(c.length===4){connect(c[0],c[1]);connect(c[2],c[3]);}}
 let start=null,near=STEP*1.5;for(const [k,p] of nodes){const d=dist(p,origin);if(d<near){near=d;start=k;}}if(!start)return [];
 const visited=new Set([start]),out=[];for(const first of (edges.get(start)||[])){if(visited.has(first))continue;const line=[origin];let k=first;for(let n=0;n<600&&k&&!visited.has(k);n++){visited.add(k);const p=nodes.get(k);if(!inside(p))break;line.push(p);k=(edges.get(k)||[]).find(v=>!visited.has(v));}if(line.length>1)out.push(line);}return out;
}
function segmentDistance(a,b,p){const dx=b[0]-a[0],dy=b[1]-a[1],d=dx*dx+dy*dy,t=d?Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/d)):0;return {distance:Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy),t};}
function resolve(lines,players,obstacles,owner){const killed=new Set(),hit=new Set(),trails=[];for(const line of lines){const trail=[line[0]];let stopped=false;for(let i=1;i<line.length&&!stopped;i++){const a=line[i-1],b=line[i];let block=null;for(const o of obstacles){const d=segmentDistance(a,b,[o.x,o.y]);if(d.distance<=o.r&&(!block||d.t<block.t))block={id:o.id,t:d.t};}const end=block?[a[0]+(b[0]-a[0])*block.t,a[1]+(b[1]-a[1])*block.t]:b;for(const p of players)if(p.id!==owner&&p.alive&&segmentDistance(a,end,[p.x,p.y]).distance<=R)killed.add(p.id);trail.push(end.map(n=>Math.round(n)));if(block){hit.add(block.id);stopped=true;}}trails.push(trail.filter((_,i)=>i%2===0||i===trail.length-1));}return {killed:[...killed],obstacles:obstacles.map(o=>hit.has(o.id)?{...o,r:o.r-14}:o).filter(o=>o.r>=10),trails};}
return {W,H,R,paths,resolve,equation};
});