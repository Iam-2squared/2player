/* Prevent accidental page zoom while preserving ordinary one-finger scrolling. */
(() => {
 'use strict';
 const stop=e=>{if(e.cancelable)e.preventDefault();};
 for(const event of ['gesturestart','gesturechange','gestureend'])document.addEventListener(event,stop,{passive:false});
 document.addEventListener('touchmove',e=>{if(e.touches.length>1)stop(e);},{passive:false});
 document.addEventListener('wheel',e=>{if(e.ctrlKey)stop(e);},{passive:false});
})();