/* TEN LINK: deterministic, independently testable local puzzle rules. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.TenLink=api;})(globalThis,()=>{
 'use strict';
 const SIZE=5,COUNT=25;
 const adjacent=(a,b)=>Number.isInteger(a)&&Number.isInteger(b)&&a>=0&&b>=0&&a<COUNT&&b<COUNT&&a!==b&&Math.abs(Math.floor(a/SIZE)-Math.floor(b/SIZE))<=1&&Math.abs(a%SIZE-b%SIZE)<=1;
 const validBoard=board=>Array.isArray(board)&&board.length===COUNT&&board.every(n=>[1,2,3,4,5,10].includes(n));
 const total=(board,path)=>path.reduce((s,i)=>s+board[i],0);
 function extend(board,path,i){
  if(!Number.isInteger(i)||i<0||i>=COUNT)return path;
  if(!path.length)return [i];
  if(i===path.at(-1))return path;
  if(i===path.at(-2))return path.slice(0,-1);
  if(path.includes(i)||!adjacent(path.at(-1),i))return path;
  const gold=board[path[0]]===10;
  if(gold?board[i]!==10:board[i]===10||total(board,path)+board[i]>10)return path;
  return [...path,i];
 }
 function moveType(board,path){
  if(!validBoard(board)||!Array.isArray(path)||path.length<2||new Set(path).size!==path.length||path.some((n,i)=>!Number.isInteger(n)||n<0||n>=COUNT||(i>0&&!adjacent(path[i-1],n))))return null;
  if(path.every(i=>board[i]===10))return 'gold';
  if(path.every(i=>board[i]<10)&&total(board,path)===10)return 'ten';
  return null;
 }
 const roll=rng=>1+Math.min(4,Math.max(0,Math.floor(rng()*5)));
 function findMove(board){
  function walk(path){const last=path.at(-1),sum=total(board,path);if(path.length>=2&&moveType(board,path))return path;if(board[path[0]]!==10&&sum>=10)return null;
   for(let i=0;i<COUNT;i++){const next=extend(board,path,i);if(next.length===path.length+1){const found=walk(next);if(found)return found;}}return null;
  }
  for(let i=0;i<COUNT;i++){const p=walk([i]);if(p)return p;}return null;
 }
 function ensureMove(board,rng=Math.random){if(findMove(board))return {board,reshuffled:false};return {board:newBoard(rng),reshuffled:true};}
 function newBoard(rng=Math.random){const b=Array.from({length:COUNT},()=>roll(rng));if(!findMove(b)){b[0]=5;b[1]=5;}return b;}
 function apply(board,path,rng=Math.random){
  const type=moveType(board,path);if(!type)return null;
  const next=board.slice();for(const i of path)next[i]=roll(rng);
  if(type==='ten')next[path.at(-1)]=10;
  const playable=ensureMove(next,rng);
  const points=type==='ten'?100*path.length:1000*path.length*(path.length-1);
  return {...playable,points,type};
 }
 function seeded(seed){let state=seed>>>0;return ()=>{state=(Math.imul(1664525,state)+1013904223)>>>0;return state/4294967296;};}
 return {SIZE,COUNT,adjacent,validBoard,total,extend,moveType,findMove,newBoard,apply,seeded};
});
