'use strict';

const assert=require('assert');
const crypto=require('crypto');
const fs=require('fs');
const path=require('path');
const vm=require('vm');
const root=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'server.js'),'utf8');
const html=fs.readFileSync(path.join(root,'public','index.html'),'utf8');
class FakeWSS{on(){}}
const scheduled=[];
const sandbox={console,Buffer,Math,process:{env:{}},__dirname:root,setTimeout(fn,delay){const timer={fn,delay:Number(delay),cleared:false,unref(){}};scheduled.push(timer);return timer;},clearTimeout(timer){if(timer)timer.cleared=true;},setInterval(){return{unref(){}};},clearInterval(){},require(name){if(name==='http')return{createServer:()=>({listen(){}})};if(name==='ws')return{Server:FakeWSS,OPEN:1};if(name==='crypto')return crypto;if(name==='fs')return fs;if(name==='path')return path;if(name==='./cpu_personality_dialogue')return require(path.join(root,'cpu_personality_dialogue.js'));if(name==='./spotlight_priority')return require(path.join(root,'spotlight_priority.js'));throw Error(name);}};
sandbox.globalThis=sandbox;
vm.runInNewContext(`${source}\n;globalThis.__api={rooms,createRoom,addCpu,initializeMatch,checkRoundEnd,publicState,cpuOnlyRoom,roundEndContinueDelay,ensureRoomProgress};`,sandbox,{filename:'server.js'});
const api=sandbox.__api;
const ws={readyState:1,sent:[],send(raw){this.sent.push(JSON.parse(raw));}};

api.createRoom(ws,'Watcher',2,true,-20,false,false,'mud6',2,'perRound',true,'reshuffle','unlimited',1,'winner','spectator',false,false,true,false);
const r=[...api.rooms.values()][0];
for(let i=0;i<4;i++) api.addCpu(r,r.hostId);
assert.strictEqual(api.cpuOnlyRoom(r),true);assert.strictEqual(r.spectators.length,1);
api.initializeMatch(r);
r.players[0].hand=[];
const before=scheduled.length;
assert.strictEqual(api.checkRoundEnd(r,0),true);
assert.strictEqual(r.phase,'roundEnd');
assert.strictEqual(api.roundEndContinueDelay(r),2600);
const autoTimer=scheduled.slice(before).find(timer=>timer.delay===2600&&!timer.cleared);
assert(autoTimer,'server schedules the CPU-only next round without spectator acknowledgement');
const state=api.publicState(r,r.spectators[0].id);
assert.strictEqual(state.cpuOnlyAutoAdvance,true);
assert(state.roundEndAutoContinueInMs<=2600&&state.roundEndAutoContinueInMs>=0);
assert.strictEqual(state.isSpectator,true);
assert.match(r.message,/自動/);

// The watchdog observes the same short deadline; a spectator visibility/input state is never consulted.
r.roundEndSummary.createdAt=Date.now()-3000;
api.ensureRoomProgress(r);
assert.strictEqual(r.phase,'playing','watchdog starts the next round after the CPU-only deadline');

const humanRoom={players:[{cpu:false}],phase:'roundEnd'};
assert.strictEqual(api.roundEndContinueDelay(humanRoom),45000,'human-player flow retains the v39 confirmation window');
assert.match(source,/cpuOnlyRoom\(room\) \? CPU_ONLY_ROUND_END_AUTO_CONTINUE_MS/);
assert.match(html,/CPUのみの卓です。観戦者の入力を待たず、約3秒で自動進行します。/);
console.log(JSON.stringify({result:'passed',suite:'cpu-only-round-advance-v40',spectatorBlocks:false,autoAdvanceMs:2600,humanFallbackMs:45000}));
