'use strict';

const assert=require('assert');
const crypto=require('crypto');
const fs=require('fs');
const path=require('path');
const vm=require('vm');
const root=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'server.js'),'utf8');
class FakeWebSocketServer{on(){}}
const server={listen(){}};
const sandbox={console,process:{env:{}},__dirname:root,setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,clearInterval(){},require(name){
  if(name==='http')return{createServer:()=>server};
  if(name==='ws')return{Server:FakeWebSocketServer,OPEN:1};
  if(name==='crypto')return crypto;
  if(name==='fs')return fs;
  if(name==='path')return path;
  if(name==='./cpu_personality_dialogue')return require(path.join(root,'cpu_personality_dialogue.js'));
  if(name==='./spotlight_priority')return require(path.join(root,'spotlight_priority.js'));
  throw new Error(`Unexpected require: ${name}`);
}};
sandbox.globalThis=sandbox;
vm.runInNewContext(`${source}\nglobalThis.testApi={createRoom,addCpu,startGame,rooms,roomHandSize,roomSeatCapacity,secondaryPickRanks,buildPostTrickFlow,normalizePickTargetCount,cpuCardPlayScore};`,sandbox,{filename:'server.js'});
const api=sandbox.testApi;
for(const seats of [3,4,5]){
  const ws={readyState:1,send(){},on(){}};
  api.createRoom(ws,`Seats${seats}`,1,true,-20,false,false,'mud6',2,'perRound',false,'reshuffle','unlimited',1,'winner','player',true,false,true,false,seats);
  const room=api.rooms.get(ws.roomCode);
  assert.strictEqual(api.roomSeatCapacity(room),seats);
  assert.strictEqual(api.roomHandSize(room),Math.floor(52/seats));
  for(let i=1;i<seats;i++)api.addCpu(room,ws.playerId,i===1?'nakato_modoki':'auto');
  assert(room.players.some(p=>p.cpuCharacter?.key==='nakato_modoki' && p.name==='なかとーもどき'));
  const nakatoPid=room.players.findIndex(p=>p.cpuCharacter?.key==='nakato_modoki');
  assert.strictEqual(api.startGame(room,ws.playerId),true);
  assert(Number.isFinite(api.cpuCardPlayScore(room,nakatoPid,room.players[nakatoPid].hand[0])),'nakato-modoki strategy returns a finite playable score');
  assert.deepStrictEqual(Array.from(room.players,p=>p.hand.length),Array(seats).fill(Math.floor(52/seats)));
  assert.strictEqual(room.removedCards.length,53-Math.floor(52/seats)*seats);
  const ranks=Array.from({length:seats},(_,i)=>i);
  room.trickRankings=ranks;
  const flow=api.buildPostTrickFlow(room,0,seats-1);
  if(seats===3)assert.strictEqual(flow.steps.length,1);
  else{
    assert.strictEqual(flow.steps.length,2);
    assert.strictEqual(flow.steps[1].pickProviderPid,1);
    assert.strictEqual(flow.steps[1].pickerPid,seats===5?3:2);
  }
}
assert.strictEqual(api.normalizePickTargetCount(17),17);
console.log('3/4/5 player rules and deal regression: all assertions passed');
