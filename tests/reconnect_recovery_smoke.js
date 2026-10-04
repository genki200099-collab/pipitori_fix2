'use strict';

const assert = require('assert');
const path = require('path');
const {spawn} = require('child_process');
const WebSocket = require('ws');

const root = path.resolve(__dirname, '..');
const port = 41000 + (process.pid % 18000);
const child = spawn(process.execPath, ['server.js'], {
  cwd:root,
  env:{...process.env, PORT:String(port)},
  stdio:['ignore','pipe','pipe']
});

const errors=[];
let finished=false;
let primary=null;
let recovered=null;
let credentials=null;
let snapshot=null;
let stage='boot';
let lastAction='';
let playedCardId='';
let playedFromCount=0;
const startedAt=Date.now();
const timeout=setTimeout(()=>fail(new Error(`reconnect smoke timeout at stage ${stage}`)), 70000);

child.stderr.on('data', chunk=>errors.push(String(chunk)));
child.on('exit', code=>{ if(!finished && code!==null) fail(new Error(`server exited: ${code}`)); });

function stop(){
  clearTimeout(timeout);
  for(const socket of [primary,recovered]){
    if(socket && socket.readyState<WebSocket.CLOSING) socket.close();
  }
  if(!child.killed) child.kill('SIGTERM');
}

function fail(error){
  if(finished) return;
  finished=true;
  stop();
  console.error(error.stack || error);
  if(errors.length) console.error(errors.join(''));
  process.exitCode=1;
}

function send(socket, payload){
  if(socket?.readyState===WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function resolvePending(socket, state){
  const pp=state.pendingPick;
  if(!pp) return false;
  if(pp.targetSelectionRequired && !pp.targetSelectionDone && pp.pickProviderPid===state.yourIndex){
    const count=Math.min(pp.targetCandidateCount || 0, pp.targetSelectableCardIds?.length || 0);
    const ids=(pp.targetSelectableCardIds || []).slice(0,count);
    const key=`targets:${pp.readyAt}:${ids.join(',')}`;
    if(ids.length && key!==lastAction){ lastAction=key; send(socket,{type:'pickTargets',cardIds:ids}); }
    return true;
  }
  if(pp.pairChoice && pp.pickerPid===state.yourIndex){
    const key=`pair:${pp.pairChoice.drawn?.id || pp.readyAt}`;
    if(key!==lastAction){ lastAction=key; send(socket,{type:'pairChoice',skip:true}); }
    return true;
  }
  if(!pp.result && pp.pickerPid===state.yourIndex && pp.ready){
    const key=`pick:${pp.readyAt}`;
    if(key!==lastAction){ lastAction=key; send(socket,{type:'pick',index:0}); }
    return true;
  }
  return true;
}

function createWrongTokenProbe(){
  stage='wrong-token-probe';
  const probe=new WebSocket(`ws://127.0.0.1:${port}`);
  probe.on('open',()=>send(probe,{type:'reconnect',code:credentials.code,playerId:credentials.playerId,name:credentials.name,resumeToken:'0'.repeat(48)}));
  probe.on('message',raw=>{
    try{
      const msg=JSON.parse(String(raw));
      if(msg.type!=='errorMsg') return;
      assert.match(msg.message,/復帰できる席/);
      probe.close();
      connectRecovered();
    }catch(error){ fail(error); }
  });
  probe.on('error',fail);
}

function connectRecovered(){
  stage='reconnecting';
  recovered=new WebSocket(`ws://127.0.0.1:${port}`);
  let acknowledged=false;
  recovered.on('open',()=>send(recovered,{type:'reconnect',...credentials}));
  recovered.on('message',raw=>{
    try{
      const msg=JSON.parse(String(raw));
      if(msg.type==='errorMsg') throw new Error(msg.message);
      if(msg.type==='reconnected'){
        acknowledged=true;
        assert.strictEqual(msg.playerId,credentials.playerId);
        assert.strictEqual(msg.resumeToken,credentials.resumeToken);
        return;
      }
      if(msg.type!=='state') return;
      assert.ok(acknowledged,'reconnected acknowledgement must precede state');
      const state=msg.state;
      const own=state.players?.[state.yourIndex];
      if(stage==='reconnecting'){
        assert.strictEqual(state.you,credentials.playerId);
        assert.strictEqual(state.phase,snapshot.phase);
        assert.strictEqual(state.round,snapshot.round);
        assert.deepStrictEqual((own?.hand || []).map(card=>card.id),snapshot.handIds);
        assert.strictEqual(own?.scorePileCount,snapshot.scorePileCount);
        assert.strictEqual(state.isYourTurn,true);
        assert.ok(state.playableCardIds?.length,'playable cards must survive reconnect');
        stage='resumed';
        playedCardId=state.playableCardIds[0];
        playedFromCount=own.handCount;
        send(recovered,{type:'play',cardId:playedCardId});
        return;
      }
      if(stage==='resumed'){
        const accepted=own.handCount===playedFromCount-1 || (state.trick || []).some(item=>item.card?.id===playedCardId);
        if(!accepted) return;
        assert.strictEqual(errors.join('').trim(),'');
        finished=true;
        stop();
        console.log(JSON.stringify({
          result:'passed',
          elapsedMs:Date.now()-startedAt,
          room:credentials.code,
          samePlayerId:true,
          handRestored:snapshot.handIds.length,
          postReconnectPlayAccepted:true
        }));
      }
    }catch(error){ fail(error); }
  });
  recovered.on('error',fail);
}

function handlePrimaryState(state){
  if(state.phase==='lobby'){
    if(state.players.length<4){ send(primary,{type:'addCpu'}); return; }
    if(stage!=='waiting-turn'){
      stage='waiting-turn';
      send(primary,{type:'start'});
    }
    return;
  }
  if(state.phase!=='playing') return;
  if(resolvePending(primary,state)) return;
  if(!state.isYourTurn || !state.playableCardIds?.length) return;
  const own=state.players[state.yourIndex];
  snapshot={
    phase:state.phase,
    round:state.round,
    handIds:(own.hand || []).map(card=>card.id),
    scorePileCount:own.scorePileCount
  };
  stage='disconnected';
  primary.close(4100,'test network drop');
}

child.stdout.on('data',chunk=>{
  if(primary || !String(chunk).includes('server listening')) return;
  stage='creating';
  primary=new WebSocket(`ws://127.0.0.1:${port}`);
  primary.on('open',()=>send(primary,{type:'create',name:'ReconnectTester',rounds:1}));
  primary.on('message',raw=>{
    try{
      const msg=JSON.parse(String(raw));
      if(msg.type==='errorMsg') throw new Error(msg.message);
      if(msg.type==='created'){
        assert.match(msg.resumeToken,/^[a-f0-9]{48}$/);
        credentials={code:msg.code,playerId:msg.playerId,name:msg.name,resumeToken:msg.resumeToken};
      }
      if(msg.type==='state') handlePrimaryState(msg.state);
    }catch(error){ fail(error); }
  });
  primary.on('close',()=>{
    if(stage==='disconnected') setTimeout(createWrongTokenProbe,60);
  });
  primary.on('error',fail);
});
