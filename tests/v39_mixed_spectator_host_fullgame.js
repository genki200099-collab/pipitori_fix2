'use strict';

const assert=require('assert');
const path=require('path');
const {spawn}=require('child_process');
const WebSocket=require('ws');
const root=path.resolve(__dirname,'..');
const port=45000+(process.pid%8000);
const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','pipe']});
let code='',finished=false,cpuAdded=false,started=false,sawSecondary=false,spectatorFullHands=false,playerPrivacy=false;
let lastSummary='no state';
const humanSummaries={};
const clients=[],errors=[];child.stderr.on('data',chunk=>errors.push(String(chunk)));
const deadline=setTimeout(()=>done(new Error(`v39 mixed spectator-host full-game timeout; ${lastSummary}; humans=${JSON.stringify(humanSummaries)}`)),300000);
function send(socket,payload){if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(payload));}
function cleanup(){clearTimeout(deadline);for(const item of clients){try{item.socket.close();}catch{}}try{child.kill('SIGKILL');}catch{}}
function done(error,result){if(finished)return;finished=true;cleanup();if(error){console.error(error.stack||error);if(errors.length)console.error(errors.join(''));process.exit(1);}console.log(JSON.stringify(result));process.exit(0);}
function humanAction(client,state){
  humanSummaries[client.index]=`you=${state.yourIndex} phase=${state.phase} current=${state.current} trick=${state.trick?.length} pick=${state.pendingPick?.pickStage || '-'} provider=${state.pendingPick?.pickProviderPid} picker=${state.pendingPick?.pickerPid} result=${!!state.pendingPick?.result} targets=${state.pendingPick?.targetSelectionDone} count=${state.pendingPick?.targetCandidateCount} mandatory=${state.pendingPick?.mandatoryCandidateIds?.length} selectable=${state.pendingPick?.targetSelectableCardIds?.length} pair=${!!state.pendingPick?.pairChoice} shoot=${!!state.pendingShootDecision}`;
  lastSummary=`human${client.index} ${humanSummaries[client.index]}`;
  assert.strictEqual(state.participantRole,'player');assert.strictEqual(state.enableMiddleRankPick,true);assert.strictEqual(state.shootLoadFireMode,true);
  if(state.phase!=='lobby')playerPrivacy=playerPrivacy||state.players.every((player,index)=>index===state.yourIndex?Array.isArray(player.hand):player.hand===null);
  if(state.phase!=='playing')return;
  const choice=state.pendingShootDecision;
  if(choice?.canChoose){const key=`shoot:${choice.id}`;if(client.last!==key){client.last=key;send(client.socket,{type:'shootDecision',fire:true});}return;}
  const pick=state.pendingPick;if(pick?.pickStage==='secondary')sawSecondary=true;
  if(pick?.targetSelectionRequired&&!pick.targetSelectionDone&&pick.pickProviderPid===state.yourIndex){
    const selectable=pick.targetSelectableCardIds||[],mandatory=pick.mandatoryCandidateIds||[];
    const ordered=[...mandatory,...selectable.filter(id=>!mandatory.includes(id))];
    const count=Math.min(pick.targetCandidateCount||0,selectable.length);const ids=ordered.slice(0,count);const key=`targets:${pick.readyAt}:${ids.join(',')}`;
    if(ids.length&&client.last!==key){client.last=key;send(client.socket,{type:'pickTargets',cardIds:ids});}return;
  }
  if(pick?.pairChoice&&pick.pickerPid===state.yourIndex){const key=`pair:${pick.pairChoice.drawn?.id}`;if(client.last!==key){client.last=key;send(client.socket,{type:'pairChoice',skip:true});}return;}
  if(pick&&!pick.result&&pick.pickerPid===state.yourIndex&&pick.ready){const key=`pick:${pick.readyAt}`;if(client.last!==key){client.last=key;send(client.socket,{type:'pick',index:0});}return;}
  if(state.isYourTurn&&state.playableCardIds?.length){const cardId=state.playableCardIds[0];const key=`play:${state.round}:${state.trick?.length}:${cardId}:${state.players[state.yourIndex]?.handCount}`;if(client.last!==key){client.last=key;send(client.socket,{type:'play',cardId});}}
}
function connectHuman(index){
  const socket=new WebSocket(`ws://127.0.0.1:${port}`),client={socket,role:'player',index,last:''};clients.push(client);
  socket.on('open',()=>send(socket,{type:'join',code,name:`MixedHuman${index}`,participantRole:'player'}));
  socket.on('message',raw=>{try{const message=JSON.parse(String(raw));if(message.type==='errorMsg')throw new Error(message.message);if(message.type==='state')humanAction(client,message.state);}catch(error){done(error);}});socket.on('error',done);
}
function hostAction(client,state){
  lastSummary=`host phase=${state.phase} players=${state.players.length} current=${state.current} trick=${state.trick?.length} pick=${state.pendingPick?.pickStage || '-'} result=${!!state.pendingPick?.result} targets=${state.pendingPick?.targetSelectionDone} pair=${!!state.pendingPick?.pairChoice} shoot=${!!state.pendingShootDecision}`;
  assert.strictEqual(state.participantRole,'spectator');assert.strictEqual(state.hostId,state.you);
  assert.strictEqual(state.enableMiddleRankPick,true);assert.strictEqual(state.shootLoadFireMode,true);assert.strictEqual(state.forceJokerPickCandidate,true);
  if(state.phase==='lobby'){
    if(state.players.length===3&&!cpuAdded){cpuAdded=true;send(client.socket,{type:'addCpu'});return;}
    if(state.players.length===4&&!started){started=true;send(client.socket,{type:'start'});}return;
  }
  spectatorFullHands=spectatorFullHands||state.players.every(player=>Array.isArray(player.hand));
  if(state.pendingPick?.pickStage==='secondary')sawSecondary=true;
  if(state.phase==='finished'){
    assert.strictEqual(state.players.filter(player=>player.cpu).length,1);assert.strictEqual(state.players.filter(player=>!player.cpu).length,3);
    assert.strictEqual(state.spectatorCount,1);assert(spectatorFullHands);assert(playerPrivacy);assert(sawSecondary);
    assert(state.players.every(player=>player.final&&Number.isFinite(player.final.total)));
    done(null,{result:'passed',suite:'v39-mixed-spectator-host-fullgame',humans:3,cpus:1,spectators:1,hostRole:'spectator',totals:state.players.map(player=>player.final.total)});
  }
}
function connectHost(){
  const socket=new WebSocket(`ws://127.0.0.1:${port}`),client={socket,role:'spectator',last:''};clients.push(client);
  socket.on('open',()=>send(socket,{type:'create',name:'MixedSpectatorHost',participantRole:'spectator',rounds:1,enableMiddleRankPick:true,shootLoadFireMode:true,forceJokerPickCandidate:true,pickTargetCount:2}));
  socket.on('message',raw=>{try{const message=JSON.parse(String(raw));if(message.type==='errorMsg')throw new Error(message.message);if(message.type==='created'){code=message.code;for(let index=0;index<3;index++)connectHuman(index);}if(message.type==='state')hostAction(client,message.state);}catch(error){done(error);}});socket.on('error',done);
}
child.stdout.on('data',chunk=>{if(String(chunk).includes('server listening')&&!clients.length)connectHost();});
