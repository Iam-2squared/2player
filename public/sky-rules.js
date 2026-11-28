(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.SkyTarget=api;})(globalThis,()=>{
'use strict';
const W=960,H=540,R=24,PPM=38,G=9.81*PPM,DURATION=60,INTERVAL=.24;
function target(second,rng=Math.random){
 const side=rng()<.5?1:-1,angle=(45+rng()*27)*Math.PI/180,y=480+rng()*25,apex=65+rng()*205,up=Math.sqrt(2*G*(y-apex));
 return {id:second,born:second,x:side===1?40+rng()*60:W-40-rng()*60,y,vx:side*up/Math.tan(angle),vy:-up,gold:second>0&&second%15===0};
}
function position(t,time){const a=Math.max(0,time-t.born);return{x:t.x+t.vx*a,y:t.y+t.vy*a+G*a*a/2,vy:t.vy+G*a};}
function alive(p){return p.y<H+R*2&&p.x>-R*2&&p.x<W+R*2;}
function hit(targets,time,x,y){for(let i=targets.length-1;i>=0;i--){const t=targets[i],p=position(t,time);if(alive(p)&&Math.hypot(x-p.x,y-p.y)<=R)return {index:i,points:t.gold?5:1,p};}return null;}
function canFire(time,last){return time>=0&&time<DURATION&&time-last>=INTERVAL-1e-9;}
return {W,H,R,PPM,G,DURATION,INTERVAL,target,position,alive,hit,canFire};
});