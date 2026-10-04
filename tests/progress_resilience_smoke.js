'use strict';

const assert = require('assert');
const path = require('path');
const {spawn} = require('child_process');
const WebSocket = require('ws');

const root = path.resolve(__dirname, '..');
const port = 43000 + (process.pid % 16000);
const url = `ws://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server.js'], {
  cwd:root,
  env:{
    ...process.env,
    PORT:String(port),
    ROOM_EMPTY_TTL_MS:'3000',
    DISCONNECTED_ACTION_GRACE_MS:'300',
    WS_HEARTBEAT_INTERVAL_MS:'500'
  },
  stdio:['ignore','pipe','pipe']
});

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const stderr=[];
child.stderr.on('data',chunk=>stderr.push(String(chunk)));

class Peer {
  constructor(socket){
    this.socket=socket;
    this.queue=[];
    this.waiters=[];
    socket.on('message',raw=>{
      let message;
      try{ message=JSON.parse(String(raw)); }catch(error){ return; }
      const index=this.waiters.findIndex(waiter=>waiter.predicate(message));
      if(index>=0){
        const [waiter]=this.waiters.splice(index,1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        this.queue.push(message);
      }
    });
  }
  send(payload){ this.socket.send(JSON.stringify(payload)); }
  next(predicate, timeoutMs=10000){
    const index=this.queue.findIndex(predicate);
    if(index>=0) return Promise.resolve(this.queue.splice(index,1)[0]);
    return new Promise((resolve,reject)=>{
      const waiter={predicate,resolve,reject,timer:null};
      waiter.timer=setTimeout(()=>{
        const i=this.waiters.indexOf(waiter);
        if(i>=0) this.waiters.splice(i,1);
        reject(new Error('message timeout'));
      },timeoutMs);
      this.waiters.push(waiter);
    });
  }
  close(){
    if(this.socket.readyState>=WebSocket.CLOSING) return Promise.resolve();
    return new Promise(resolve=>{
      this.socket.once('close',resolve);
      this.socket.close(4100,'resilience test disconnect');
    });
  }
}

function connect(){
  return new Promise((resolve,reject)=>{
    const socket=new WebSocket(url);
    socket.once('open',()=>resolve(new Peer(socket)));
    socket.once('error',reject);
  });
}

function waitForServer(){
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('server start timeout')),10000);
    child.stdout.on('data',chunk=>{
      if(!String(chunk).includes('server listening')) return;
      clearTimeout(timer);
      resolve();
    });
    child.once('exit',code=>reject(new Error(`server exited early: ${code}`)));
  });
}

async function reconnect(credentials){
  const peer=await connect();
  peer.send({type:'reconnect',...credentials});
  const ack=await peer.next(message=>message.type==='reconnected' || message.type==='errorMsg');
  if(ack.type==='errorMsg') throw new Error(ack.message);
  const state=(await peer.next(message=>message.type==='state')).state;
  return {peer,state};
}

async function run(){
  await waitForServer();

  // 空室削除タイマーが古い切断時刻を引き継がないことを確認する。
  const first=await connect();
  first.send({type:'create',name:'ResilienceTester',rounds:1});
  const created=await first.next(message=>message.type==='created');
  await first.next(message=>message.type==='state');
  const credentials={code:created.code,playerId:created.playerId,name:created.name,resumeToken:created.resumeToken};
  const firstClosedAt=Date.now();
  await first.close();

  await sleep(1000);
  const secondResult=await reconnect(credentials);
  await secondResult.peer.close();

  // 1回目の削除期限は越えるが、2回目の切断からの期限内で再接続する。
  const waitPastFirstExpiry=Math.max(0,firstClosedAt+3150-Date.now());
  await sleep(waitPastFirstExpiry);
  const thirdResult=await reconnect(credentials);
  const peer=thirdResult.peer;
  assert.strictEqual(thirdResult.state.code,credentials.code,'room must survive a stale cleanup timer');

  // 人間が通常手番で切断しても、猶予後に合法手が1枚出され、同じ席へ戻れることを確認する。
  let requestedPlayerCount=-1;
  let started=false;
  let before=null;
  let pendingState=thirdResult.state;
  const deadline=Date.now()+15000;
  while(Date.now()<deadline && !before){
    const state=pendingState || (await peer.next(item=>item.type==='state',12000)).state;
    pendingState=null;
    if(state.phase==='lobby'){
      if(state.players.length<4 && requestedPlayerCount!==state.players.length){
        requestedPlayerCount=state.players.length;
        peer.send({type:'addCpu'});
      } else if(state.players.length===4 && !started){
        started=true;
        peer.send({type:'start'});
      }
      continue;
    }
    if(state.phase!=='playing') continue;
    const pp=state.pendingPick;
    if(pp?.targetSelectionRequired && !pp.targetSelectionDone && pp.pickProviderPid===state.yourIndex){
      peer.send({type:'pickTargets',cardIds:(pp.targetSelectableCardIds||[]).slice(0,pp.targetCount)});
      continue;
    }
    if(pp?.pairChoice && pp.pickerPid===state.yourIndex){
      peer.send({type:'pairChoice',skip:true});
      continue;
    }
    if(pp && !pp.result && pp.pickerPid===state.yourIndex && pp.ready){
      peer.send({type:'pick',index:0});
      continue;
    }
    if(state.isYourTurn && state.playableCardIds?.length){
      const own=state.players[state.yourIndex];
      before={handCount:own.handCount,handIds:(own.hand||[]).map(card=>card.id)};
    }
  }
  assert.ok(before,'human turn must be reached');
  await peer.close();
  await sleep(1600);

  const recovered=await reconnect(credentials);
  const own=recovered.state.players[recovered.state.yourIndex];
  assert.strictEqual(recovered.state.you,credentials.playerId);
  assert.ok(own.handCount<=before.handCount-1,'disconnected turn must auto-play one legal card');
  assert.ok(before.handIds.some(id=>!(own.hand||[]).some(card=>card.id===id)),'one previous hand card must leave the hand');
  assert.strictEqual(stderr.join('').trim(),'');
  await recovered.peer.close();

  console.log(JSON.stringify({
    result:'passed',
    room:credentials.code,
    staleCleanupTimerCancelled:true,
    disconnectedTurnAutoPlayed:true,
    sameSeatRecovered:true
  }));
}

run().catch(error=>{
  console.error(error.stack||error);
  if(stderr.length) console.error(stderr.join(''));
  process.exitCode=1;
}).finally(()=>{
  if(!child.killed) child.kill('SIGTERM');
});
