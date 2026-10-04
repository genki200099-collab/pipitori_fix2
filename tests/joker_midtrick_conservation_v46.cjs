'use strict';
const assert=require('assert'),api=require('./server_test_harness.cjs')(4601);
for(const seats of [3,4,5]){
 const ws={readyState:1,send(){}};api.createRoom(ws,'QA',1,true,-20,false,false,'mud6',2,'perRound',false,'reshuffle','unlimited',1,'winner','player',true,false,true,false,seats);
 const room=api.rooms.get(ws.roomCode);for(let i=1;i<seats;i++)api.addCpu(room,room.hostId);api.startGame(room,room.hostId);
 const held=[];for(const p of room.players){held.push(...p.hand.filter(c=>c.joker));p.hand=p.hand.filter(c=>!c.joker);}
 room.players[2].hand.push(...room.players[1].hand);room.players[1].hand=held;
 room.current=0;room.lead=0;room.leadSuit=null;
 const card=room.players[0].hand[0];api.playCard(room,room.players[0].id,card.id);assert.equal(room.trick.length,1);
 api.ensureRoomProgress(room);
 assert.equal(room.phase,'finished');assert(room.players[0].hand.some(c=>c.id===card.id),'partial trick must return to its owner before Joker-only finish');
 const cards=room.players.flatMap(p=>[...p.hand,...p.scorePile,...p.pairs]).concat(room.stock,room.removedCards);
 assert.equal(cards.length,53);assert.equal(new Set(cards.map(c=>c.id)).size,53);assert.equal(room.players[0].scorePile.length,0);
 api.clearAllProgressTimers(room);api.rooms.delete(room.code);
}
console.log(JSON.stringify({result:'passed',seats:[3,4,5],jokerOnlyMidTrick:'returned before scoring',cardConservation:53}));
