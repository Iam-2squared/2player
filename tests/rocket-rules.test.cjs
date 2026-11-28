'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),R=require('../public/rocket-rules.js');
test('mathematics precedence, superscripts, implicit products and functions',()=>{
 for(const [s,x,y] of [['-x^2',3,-9],['2^3^2',0,512],['２ｘ',3,6],['x²/4',4,4],['2(x+1)',3,8],['sin(pi/2)*x',2,2],['sqrt(abs(x))',-4,2],['y= -2x',-3,6],['x^-2',2,.25]])assert.ok(Math.abs(R.compile(s)(x)-y)<1e-9,s);
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
test('stage one solvable with linear functions; collision counted once',()=>{
 const s=R.stage(0),p=R.trajectory(R.compile('x'));
 assert.deepEqual(R.impact(p,s.bases).map(h=>h.id),['b0']);
 assert.deepEqual(R.impact(R.trajectory(R.compile('x/4')),s.bases).map(h=>h.id),['b1']);
 assert.deepEqual(R.impact(R.trajectory(R.compile('-x')),s.bases),[]);
});
test('all four stage layouts are independent and every target can be reached',()=>{
 for(let i=0;i<R.stageCount;i++){const s=R.stage(i);for(const t of [...s.bases,...s.incoming]){assert.ok(t.x>0&&t.x<=10&&t.y>0&&t.y<=10);const p=R.trajectory(R.compile('('+t.y+')/('+t.x+')*x'));assert.ok(R.impact(p,[t]).some(h=>h.id===t.id));}s.bases.pop();assert.notDeepEqual(s.bases,R.stage(i).bases);}
});
test('incoming movement and origin damage',()=>{
 const m={id:'m',x:2,y:0,vx:-1,vy:0};const a=R.advance([m]);assert.equal(a.damage,0);assert.equal(a.survivors[0].x,1);assert.equal(m.x,2);const b=R.advance(a.survivors);assert.equal(b.damage,1);assert.equal(b.survivors.length,0);
});
