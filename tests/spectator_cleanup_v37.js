'use strict';

const assert=require('assert');
const path=require('path');
const {spawn}=require('child_process');
const WebSocket=require('ws');
const root=path.resolve(__dirname,'..');
const port=41000+(process.pid%14000);

class Peer{
  constructor(ws){this.ws=ws;this.queue=[];this.waiters=[];ws.on('message',raw=>{let message;try{message=JSON.parse(String(raw));}catch{return;}const index=this.waiters.findIndex(w=>w.predicate(message));if(index>=0){const waiter=this.waiters.splice(index,1)[0];clearTimeout(waiter.timer);waiter.resolve(message);}else this.queue.push(message);});}
  send(payload){this.ws.send(JSON.stringify(payload));}
  next(predicate=()=>true,timeout=4000){const index=this.queue.findIndex(predicate);if(index>=0)return Promise.resolve(this.queue.splice(index,1)[0]);return new Promise((resolve,reject)=>{const waiter={predicate,resolve,reject,timer:setTimeout(()=>{const i=this.waiters.indexOf(waiter);if(i>=0)this.waiters.splice(i,1);reject(new Error('message timeout'));},timeout)};this.waiters.push(waiter);});}
  close(){try{this.ws.close();}catch{}}
}

function openPeer(){return new Promise((resolve,reject)=>{const ws=new WebSocket(`ws://127.0.0.1:${port}`);ws.once('open',()=>resolve(new Peer(ws)));ws.once('error',reject);});}
async function sendAwait(peer,payload,predicate){const waiting=peer.next(predicate);peer.send(payload);return waiting;}
const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:String(port),ROOM_EMPTY_TTL_MS:'180'},stdio:['ignore','pipe','pipe']});
let stderr='';child.stderr.on('data',chunk=>stderr+=String(chunk));

(async()=>{
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('server start timeout')),5000);child.stdout.on('data',chunk=>{if(String(chunk).includes('server listening')){clearTimeout(timer);resolve();}});child.once('exit',code=>reject(new Error(`server exited ${code}`)));});
  const host=await openPeer();
  const created=await sendAwait(host,{type:'create',name:'CleanupHost'},m=>m.type==='created');
  const spectator=await openPeer();
  const joined=await sendAwait(spectator,{type:'join',code:created.code,name:'LastWatcher',participantRole:'spectator'},m=>m.type==='joined');
  await spectator.next(m=>m.type==='state'&&m.state?.spectatorCount===1);

  host.ws.terminate();
  const spectatorOnly=(await spectator.next(m=>m.type==='state'&&m.state?.players?.[0]?.connected===false,2500)).state;
  assert.strictEqual(spectatorOnly.spectatorCount,1);

  spectator.ws.terminate();
  const spectatorReturn=await openPeer();
  const returned=await sendAwait(spectatorReturn,{type:'reconnect',code:created.code,playerId:joined.playerId,name:joined.name,resumeToken:joined.resumeToken},m=>m.type==='reconnected');
  assert.strictEqual(returned.participantRole,'spectator','spectator-only reconnect preserves its role');
  const returnedState=(await spectatorReturn.next(m=>m.type==='state')).state;
  assert.strictEqual(returnedState.participantRole,'spectator');
  await new Promise(resolve=>setTimeout(resolve,360));

  const reconnect=await openPeer();
  const rejected=await sendAwait(reconnect,{type:'reconnect',code:created.code,playerId:joined.playerId,name:joined.name,resumeToken:joined.resumeToken},m=>m.type==='errorMsg');
  assert.match(rejected.message,/見つかりません/,'spectator-only room expires on the configured empty-room TTL');

  reconnect.close();spectatorReturn.close();spectator.close();child.kill('SIGTERM');
  console.log(JSON.stringify({result:'passed',suite:'spectator-cleanup-v37',ttlMs:180,spectatorOnlyExpired:true}));
})().catch(error=>{child.kill('SIGTERM');console.error(error.stack||error);if(stderr)console.error(stderr);process.exitCode=1;});
