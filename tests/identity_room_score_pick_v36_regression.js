'use strict';

const assert=require('assert');
const crypto=require('crypto');
const fs=require('fs');
const path=require('path');
const vm=require('vm');
const root=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'server.js'),'utf8');

class FakeWSS{on(){}}
const cleared=new Set();
let timerSeq=0;
const sandbox={
  console,Buffer,process:{env:{}},__dirname:root,
  setTimeout(){return {kind:'timeout',id:++timerSeq,unref(){}};},
  clearTimeout(handle){if(handle)cleared.add(handle);},
  setInterval(){return {kind:'interval',id:++timerSeq,unref(){}};},
  clearInterval(handle){if(handle)cleared.add(handle);},
  require(name){
    if(name==='http')return{createServer:()=>({listen(){}})};
    if(name==='ws')return{Server:FakeWSS,OPEN:1};
    if(name==='crypto')return crypto;
    if(name==='fs')return fs;
    if(name==='path')return path;
    if(name==='./cpu_personality_dialogue')return require(path.join(root,'cpu_personality_dialogue.js'));
    if(name==='./spotlight_priority')return require(path.join(root,'spotlight_priority.js'));
    throw new Error(`unexpected require ${name}`);
  }
};
sandbox.globalThis=sandbox;
vm.runInNewContext(`${source}\n;globalThis.__v36Api={
  HUMAN_ANIMAL_IDENTITIES,rooms,createRoom,joinRoom,reconnectRoom,addCpu,removeCpu,clearRoom,rematchGame,publicState,
  normalizeFeastPointPerCard,normalizePickProviderRole,feastPileScore,makeRoundSnapshot,score,pickCandidateLimit,
  submitPickTargets,doPick,resolvePairChoice,finishAfterPick,clearAllProgressTimers
};`,sandbox,{filename:'server.js'});
const api=sandbox.__v36Api;

function ws(){
  return {readyState:1,sent:[],roomCode:null,playerId:null,send(raw){this.sent.push(JSON.parse(raw));},close(code){this.readyState=3;this.closeCode=code;}};
}
function latest(socket,type){return [...socket.sent].reverse().find(x=>x.type===type);}
function card(suit,rank,id){return{id,faceKey:`${suit}:${rank}`,suit,rank:String(rank),val:Number(rank),joker:false};}

// Four blank human names and all human avatars are unique and server-owned.
const sockets=[ws(),ws(),ws(),ws()];
api.createRoom(sockets[0],'');
const room=[...api.rooms.values()].at(-1);
for(let i=1;i<4;i++)api.joinRoom(sockets[i],room.code,'');
assert.strictEqual(room.players.length,4);
assert.strictEqual(new Set(room.players.map(p=>p.name)).size,4);
assert.strictEqual(new Set(room.players.map(p=>p.avatar)).size,4);
assert(room.players.every(p=>api.HUMAN_ANIMAL_IDENTITIES.some(x=>x.name===p.name&&x.avatar===p.avatar)));
for(const viewer of room.players){
  const state=api.publicState(room,viewer.id);
  assert.deepStrictEqual([...state.players.map(p=>`${p.name}:${p.avatar}`)],[...room.players.map(p=>`${p.name}:${p.avatar}`)]);
}

// Explicit names are preserved and an occupied animal name is skipped by auto naming.
const explicitWs=ws(),blankWs=ws();
api.createRoom(explicitWs,'子ブタ');
const explicitRoom=[...api.rooms.values()].at(-1);
api.joinRoom(blankWs,explicitRoom.code,'');
assert.strictEqual(explicitRoom.players[0].name,'子ブタ');
assert.notStrictEqual(explicitRoom.players[1].name,'子ブタ');
assert.notStrictEqual(explicitRoom.players[0].avatar,explicitRoom.players[1].avatar);

// Reconnect, CPU add/remove, and rematch preserve the assigned identity.
const before=room.players.map(p=>({id:p.id,name:p.name,avatar:p.avatar,resumeToken:p.resumeToken}));
const replacement=ws();
api.reconnectRoom(replacement,room.code,before[0].id,before[0].name,before[0].resumeToken);
assert.strictEqual(room.players[0].name,before[0].name);
assert.strictEqual(room.players[0].avatar,before[0].avatar);
assert.strictEqual(latest(replacement,'reconnected').avatar,before[0].avatar);
const cpuRoomWs=ws();api.createRoom(cpuRoomWs,'固定名');
const cpuRoom=[...api.rooms.values()].at(-1);const identityBefore={name:cpuRoom.players[0].name,avatar:cpuRoom.players[0].avatar};
api.addCpu(cpuRoom,cpuRoom.hostId);api.removeCpu(cpuRoom,cpuRoom.hostId);
assert.deepStrictEqual({name:cpuRoom.players[0].name,avatar:cpuRoom.players[0].avatar},identityBefore);
room.phase='finished';
assert.strictEqual(api.rematchGame(room,room.hostId),true);
assert.deepStrictEqual([...room.players.map(p=>`${p.name}:${p.avatar}`)],[...before.map(p=>`${p.name}:${p.avatar}`)]);
api.clearAllProgressTimers(room);

// Room clear is host-only, lobby-only, cancels timers, invalidates tokens, and removes the code.
const clearSockets=[ws(),ws()];api.createRoom(clearSockets[0],'Host');
const clearable=[...api.rooms.values()].at(-1);api.joinRoom(clearSockets[1],clearable.code,'Guest');
assert.strictEqual(api.clearRoom(clearable,clearable.players[1].id),false);
assert.match(latest(clearSockets[1],'errorMsg').message,/ホスト/);
clearable.phase='playing';assert.strictEqual(api.clearRoom(clearable,clearable.hostId),false);
assert.match(latest(clearSockets[0],'errorMsg').message,/ゲーム開始前/);
clearable.phase='lobby';
const activeHost=ws();const activeHostToken=clearable.players[0].resumeToken;
api.reconnectRoom(activeHost,clearable.code,clearable.hostId,clearable.players[0].name,activeHostToken);
assert.strictEqual(api.clearRoom(clearable,clearable.hostId,clearSockets[0]),false,'stale host socket cannot clear the room');
clearable.reviewTimer=sandbox.setTimeout(()=>{},1);clearable.cpuTimer=sandbox.setTimeout(()=>{},1);clearable.pickFinishTimer=sandbox.setTimeout(()=>{},1);
const oldCode=clearable.code,oldHostId=clearable.hostId,oldToken=clearable.players[0].resumeToken;
assert.strictEqual(api.clearRoom(clearable,oldHostId,activeHost),true);
assert.strictEqual(api.rooms.has(oldCode),false);
assert(clearable.players.every(p=>p.resumeToken===null));
assert.strictEqual(latest(activeHost,'roomClosed')?.reason,'hostCleared');
assert.strictEqual(latest(clearSockets[1],'roomClosed')?.reason,'hostCleared');
assert.strictEqual(clearable.reviewTimer,null);assert.strictEqual(clearable.cpuTimer,null);assert.strictEqual(clearable.pickFinishTimer,null);
const stale=ws();api.reconnectRoom(stale,oldCode,oldHostId,'Host',oldToken);
assert.match(latest(stale,'errorMsg').message,/見つかりません/);

// Feast cards and points remain separate at every representative value.
for(const feastPointPerCard of [0,1,2,5]){
  const players=Array.from({length:4},(_,i)=>({id:`S${i}`,name:`S${i}`,avatar:'🐷',cpu:false,ws:ws(),hand:[card('apple',i+1,`h${feastPointPerCard}-${i}`)],scorePile:[],pairs:[],completedRoundCardScoreBank:0,jokerPenaltyBank:0,shootPigPenaltyBank:0,shootPigActivatedRounds:[],out:false}));
  players[0].scorePile=[card('corn',2,`p${feastPointPerCard}-1`),card('cabbage',3,`p${feastPointPerCard}-2`),card('mud',4,`p${feastPointPerCard}-3`)];
  const scoring={players,feastPointPerCard,roundDealMode:'carryOver',penaltyMode:'flat3',madPigEnabled:false,shootThePigEnabled:false,shootThePigLimit:'unlimited',jokerPenalty:20,jokerPenaltyTiming:'perRound',round:1,totalRounds:1,shootPigRoundResults:{},log:[],commentary:[]};
  assert.strictEqual(api.feastPileScore(scoring,players[0]),3*feastPointPerCard);
  const snapshot=api.makeRoundSnapshot(scoring,0,'test');
  assert.strictEqual(snapshot.rows[0].pile,3);
  assert.strictEqual(snapshot.rows[0].pileScore,3*feastPointPerCard);
  api.score(scoring);
  assert.strictEqual(players[0].final.pileCardCount,3);
  assert.strictEqual(players[0].final.pileScore,3*feastPointPerCard);
}

// Mad Pig applies the configured feast point first, then its one non-duplicated penalty.
for(const penaltyMode of ['mud6','faceValue']){
  const p={id:'M0',name:'M0',avatar:'🐷',cpu:false,ws:ws(),hand:[],scorePile:[card('mud',11,`mad-${penaltyMode}`)],pairs:[],completedRoundCardScoreBank:0,jokerPenaltyBank:0,shootPigPenaltyBank:0,shootPigActivatedRounds:[],out:false};
  const others=[1,2,3].map(i=>({id:`M${i}`,name:`M${i}`,avatar:'🐷',cpu:false,ws:ws(),hand:[card('apple',i,`m-${penaltyMode}-${i}`)],scorePile:[],pairs:[],completedRoundCardScoreBank:0,jokerPenaltyBank:0,shootPigPenaltyBank:0,shootPigActivatedRounds:[],out:false}));
  const r={players:[p,...others],feastPointPerCard:2,roundDealMode:'carryOver',penaltyMode,madPigEnabled:true,shootThePigEnabled:false,shootThePigLimit:'unlimited',jokerPenalty:20,jokerPenaltyTiming:'perRound',round:1,totalRounds:1,shootPigRoundResults:{},log:[],commentary:[]};
  const row=api.makeRoundSnapshot(r,0,'mad').rows[0];
  assert.strictEqual(row.pileScore,2);
  assert.strictEqual(row.madPigPenalty,penaltyMode==='faceValue'?40:13);
  assert.strictEqual(row.total,penaltyMode==='faceValue'?-38:-11);
}

// Both pick directions enforce provider/picker authorization and move exactly one card.
for(const pickProviderRole of ['winner','weakest']){
  const sockets4=[ws(),ws(),ws(),ws()];api.createRoom(sockets4[0],`P-${pickProviderRole}`,1,true,-20,false,false,'mud6',2,'perRound',false,'carryOver','unlimited',1,pickProviderRole);
  const r=[...api.rooms.values()].at(-1);for(let i=1;i<4;i++)api.joinRoom(sockets4[i],r.code,`P${i}`);
  r.phase='playing';r.round=1;r.lead=0;r.current=null;r.trick=[];r.stock=[];r.removedCard=null;
  r.players.forEach((p,i)=>{p.hand=[card('apple',7+i,`${pickProviderRole}-base-${i}`),card('corn',10+i,`${pickProviderRole}-spare-${i}`)];p.scorePile=[];p.pairs=[];});
  const providerPid=pickProviderRole==='winner'?0:1,pickerPid=providerPid===0?1:0;
  r.players[providerPid].hand.push(card('cabbage',3,`${pickProviderRole}-candidate`));
  r.pendingPick={winnerPid:0,weakestPid:1,trickWinnerPid:0,trickWeakestPid:1,pickProviderPid:providerPid,pickerPid,readyAt:0,targetCount:2,targetSelectionRequired:true,targetSelectionDone:false,targetCandidateIds:null,token:`token-${pickProviderRole}`};
  const provider=r.players[providerPid],picker=r.players[pickerPid];
  const selected=provider.hand.slice(0,2).map(c=>c.id);
  api.submitPickTargets(r,picker.id,selected,true);
  assert.strictEqual(r.pendingPick.targetSelectionDone,false,'picker cannot choose provider candidates');
  api.submitPickTargets(r,provider.id,selected,true);
  assert.strictEqual(r.pendingPick.targetSelectionDone,true);
  const beforeProvider=provider.hand.length,beforePicker=picker.hand.length;
  api.doPick(r,provider.id,0);
  assert.strictEqual(provider.hand.length,beforeProvider,'provider cannot execute the pick');
  r.pendingPick.readyAt=0;api.doPick(r,picker.id,0);
  assert.strictEqual(provider.hand.length,beforeProvider-1);
  assert.strictEqual(picker.hand.length,beforePicker+1);
  assert.strictEqual(r.pendingPick.result?.pickerPid,pickerPid);
  const activeIds=r.players.flatMap(p=>p.hand).map(c=>c.id);
  assert.strictEqual(activeIds.length,new Set(activeIds).size);
  api.finishAfterPick(r,0);
  assert.strictEqual(r.lead,0);assert.strictEqual(r.current,0,'next lead always remains trick winner');
  api.clearAllProgressTimers(r);
}

// Pair purification belongs only to the receiver.
{
  const sockets4=[ws(),ws(),ws(),ws()];api.createRoom(sockets4[0],'Pair',1,true,-20,false,false,'mud6',1,'perRound',false,'carryOver','unlimited',1,'winner');
  const r=[...api.rooms.values()].at(-1);for(let i=1;i<4;i++)api.joinRoom(sockets4[i],r.code,`Q${i}`);
  r.phase='playing';r.lead=0;r.current=null;r.trick=[];r.stock=[];r.removedCard=null;
  r.players.forEach((p,i)=>{p.hand=[card('apple',8+i,`pair-base-${i}`),card('corn',12+i,`pair-spare-${i}`)];p.scorePile=[];p.pairs=[];});
  r.players[0].hand.push(card('mud',5,'pair-drawn'));
  r.players[1].hand.push(card('cabbage',5,'pair-match'));
  r.pendingPick={winnerPid:0,weakestPid:1,trickWinnerPid:0,trickWeakestPid:1,pickProviderPid:0,pickerPid:1,readyAt:0,targetCount:1,targetSelectionRequired:false,targetSelectionDone:true,targetCandidateIds:['pair-drawn'],token:'pair-token'};
  api.doPick(r,r.players[1].id,0);
  assert(r.pendingPick.pairChoice);
  api.resolvePairChoice(r,r.players[0].id,'pair-match',false);
  assert(r.pendingPick.pairChoice,'provider cannot purify receiver hand');
  api.resolvePairChoice(r,r.players[1].id,'pair-match',false);
  assert.strictEqual(r.players[1].pairs.length,2);
  assert.strictEqual(r.pendingPick.result.pickerPid,1);
  api.clearAllProgressTimers(r);
}

assert.strictEqual(api.normalizePickProviderRole(undefined),'winner');
assert.strictEqual(api.normalizePickProviderRole('weakest'),'weakest');
assert.strictEqual(api.normalizeFeastPointPerCard('bad'),1);
for(const n of [0,1,2,13]){
  const p={hand:Array.from({length:13},(_,i)=>card('apple',i+1,`limit-${n}-${i}`))};
  assert.strictEqual(api.pickCandidateLimit({pickTargetCount:n},p),n===0?13:n);
}

console.log(JSON.stringify({result:'passed',suite:'identity-room-score-pick-v36',identities:room.players.map(p=>({name:p.name,avatar:p.avatar}))},null,2));
