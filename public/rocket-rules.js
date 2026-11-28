/* Safe mathematical expression parser. No eval, Function, or arbitrary JS. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.GraphRocket=api;})(globalThis,()=>{
'use strict';
const functions={sin:Math.sin,cos:Math.cos,tan:Math.tan,sqrt:Math.sqrt,abs:Math.abs,exp:Math.exp,log:Math.log};
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const fail=()=>{throw new Error('数式を確認してください。');};
function compile(raw){
 if(typeof raw!=='string'||raw.length>120)fail();
 const source=raw.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g,s=>'^'+Array.from(s,n=>'⁰¹²³⁴⁵⁶⁷⁸⁹'.indexOf(n)).join('')).normalize('NFKC').toLowerCase().replace(/^\s*y\s*=\s*/,'').replace(/−/g,'-').replace(/[×·]/g,'*').replace(/÷/g,'/').replace(/π/g,'pi').replace(/²/g,'^2').replace(/³/g,'^3');
 let tokens=[],i=0;
 while(i<source.length){if(/\s/.test(source[i])){i++;continue;}const m=source.slice(i).match(/^(?:\d+(?:\.\d*)?|\.\d+|sin|cos|tan|sqrt|abs|exp|log|pi|x|e|[+\-*/^()])/);if(!m)fail();tokens.push(m[0]);i+=m[0].length;if(tokens.length>100)fail();}
 const input=[];for(const t of tokens){const last=input.at(-1);if(last&&(/^(?:\d|\.)/.test(last)||['x','pi','e',')'].includes(last))&&(/^(?:\d|\.)/.test(t)||['x','pi','e','('].includes(t)||own(functions,t))){if(/^(?:\d|\.)/.test(last)&&/^(?:\d|\.)/.test(t))fail();input.push('*');}input.push(t);}
 let p=0,nodes=0;const node=f=>{if(++nodes>100)fail();return f;};
 function atom(depth){if(depth>32)fail();const t=input[p++];if(t==='('){const f=expr(depth+1);if(input[p++]!==')')fail();return f;}
 if(t==='x')return node(x=>x);if(t==='pi')return node(()=>Math.PI);if(t==='e')return node(()=>Math.E);
 if(t&&/^(?:\d|\.)/.test(t)){const v=Number(t);if(!Number.isFinite(v)||Math.abs(v)>1000000)fail();return node(()=>v);}
 if(own(functions,t)){if(input[p++]!=='(')fail();const f=expr(depth+1);if(input[p++]!==')')fail();return node(x=>functions[t](f(x)));}
 fail();}
 function power(d){const a=atom(d);if(input[p]==='^'){p++;const b=unary(d+1);return node(x=>Math.pow(a(x),b(x)));}return a;}
 function unary(d){if(d>32)fail();if(input[p]==='+'||input[p]==='-'){const sign=input[p++]==='-'?-1:1;const f=unary(d+1);return node(x=>sign*f(x));}return power(d);}
 function product(d){let a=unary(d);while(input[p]==='*'||input[p]==='/'){const op=input[p++],left=a,b=unary(d);a=node(x=>op==='*'?left(x)*b(x):left(x)/b(x));}return a;}
 function expr(d){let a=product(d);while(input[p]==='+'||input[p]==='-'){const op=input[p++],left=a,b=product(d);a=node(x=>op==='+'?left(x)+b(x):left(x)-b(x));}return a;}
 const f=expr(0);if(p!==input.length)fail();return f;
}
// Each stage has a verified single continuous solution; no origin-passing line hits every target.
const STAGES=[
 {bases:[{x:4,y:2},{x:8,y:8}],incoming:[],shots:1},
 {bases:[{x:3,y:7},{x:9,y:3}],incoming:[{x:6,y:8,vx:-.6,vy:-.8}],shots:1},
 {bases:[{x:2,y:4.5},{x:8,y:6}],incoming:[{x:6,y:1.5,vx:-.8,vy:-.2}],shots:1},
 {bases:[{x:2,y:7.4},{x:8,y:8}],incoming:[{x:5,y:.5,vx:-1,vy:-.1},{x:10,y:1,vx:-1,vy:-.1}],shots:1}
];
function stage(index){const s=STAGES[index%STAGES.length];return {bases:s.bases.map((b,i)=>({...b,id:'b'+i,kind:'base'})),incoming:s.incoming.map((b,i)=>({...b,id:'m'+i,kind:'meteor'})),shots:s.shots};}
function trajectory(f){const y=f(0);if(!Number.isFinite(y)||Math.abs(y)>1e-7)throw new Error('原点 (0, 0) を通る数式にしてください。');const points=[{x:0,y:0}];for(let i=1;i<=500;i++){const x=i*.02,y=f(x);if(!Number.isFinite(y)||y<0||y>10||Math.abs(y-points.at(-1).y)>1.5)break;points.push({x,y});}return points;}
function impact(points,targets){const hits=[];for(let i=1;i<points.length;i++){const p=points[i],a=points[i-1],dx=p.x-a.x,dy=p.y-a.y,den=dx*dx+dy*dy;for(const t of targets){if(hits.some(h=>h.id===t.id))continue;const k=den?Math.max(0,Math.min(1,((t.x-a.x)*dx+(t.y-a.y)*dy)/den)):0;if(Math.hypot(t.x-a.x-k*dx,t.y-a.y-k*dy)<=.46)hits.push({id:t.id,at:i});}}return hits;}
return {compile,stage,trajectory,impact,stageCount:STAGES.length};
});