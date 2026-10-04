'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path');
const api=require('./server_test_harness.cjs')(46);
let runs=0,tricks=0,shootChoices=0,roundTransitions=0;
function fakeWs(){return{readyState:1,send(){}};}
function ownedCards(room){const owned=room.players.flatMap(p=>[...p.hand,...p.scorePile,...p.pairs]);const scored=new Set(room.players.flatMap(p=>p.scorePile).map(c=>c.id));return owned.concat(room.trick.map(t=>t.card).filter(c=>!scored.has(c.id)),room.stock,room.removedCards||[]);}
function check(room,context,expected){
 const cards=ownedCards(room);assert(cards.every(Boolean),context+': missing card');
 assert.equal(new Set(cards.map(c=>c.id)).size,cards.length,context+': duplicate ownership');
 if(room.roundDealMode==='reshuffle')assert.equal(cards.length,53,context+': card conservation');
 const active=room.players.flatMap(p=>p.hand).concat(room.trick.map(t=>t.card),room.stock);
 assert.equal(new Set(active.map(c=>c.joker?'JOKER':c.suit+':'+c.rank)).size,active.length,context+': duplicate active face');
 assert.equal(active.filter(c=>c.joker).length,1,context+': Joker preserved');
 if(expected)assert.deepEqual(room.players.map(p=>p.hand.length),Array(room.seatCapacity).fill(expected),context+': refill count');
}
function run(c,index){
 const ws=fakeWs();api.createRoom(ws,'QA',c.rounds||3,c.mad,-20,c.initial,c.pass,c.penalty,c.pick,c.timing,c.shoot,c.deal,c.limit,c.feast,c.provider,'player',c.force,c.move,c.middle,c.load,c.seats);
 const room=api.rooms.get(ws.roomCode);assert.equal(room.enableMiddleRankPick,c.seats!==3&&c.middle,'effective middle-pick setting');for(let i=1;i<c.seats;i++)api.addCpu(room,room.hostId);
 api.startGame(room,room.hostId);let steps=0;
 while(room.phase!=='finished'&&steps++<2500){
 const context=`run ${index} ${JSON.stringify(c)} round ${room.round} step ${steps}`;check(room,context);
 if(room.phase==='passing'){api.submitPassThree(room,room.players[0].id,room.players[0].hand.filter(c=>!c.joker).slice(0,3).map(c=>c.id),true);continue;}
 if(room.phase==='initialPair'){api.skipInitialPairs(room,room.players[0].id);continue;}
 if(room.phase==='roundEnd'){
  const summary=room.roundEndSummary;
  for(const row of summary.rows)assert(Number.isFinite(row.total),context+': score finite');
  api.beginNextRound(room);roundTransitions++;check(room,context,Math.floor(52/c.seats));continue;
 }
 if(room.trickReview){
  tricks++;assert.equal(room.lastTrick.feastCardCount,c.seats);assert.equal(room.lastTrick.feastScore,c.seats*c.feast);
  assert.equal(new Set(room.trickRankings).size,c.seats);
  const r=room.trickReview;api.advanceReviewToPick(room,r.until,r.winnerPid,r.weakestPid);continue;
 }
 if(room.pendingShootDecision){shootChoices++;api.resolveShootDecision(room,room.players[room.pendingShootDecision.shooterPid].id,index%2===0);continue;}
 if(room.pendingShootTransition){api.finishShootPresentation(room,room.pendingShootTransition.id);continue;}
 const pp=api.activePickLanes(room)[0];
 if(pp){
  const provider=room.players[pp.pickProviderPid],picker=room.players[pp.pickerPid];
  if(pp.targetSelectionRequired&&!pp.targetSelectionDone){const mandatory=pp.mandatoryCandidateIds||[];const ids=[...mandatory,...provider.hand.map(c=>c.id).filter(id=>!mandatory.includes(id))].slice(0,pp.targetCount);api.submitPickTargets(room,provider.id,ids,true,pp.pickId);continue;}
  if(pp.pairChoice&&!pp.result){api.resolvePairChoice(room,picker.id,pp.pairChoice.candidates[0]?.id,index%3===0,pp.pickId);continue;}
  if(!pp.result){pp.readyAt=0;api.doPick(room,picker.id,0,pp.pickId);continue;}
  api.finishPickLane(room,pp,pp.winnerPid);continue;
 }
 if(room.current==null){api.ensureRoomProgress(room);continue;}
 const playable=[...api.playableIds(room,room.current)];
 if(!playable.length){api.ensureRoomProgress(room);continue;}
 api.playCard(room,room.players[room.current].id,playable[(index+steps)%playable.length]);
 }
 assert(steps<2500,`stalled ${index}: ${JSON.stringify(c)}`);assert.equal(room.phase,'finished');check(room,'finished '+index);
 assert.equal(room.round,c.rounds||3);
 for(const p of room.players){assert(Number.isFinite(p.final.total));assert.equal(p.matchStats.roundScores.length,c.rounds||3);assert.equal(p.final.total,p.matchStats.roundScores.at(-1).score,`final snapshot mismatch ${index}: ${JSON.stringify(c)}`);}
 api.clearAllProgressTimers(room);api.rooms.delete(room.code);runs++;
}
let index=0;
const mode=process.env.V46_MATRIX_MODE||'full';
for(const seats of [3,4,5])
for(const penalty of ['mud6','flat3','faceValue','mudSuit'])
for(const deal of ['reshuffle','carryOver'])
for(const shootMode of ['off','roundEnd','loadFire'])
for(const middle of [false,true])
for(const provider of ['winner','weakest'])
for(const pick of [0,1,2,17]){
 const i=index++;
 const c={seats,penalty,deal,middle,provider,pick,rounds:3,mad:i%7!==0,shoot:shootMode!=='off',load:shootMode==='loadFire',timing:i%2?'gameEnd':'perRound',limit:i%3?'unlimited':'once',feast:[0,1,2,5][Math.floor(i/3)%4],force:i%2===0,move:Math.floor(i/2)%2===0,pass:i%4===1||i%4===3,initial:i%4>=2};
 if(mode==='smoke'&&i%32!==0)continue;
 run(c,i);if(runs%96===0)console.log(JSON.stringify({progress:runs,tricks,roundTransitions,shootChoices}));
}
const result={result:'passed',seed:46,mode,runs,tricks,roundTransitions,shootChoices,roundsPerMatch:3,seats:[3,4,5],ownership:'card IDs including trick and all excluded cards',activeFaceUniqueness:true};
fs.mkdirSync(path.join(__dirname,'../qa/v46'),{recursive:true});fs.writeFileSync(path.join(__dirname,'../qa/v46/lifecycle-matrix.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
