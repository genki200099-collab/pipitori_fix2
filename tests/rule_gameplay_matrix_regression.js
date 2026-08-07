'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert');
const root=path.resolve(__dirname,'..');
let source=fs.readFileSync(path.join(root,'server.js'),'utf8');
source=source.replace("const WebSocket = require('ws');",`const WebSocket={OPEN:1,Server:class DummyServer{constructor(){this.clients=new Set()}on(){}}};`);
source=source.replace(/server\.listen\(PORT,[\s\S]*?\);\s*$/m,`module.exports={rooms,createRoom,addCpu,startGame,playCard,advanceReviewToPick,doPick,submitPickTargets,resolvePairChoice,finishAfterPick,beginNextRound,ensureRoomProgress,playableIds,clearAllProgressTimers,submitPassThree,skipInitialPairs};`);
const runtime=path.join(root,'.rule_gameplay_matrix_runtime.cjs');fs.writeFileSync(runtime,source);
const original={setTimeout:global.setTimeout,clearTimeout:global.clearTimeout,setInterval:global.setInterval,clearInterval:global.clearInterval};
const handle=()=>({unref(){}});global.setTimeout=()=>handle();global.clearTimeout=()=>{};global.setInterval=()=>handle();global.clearInterval=()=>{};
let api;try{api=require(runtime);}finally{fs.unlinkSync(runtime);}
function fakeWs(){return{readyState:1,sent:[],send(raw){this.sent.push(JSON.parse(raw));}};}
function allCards(room){const out=[];for(const p of room.players)out.push(...p.hand,...p.scorePile,...p.pairs);out.push(...(room.stock||[]));if(room.removedCard)out.push(room.removedCard);return out;}
function integrity(room,label){const ids=allCards(room).map(c=>c?.id).filter(Boolean);assert.strictEqual(new Set(ids).size,ids.length,`${label}: duplicate card id`);}
function setup(room){
  let guard=0;
  while(['passing','initialPair'].includes(room.phase)&&guard++<20){
    if(room.phase==='passing'){
      const human=room.players[0];
      const ids=human.hand.filter(c=>!c.joker).slice(0,3).map(c=>c.id);
      api.submitPassThree(room,human.id,ids,true);
    }else if(room.phase==='initialPair'){
      api.skipInitialPairs(room,room.players[0].id);
    }
  }
  assert.strictEqual(room.phase,'playing','setup phase did not complete');
}
function run(config,index){
  const ws=fakeWs();
  api.createRoom(ws,`H${index}`,1,config.mad,-20,config.initialPair,config.pass,config.penalty,config.pick,config.timing,config.shoot,config.deal,config.limit,config.feast,config.providerRole);
  const room=[...api.rooms.values()].at(-1);
  for(let i=0;i<3;i++)api.addCpu(room,room.hostId);
  assert.strictEqual(api.startGame(room,room.hostId),true);
  setup(room);
  let steps=0,picks=0,pairs=0;
  while(room.phase!=='finished'&&steps++<700){
    integrity(room,`run ${index} step ${steps}`);
    if(room.phase==='roundEnd'){api.beginNextRound(room);continue;}
    if(room.trickReview){const r=room.trickReview;api.advanceReviewToPick(room,r.until,r.winnerPid,r.weakestPid);continue;}
    const pp=room.pendingPick;
    if(pp){
      if(pp.targetSelectionRequired&&!pp.targetSelectionDone){const provider=room.players[pp.pickProviderPid];api.submitPickTargets(room,provider.id,provider.hand.slice(0,pp.targetCount).map(c=>c.id),true);continue;}
      if(pp.pairChoice&&!pp.result){pairs++;api.resolvePairChoice(room,room.players[pp.pickerPid].id,pp.pairChoice.candidates[0]?.id,false);continue;}
      if(!pp.result){picks++;pp.readyAt=0;api.doPick(room,room.players[pp.pickerPid].id,(index+steps)%Math.max(1,(pp.targetCandidateIds||[]).length||pp.targetCount||1));continue;}
      api.finishAfterPick(room,pp.winnerPid);continue;
    }
    if(room.current==null){api.ensureRoomProgress(room);continue;}
    const playable=[...api.playableIds(room,room.current)];
    if(!playable.length){api.ensureRoomProgress(room);continue;}
    api.playCard(room,room.players[room.current].id,playable[(index+steps)%playable.length]);
  }
  assert(steps<700,`run ${index} stalled`);
  assert.strictEqual(room.phase,'finished');
  assert(room.players.every(p=>p.final&&Number.isFinite(p.final.total)));
  integrity(room,`run ${index} finished`);
  api.clearAllProgressTimers(room);
  return {steps,picks,pairs,totals:room.players.map(p=>p.final.total)};
}
const configs=[];
let idx=0;
for(const penalty of ['mud6','flat3','faceValue','mudSuit'])
for(const mad of [true,false])
for(const timing of ['perRound','gameEnd'])
for(const shoot of [true,false])
for(const deal of ['reshuffle','carryOver'])
for(const limit of ['unlimited','once'])
for(const pick of [0,2,13]){
  const setupMode=idx++%4;
  configs.push({penalty,mad,timing,shoot,deal,limit,pick,feast:[0,1,2,5][idx%4],providerRole:idx%2?'winner':'weakest',pass:setupMode===1||setupMode===3,initialPair:setupMode===2||setupMode===3});
}
const samples=[];
configs.forEach((config,index)=>{const r=run(config,index);if(index%48===0)samples.push({config,...r});});
Object.assign(global,original);
console.log(JSON.stringify({result:'passed',runs:configs.length,samples},null,2));
