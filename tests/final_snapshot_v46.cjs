'use strict';
const assert=require('assert'),api=require('./server_test_harness.cjs')(4602);
for(const seats of [3,4,5])for(const timing of ['perRound','gameEnd']){
 const ws={readyState:1,send(){}};api.createRoom(ws,'QA',1,false,-20,false,false,'mud6',2,timing,false,'reshuffle','unlimited',1,'winner','player',true,false,true,false,seats);
 const room=api.rooms.get(ws.roomCode);for(let i=1;i<seats;i++)api.addCpu(room,room.hostId);api.startGame(room,room.hostId);
 const cards=room.players.flatMap(p=>p.hand);room.players.forEach(p=>p.hand=[]);
 room.players[1].hand=cards.filter(c=>c.joker);room.players[2].hand=cards.filter(c=>!c.joker);
 api.checkRoundEnd(room,0);assert.equal(room.phase,'finished');assert.equal(room.players[1].final.total,-20);
 const row=room.finalRoundSummary.rows[1];assert.equal(row.total,-20,'final snapshot includes final Joker loss');assert.equal(row.jokerPenalty,20);assert.equal(row.pendingFinalJokerPenalty,0);
 assert.equal(room.players[1].matchStats.roundScores.at(-1).score,-20);
 const repeated=api.makeRoundSnapshot(room,0,'repeat');assert.equal(repeated.rows[1].total,-20,'recalculating cannot double charge');
 api.clearAllProgressTimers(room);api.rooms.delete(room.code);
}
console.log(JSON.stringify({result:'passed',seats:[3,4,5],timings:['perRound','gameEnd'],expectedJokerHolderScore:-20,finalSnapshotMatches:true,idempotent:true}));
