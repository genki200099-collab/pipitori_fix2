'use strict';

const assert=require('assert');
const path=require('path');
const {spawn}=require('child_process');
const WebSocket=require('ws');
const root=path.resolve(__dirname,'..');
const port=43000+(process.pid%12000);

class Peer{
  constructor(ws){this.ws=ws;this.queue=[];this.waiters=[];ws.on('message',raw=>{let msg;try{msg=JSON.parse(String(raw));}catch{return;}const i=this.waiters.findIndex(w=>w.test(msg));if(i>=0){const w=this.waiters.splice(i,1)[0];clearTimeout(w.timer);w.resolve(msg);}else this.queue.push(msg);});}
  send(payload){this.ws.send(JSON.stringify(payload));}
  next(test=()=>true,timeout=5000){const i=this.queue.findIndex(test);if(i>=0)return Promise.resolve(this.queue.splice(i,1)[0]);return new Promise((resolve,reject)=>{const w={test,resolve,reject,timer:setTimeout(()=>{const n=this.waiters.indexOf(w);if(n>=0)this.waiters.splice(n,1);reject(new Error('message timeout'));},timeout)};this.waiters.push(w);});}
  close(){try{this.ws.close();}catch{}}
}
const openPeer=()=>new Promise((resolve,reject)=>{const ws=new WebSocket(`ws://127.0.0.1:${port}`);ws.once('open',()=>resolve(new Peer(ws)));ws.once('error',reject);});
async function sendAwait(peer,payload,test){const waiting=peer.next(test);peer.send(payload);return waiting;}

const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:String(port),ROOM_EMPTY_TTL_MS:'5000'},stdio:['ignore','pipe','pipe']});
let stderr='';child.stderr.on('data',chunk=>stderr+=String(chunk));

(async()=>{
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('server start timeout')),5000);child.stdout.on('data',chunk=>{if(String(chunk).includes('server listening')){clearTimeout(timer);resolve();}});child.once('exit',code=>reject(new Error(`server exited ${code}`)));});

  // 一時切断は従来どおり同じidentityへ復帰する。
  const temporary=await openPeer();
  const tempCreated=await sendAwait(temporary,{type:'create',name:'Temp'},m=>m.type==='created');
  temporary.ws.terminate();
  const tempReturn=await openPeer();
  const tempAck=await sendAwait(tempReturn,{type:'reconnect',code:tempCreated.code,playerId:tempCreated.playerId,resumeToken:tempCreated.resumeToken,name:'Temp'},m=>m.type==='reconnected');
  assert.strictEqual(tempAck.playerId,tempCreated.playerId);

  // ロビーplayer離脱：席とtokenを無効化し、新規joinだけを許可する。
  const lobbyHost=await openPeer();
  const lobbyCreated=await sendAwait(lobbyHost,{type:'create',name:'LobbyHost'},m=>m.type==='created');
  await sendAwait(lobbyHost,{type:'leaveRoom'},m=>m.type==='leftRoom');
  const staleLobby=await openPeer();
  const staleLobbyError=await sendAwait(staleLobby,{type:'reconnect',code:lobbyCreated.code,playerId:lobbyCreated.playerId,resumeToken:lobbyCreated.resumeToken,name:'LobbyHost'},m=>m.type==='errorMsg');
  assert.match(staleLobbyError.message,/復帰|見つかりません/);
  const freshLobby=await openPeer();
  const freshAck=await sendAwait(freshLobby,{type:'join',code:lobbyCreated.code,name:'Fresh'},m=>m.type==='joined');
  assert.notStrictEqual(freshAck.playerId,lobbyCreated.playerId);

  // ロビーspectator離脱：spectatorsから即時削除し、旧tokenを拒否する。
  const watcher=await openPeer();
  const watchAck=await sendAwait(watcher,{type:'join',code:lobbyCreated.code,name:'Watcher',participantRole:'spectator'},m=>m.type==='joined');
  await sendAwait(watcher,{type:'leaveRoom'},m=>m.type==='leftRoom');
  const lobbyAfterWatch=(await freshLobby.next(m=>m.type==='state'&&m.state?.spectatorCount===0)).state;
  assert.strictEqual(lobbyAfterWatch.spectatorCount,0);
  const staleWatcher=await openPeer();
  const staleWatchError=await sendAwait(staleWatcher,{type:'reconnect',code:lobbyCreated.code,playerId:watchAck.playerId,resumeToken:watchAck.resumeToken,name:'Watcher'},m=>m.type==='errorMsg');
  assert.match(staleWatchError.message,/復帰|見つかりません/);

  // ゲーム中host player離脱：同じseat/handをCPU代打し、接続中spectatorへhost移譲する。
  const host=await openPeer();
  const created=await sendAwait(host,{type:'create',name:'GameHost',rounds:1},m=>m.type==='created');
  const spectator=await openPeer();
  const spectatorAck=await sendAwait(spectator,{type:'join',code:created.code,name:'GameWatcher',participantRole:'spectator'},m=>m.type==='joined');
  for(let count=2;count<=4;count++) await sendAwait(host,{type:'addCpu'},m=>m.type==='state'&&m.state?.players?.length===count);
  const started=(await sendAwait(host,{type:'start'},m=>m.type==='state'&&['playing','passing','initialPair'].includes(m.state?.phase))).state;
  const oldHandCount=started.players[0].handCount;
  await sendAwait(host,{type:'leaveRoom'},m=>m.type==='leftRoom');
  const substitute=(await spectator.next(m=>m.type==='state'&&m.state?.players?.[0]?.cpu===true,6000)).state;
  assert.strictEqual(substitute.players.length,4);
  assert.strictEqual(substitute.players[0].cpu,true);
  assert.strictEqual(substitute.players[0].handCount,oldHandCount,'same seat and hand count are preserved');
  assert.strictEqual(substitute.hostId,spectatorAck.playerId,'host moves to connected spectator when no human player remains');
  assert(!/^CPU\d+$/.test(substitute.players[0].name));
  const staleGame=await openPeer();
  const staleGameError=await sendAwait(staleGame,{type:'reconnect',code:created.code,playerId:created.playerId,resumeToken:created.resumeToken,name:'GameHost'},m=>m.type==='errorMsg');
  assert.match(staleGameError.message,/復帰|見つかりません/);

  // ゲーム中spectator離脱はstate machineへ触れない。
  await sendAwait(spectator,{type:'leaveRoom'},m=>m.type==='leftRoom');

  [tempReturn,lobbyHost,staleLobby,freshLobby,watcher,staleWatcher,host,spectator,staleGame].forEach(peer=>peer?.close());
  child.kill('SIGTERM');
  console.log(JSON.stringify({result:'passed',suite:'intentional-leave-v40',temporaryReconnect:true,lobbyPlayer:true,lobbySpectator:true,gameCpuSubstitute:true,hostTransfer:true,staleTokensRejected:true}));
})().catch(error=>{child.kill('SIGTERM');console.error(error.stack||error);if(stderr)console.error(stderr);process.exitCode=1;});
