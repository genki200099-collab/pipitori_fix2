'use strict';
const assert=require('assert');
const path=require('path');
const {spawn}=require('child_process');
const WebSocket=require('ws');
const root=path.resolve(__dirname,'..');
const port=39000+(process.pid%16000);
const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','pipe']});
let host=null,spectator=null,code='',started=false,finished=false,lastAction='',spectatorFullHands=false,playerPrivacy=false,sawFinishedState=false,rematchRequested=false;
const errors=[];child.stderr.on('data',d=>errors.push(String(d)));
const deadline=setTimeout(()=>done(new Error('spectator CPU full-game timeout')),180000);
function send(ws,payload){if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify(payload));}
function cleanup(){clearTimeout(deadline);for(const ws of [host,spectator])try{ws?.close();}catch{}try{child.kill('SIGKILL');}catch{}}
function done(error,result){if(finished)return;finished=true;cleanup();if(error){console.error(error.stack||error);if(errors.length)console.error(errors.join(''));process.exit(1);}console.log(JSON.stringify(result));process.exit(0);}
function hostAction(state){
  if(state.phase==='lobby'){
    if(state.players.length<4){const key=`cpu:${state.players.length}`;if(lastAction!==key){lastAction=key;send(host,{type:'addCpu'});}return;}
    if(!started){started=true;send(host,{type:'start'});}return;
  }
  if(state.phase==='finished'){
    if(!rematchRequested){rematchRequested=true;setTimeout(()=>send(host,{type:'rematch'}),60);}
    return;
  }
  if(state.phase==='roundEnd'){send(host,{type:'continueRound'});return;}
  if(state.phase!=='playing')return;
  const pp=state.pendingPick;
  if(pp?.targetSelectionRequired&&!pp.targetSelectionDone&&pp.pickProviderPid===state.yourIndex){const ids=(pp.targetSelectableCardIds||[]).slice(0,pp.targetCandidateCount||pp.targetCount||0);const key=`targets:${pp.token||pp.readyAt}:${ids.join(',')}`;if(ids.length&&lastAction!==key){lastAction=key;send(host,{type:'pickTargets',cardIds:ids});}return;}
  if(pp?.pairChoice&&pp.pickerPid===state.yourIndex){const key=`pair:${pp.pairChoice.drawn?.id}`;if(lastAction!==key){lastAction=key;send(host,{type:'pairChoice',skip:true});}return;}
  if(pp&&!pp.result&&pp.pickerPid===state.yourIndex&&pp.ready){const key=`pick:${pp.readyAt}`;if(lastAction!==key){lastAction=key;send(host,{type:'pick',index:0});}return;}
  if(state.isYourTurn&&state.playableCardIds?.length){const id=state.playableCardIds[0];const key=`play:${state.round}:${state.trick?.length}:${id}:${state.players[0]?.handCount}`;if(lastAction!==key){lastAction=key;send(host,{type:'play',cardId:id});}}
}
function connectHost(){host=new WebSocket(`ws://127.0.0.1:${port}`);host.on('open',()=>send(host,{type:'create',name:'HumanHost',rounds:1,participantRole:'player'}));host.on('message',raw=>{try{const message=JSON.parse(String(raw));if(message.type==='errorMsg')throw new Error(message.message);if(message.type==='created'){code=message.code;connectSpectator();}if(message.type==='state'){const s=message.state;if(s.phase!=='lobby'&&s.players.length===4){playerPrivacy=s.players.every((p,i)=>i===s.yourIndex?Array.isArray(p.hand):p.hand===null);}hostAction(s);}}catch(error){done(error);}});host.on('error',done);}
function connectSpectator(){spectator=new WebSocket(`ws://127.0.0.1:${port}`);spectator.on('open',()=>send(spectator,{type:'join',code,name:'Audience',participantRole:'spectator'}));spectator.on('message',raw=>{try{const message=JSON.parse(String(raw));if(message.type==='errorMsg')throw new Error(message.message);if(message.type==='state'){const s=message.state;if(s.phase!=='lobby')spectatorFullHands=s.players.every(p=>Array.isArray(p.hand));if(s.phase==='finished'){assert.strictEqual(s.participantRole,'spectator');assert(s.players.every(p=>Array.isArray(p.playEvaluation)&&p.playEvaluation.length));assert(spectatorFullHands);assert(playerPrivacy);sawFinishedState=true;return;}if(sawFinishedState&&rematchRequested&&s.phase!=='finished'){assert.strictEqual(s.participantRole,'spectator','rematch must preserve spectator role');assert.strictEqual(s.spectatorCount,1);assert(s.players.every(p=>Array.isArray(p.hand)&&p.hand.length===13),'rematch spectator still receives full current hands');done(null,{result:'passed',suite:'spectator-cpu-fullgame-v37',rematchRole:'spectator',players:s.players.length,spectatorCount:s.spectatorCount});}}}catch(error){done(error);}});spectator.on('error',done);}
child.stdout.on('data',d=>{if(String(d).includes('server listening'))connectHost();});
