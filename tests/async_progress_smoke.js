'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert');
const root=path.resolve(__dirname,'..');let source=fs.readFileSync(path.join(root,'server.js'),'utf8');
source=source.replace("const WebSocket = require('ws');",`const WebSocket={OPEN:1,Server:class DummyServer{constructor(){this.clients=new Set()}on(){}}};`);
source=source.replace(/server\.listen\(PORT,[\s\S]*?\);\s*$/m,`module.exports={rooms,createRoom,addCpu,startGame,playCard,doPick,submitPickTargets,resolvePairChoice,ensureRoomProgress,playableIds,clearAllProgressTimers};`);
const runtime=path.join(root,'.async_progress_runtime.cjs');fs.writeFileSync(runtime,source);
const original={setTimeout:global.setTimeout,clearTimeout:global.clearTimeout,setInterval:global.setInterval,clearInterval:global.clearInterval};
// Keep timer ordering but compress long UI waits for a deterministic async smoke run.
global.setTimeout=(fn,ms=0,...args)=>{const h=original.setTimeout(fn,Math.max(1,Math.min(45,Math.floor(Number(ms||0)*0.012))),...args);h.unref=()=>h;return h;};
global.setInterval=(fn,ms=0,...args)=>{const h=original.setInterval(fn,Math.max(3,Math.min(25,Math.floor(Number(ms||0)*0.012))),...args);h.unref=()=>h;return h;};
const api=require(runtime);fs.unlinkSync(runtime);
function ws(){return{readyState:1,send(){}};}
function sleep(ms){return new Promise(r=>original.setTimeout(r,ms));}
(async()=>{
 const sock=ws();api.createRoom(sock,'AsyncHuman',1,true,-20,false,false,'mud6',2,'perRound',true,'reshuffle');const room=[...api.rooms.values()].at(-1);for(let i=0;i<3;i++)api.addCpu(room,room.hostId);assert.strictEqual(api.startGame(room,room.hostId),true);
 let loops=0,humanActions=0,spotlights=0;
 while(room.phase!=='finished'&&loops++<5000){
   api.ensureRoomProgress(room);
   const pp=room.pendingPick;
   if(pp){
     if(pp.targetSelectionRequired&&!pp.targetSelectionDone&&pp.pickProviderPid===0){const p=room.players[0];api.submitPickTargets(room,p.id,p.hand.slice(0,pp.targetCount).map(c=>c.id),true);humanActions++;}
     else if(pp.pairChoice&&!pp.result&&pp.pickerPid===0){api.resolvePairChoice(room,room.players[0].id,pp.pairChoice.candidates[0]?.id,false);humanActions++;}
     else if(!pp.result&&pp.pickerPid===0){pp.readyAt=0;api.doPick(room,room.players[0].id,0);humanActions++;}
   }else if(room.phase==='playing'&&room.current===0&&!room.trickReview){const ids=[...api.playableIds(room,0)];if(ids.length){api.playCard(room,room.players[0].id,ids[0]);humanActions++;}}
   if(room.spotlightEvent)spotlights++;
   await sleep(2);
 }
 assert.ok(loops<5000,'async timer progression did not finish');assert.strictEqual(room.phase,'finished');assert.ok(room.players.every(p=>p.final&&Number.isFinite(p.final.total)));assert.strictEqual(room.spotlightEvent,null);assert.ok(humanActions>0);api.clearAllProgressTimers(room);
 Object.assign(global,original);
 console.log(JSON.stringify({result:'passed',loops,humanActions,spotlightSamples:spotlights,totals:room.players.map(p=>p.final.total)}));process.exit(0);
})().catch(error=>{Object.assign(global,original);console.error(error);process.exit(1);});
