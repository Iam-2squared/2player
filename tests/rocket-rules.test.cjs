'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),R=require('../public/rocket-rules.js');
test('mathematics precedence, superscripts, implicit products and functions',()=>{
 for(const [s,x,y] of [['-x^2',3,-9],['2^3^2',0,512],['２ｘ',3,6],['x²/4',4,4],['x³/8',4,8],['x⁴/16',4,16],['x^4/16',4,16],['x¹⁰',2,1024],['2(x+1)',3,8],['sin(pi/2)*x',2,2],['sqrt(abs(x))',-4,2],['y= -2x',-3,6],['x^-2',2,.25]])assert.ok(Math.abs(R.compile(s)(x)-y)<1e-9,s);
});
test('rejects arbitrary code, malformed math and non-origin trajectories',()=>{
 for(const s of ['alert(1)','globalThis','x;1','constructor','x=1','1..2','sin x','x+','()','x**2','x'.repeat(121)])assert.throws(()=>R.compile(s),undefined,s);
 for(const s of ['x+1','1/x','log(x)'])assert.throws(()=>R.trajectory(R.compile(s)),/原点/);
 assert.equal(R.trajectory(R.compile('sqrt(-x)')).length,1);
 assert.equal(R.trajectory(R.compile('-x')).length,1);
});
test('first quadrant path boundaries',()=>{
 for(const s of ['x^2/4','x','sqrt(x)','sin(x)']){const p=R.trajectory(R.compile(s));assert.deepEqual(p[0],{x:0,y:0});assert.ok(p.length>100);assert.ok(p.every(v=>v.x>=0&&v.x<=10&&v.y>=0&&v.y<=10));}
});
const solutions=['x^2/8','x(10-x)/3','x(x-6)^2/8+x/4','x(10-x)(x-5)^2/20+x/10'];
test('each level is solvable in exactly one launch, with all targets counted once',()=>{
 for(let i=0;i<R.stageCount;i++){const s=R.stage(i),targets=[...s.bases,...s.incoming],points=R.trajectory(R.compile(solutions[i])),hits=R.impact(points,targets);assert.equal(s.shots,1);assert.deepEqual(new Set(hits.map(h=>h.id)),new Set(targets.map(t=>t.id)),'stage '+(i+1));assert.equal(hits.length,targets.length);assert.ok(targets.every(t=>t.x>0&&t.x<=10&&t.y>=0&&t.y<=10));}
});
test('no single straight line through the origin can hit all targets, even within collision tolerance',()=>{
 for(let i=0;i<R.stageCount;i++){const s=R.stage(i),targets=[...s.bases,...s.incoming];const intervals=targets.map(t=>{const angle=Math.atan2(t.y,t.x),r=Math.asin(.46/Math.hypot(t.x,t.y));return [angle-r,angle+r];});assert.ok(Math.max(...intervals.map(v=>v[0]))>Math.min(...intervals.map(v=>v[1])),'stage '+(i+1));}
});
test('cubic and quartic stages have ordered, alternating heights even with hit tolerance',()=>{
 for(const i of [2,3]){const s=R.stage(i),t=[{x:0,y:0},...s.bases,...s.incoming].sort((a,b)=>a.x-b.x);for(let j=1;j<t.length;j++){assert.ok(t[j].x-t[j-1].x>.92);assert.ok((t[j].y-t[j-1].y)*(j%2?1:-1)>.92);}}
});
test('failed launch leaves targets and a new attempt restores layout',()=>{const s=R.stage(0),hits=R.impact(R.trajectory(R.compile('x')),s.bases);assert.equal(hits.length,1);s.bases.pop();assert.equal(R.stage(0).bases.length,2);});
