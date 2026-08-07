'use strict';
const assert=require('assert');const fs=require('fs');const path=require('path');
const root=path.resolve(__dirname,'..');let source=fs.readFileSync(path.join(root,'server.js'),'utf8');
source=source.replace("const WebSocket = require('ws');",`const WebSocket={OPEN:1,Server:class DummyServer{constructor(){this.clients=new Set()}on(){}}};`);
source=source.replace(/server\.listen\(PORT,[\s\S]*?\);\s*$/m,`module.exports={rooms,createRoom,addCpu,startGame,rematchGame,clearAllProgressTimers};`);
const runtime=path.join(root,'.match_lifecycle_runtime.cjs');fs.writeFileSync(runtime,source);
const original={setTimeout:global.setTimeout,clearTimeout:global.clearTimeout,setInterval:global.setInterval,clearInterval:global.clearInterval};
const fakeHandle=()=>({unref(){}});global.setTimeout=()=>fakeHandle();global.clearTimeout=()=>{};global.setInterval=()=>fakeHandle();global.clearInterval=()=>{};
let api;try{api=require(runtime);}finally{Object.assign(global,original);fs.unlinkSync(runtime);}
function fakeWs(){return {readyState:1,sent:[],send(raw){this.sent.push(JSON.parse(raw));}};}
const socket=fakeWs();api.createRoom(socket,'ホスト',3,true,-20,false,false,'mud6',2,'perRound',true,'reshuffle','unlimited',5,'weakest');
const room=[...api.rooms.values()][0];for(let i=0;i<3;i++)api.addCpu(room,room.hostId);
assert.strictEqual(room.feastPointPerCard,5);assert.strictEqual(room.pickProviderRole,'weakest');
assert.strictEqual(api.startGame(room,room.hostId),true);const firstDeal=room.players.map(p=>p.hand.map(c=>c.id));const firstRemoved=room.removedCard?.id;const firstLead=room.lead;
assert.strictEqual(api.startGame(room,room.hostId),false,'duplicate start rejected');assert.deepStrictEqual(room.players.map(p=>p.hand.map(c=>c.id)),firstDeal);assert.strictEqual(room.removedCard?.id,firstRemoved);assert.strictEqual(room.lead,firstLead);assert.strictEqual(api.rematchGame(room,room.hostId),false);
room.phase='finished';room.current=null;room.finalRoundSummary={round:3};room.spotlightEvent={id:'stale'};room.pendingSpotlightPlans=[{text:'stale'}];
for(const p of room.players){p.final={total:99};p.completedRoundCardScoreBank=40;p.jokerPenaltyBank=20;p.shootPigPenaltyBank=10;p.out=true;}
assert.strictEqual(api.rematchGame(room,room.hostId),true);assert.notStrictEqual(room.phase,'finished');assert.strictEqual(room.round,1);assert.strictEqual(room.feastPointPerCard,5);assert.strictEqual(room.pickProviderRole,'weakest');assert.strictEqual(room.finalRoundSummary,null);assert.strictEqual(room.spotlightEvent,null);assert.strictEqual(room.pendingSpotlightPlans,null);assert.ok(room.players.every(p=>p.hand.length===13));assert.ok(room.players.every(p=>p.final===null&&!p.out));assert.ok(room.players.every(p=>p.completedRoundCardScoreBank===0&&p.jokerPenaltyBank===0&&p.shootPigPenaltyBank===0));
const ids=room.players.flatMap(p=>p.hand.map(c=>c.id)).concat(room.removedCard?.id||[]);assert.strictEqual(ids.length,53);assert.strictEqual(new Set(ids).size,53);api.clearAllProgressTimers(room);console.log('match lifecycle regression: all assertions passed');
