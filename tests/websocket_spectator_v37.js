'use strict';

const assert=require('assert');
const path=require('path');
const {spawn}=require('child_process');
const WebSocket=require('ws');
const root=path.resolve(__dirname,'..');
const port=37000+(process.pid%18000);

class Peer{
  constructor(ws){this.ws=ws;this.queue=[];this.waiters=[];ws.on('message',raw=>{let message;try{message=JSON.parse(String(raw));}catch{return;}const index=this.waiters.findIndex(w=>w.predicate(message));if(index>=0){const waiter=this.waiters.splice(index,1)[0];clearTimeout(waiter.timer);waiter.resolve(message);}else this.queue.push(message);});}
  send(payload){this.ws.send(JSON.stringify(payload));}
  next(predicate=()=>true,timeout=7000){const index=this.queue.findIndex(predicate);if(index>=0)return Promise.resolve(this.queue.splice(index,1)[0]);return new Promise((resolve,reject)=>{const waiter={predicate,resolve,reject,timer:setTimeout(()=>{const i=this.waiters.indexOf(waiter);if(i>=0)this.waiters.splice(i,1);reject(new Error('message timeout'));},timeout)};this.waiters.push(waiter);});}
  close(){try{this.ws.close();}catch{}}
}

function openPeer(){return new Promise((resolve,reject)=>{const ws=new WebSocket(`ws://127.0.0.1:${port}`);ws.once('open',()=>resolve(new Peer(ws)));ws.once('error',reject);});}
async function sendAwait(peer,payload,predicate){const waiting=peer.next(predicate);peer.send(payload);return waiting;}

const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:String(port),ROOM_EMPTY_TTL_MS:'600000'},stdio:['ignore','pipe','pipe']});
let stderr='';child.stderr.on('data',chunk=>stderr+=String(chunk));

(async()=>{
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('server start timeout')),6000);child.stdout.on('data',chunk=>{if(String(chunk).includes('server listening')){clearTimeout(timer);resolve();}});child.once('exit',code=>reject(new Error(`server exited ${code}`)));});
  const peers=[];
  const host=await openPeer();peers.push(host);
  const created=await sendAwait(host,{type:'create',name:'Host',rounds:1},m=>m.type==='created');
  assert.strictEqual(created.participantRole,'player');
  for(let i=1;i<4;i++){
    const peer=await openPeer();peers.push(peer);
    await sendAwait(peer,{type:'join',code:created.code,name:`P${i}`,participantRole:'player'},m=>m.type==='joined');
  }
  const fullState=(await host.next(m=>m.type==='state'&&m.state?.players?.length===4)).state;
  assert.strictEqual(fullState.players.length,4);

  const overflow=await openPeer();peers.push(overflow);
  const fullOffer=await sendAwait(overflow,{type:'join',code:created.code,name:'Overflow',participantRole:'player'},m=>m.type==='playerSeatsFull');
  assert.strictEqual(fullOffer.canSpectate,true);
  const spectatorAck=await sendAwait(overflow,{type:'join',code:created.code,name:'Watcher',participantRole:'spectator'},m=>m.type==='joined');
  assert.strictEqual(spectatorAck.participantRole,'spectator');
  const spectatorCredentials={code:created.code,playerId:spectatorAck.playerId,name:spectatorAck.name,resumeToken:spectatorAck.resumeToken};

  const spectator2=await openPeer();peers.push(spectator2);
  await sendAwait(spectator2,{type:'join',code:created.code,name:'Watcher2',participantRole:'spectator'},m=>m.type==='joined');
  const lobbyWithSpectators=(await host.next(m=>m.type==='state'&&m.state?.spectatorCount===2)).state;
  assert.strictEqual(lobbyWithSpectators.players.length,4);
  assert.strictEqual(lobbyWithSpectators.spectators.length,2);
  const fullRoleOffer=await sendAwait(overflow,{type:'changeParticipantRole',participantRole:'player'},m=>m.type==='playerSeatsFull');
  assert.strictEqual(fullRoleOffer.canSpectate,true,'a spectator cannot take a fifth player seat');

  const hostPlaying=host.next(m=>m.type==='state'&&m.state?.phase==='playing');
  const spectatorPlaying=overflow.next(m=>m.type==='state'&&m.state?.phase==='playing');
  host.send({type:'start'});
  const [playerStateMsg,spectatorStateMsg]=await Promise.all([hostPlaying,spectatorPlaying]);
  const playerState=playerStateMsg.state,spectatorState=spectatorStateMsg.state;
  assert.strictEqual(playerState.participantRole,'player');
  assert.strictEqual(spectatorState.participantRole,'spectator');
  assert.strictEqual(spectatorState.yourIndex,-1);
  assert(spectatorState.players.every(p=>Array.isArray(p.hand)&&p.hand.length===13),'spectator receives every complete hand');
  assert(Array.isArray(playerState.players[playerState.yourIndex].hand));
  assert(playerState.players.every((p,i)=>i===playerState.yourIndex?Array.isArray(p.hand):p.hand===null),'player state must not leak other hands');

  const deniedPlay=await sendAwait(overflow,{type:'play',cardId:spectatorState.players[0].hand[0].id},m=>m.type==='errorMsg');
  assert.match(deniedPlay.message,/観戦者/);
  const deniedPick=await sendAwait(overflow,{type:'pick',index:0},m=>m.type==='errorMsg');
  assert.match(deniedPick.message,/観戦者/);
  const deniedPair=await sendAwait(overflow,{type:'pairChoice',skip:true},m=>m.type==='errorMsg');
  assert.match(deniedPair.message,/観戦者/);
  const deniedRole=await sendAwait(overflow,{type:'changeParticipantRole',participantRole:'player'},m=>m.type==='errorMsg');
  assert.match(deniedRole.message,/ゲーム開始前/);

  const midgame=await openPeer();peers.push(midgame);
  const midAck=await sendAwait(midgame,{type:'join',code:created.code,name:'MidGame',participantRole:'spectator'},m=>m.type==='joined');
  assert.strictEqual(midAck.participantRole,'spectator');
  const midState=(await midgame.next(m=>m.type==='state'&&m.state?.phase==='playing')).state;
  assert(midState.players.every(p=>Array.isArray(p.hand)&&p.hand.length===13));
  assert.strictEqual(midState.cardPlayEvent,null,'midgame spectator starts without historical play animation event');

  spectator2.close();
  const afterSpectatorExit=(await host.next(m=>m.type==='state'&&m.state?.phase==='playing'&&m.state?.spectators?.some(s=>s.name==='Watcher2'&&!s.connected))).state;
  assert.strictEqual(afterSpectatorExit.players.length,4,'spectator exit does not alter or stop game seats');

  overflow.close();
  await new Promise(resolve=>setTimeout(resolve,80));
  const reconnected=await openPeer();peers.push(reconnected);
  const reconnectAck=await sendAwait(reconnected,{type:'reconnect',...spectatorCredentials},m=>m.type==='reconnected');
  assert.strictEqual(reconnectAck.participantRole,'spectator');
  const reconnectState=(await reconnected.next(m=>m.type==='state')).state;
  assert.strictEqual(reconnectState.participantRole,'spectator');
  assert(reconnectState.players.every(p=>Array.isArray(p.hand)));

  // Separate lobby verifies both role directions and clear-room delivery to spectators.
  const host2=await openPeer();peers.push(host2);
  const room2=await sendAwait(host2,{type:'create',name:'Host2'},m=>m.type==='created');
  const watcher=await openPeer();peers.push(watcher);
  await sendAwait(watcher,{type:'join',code:room2.code,name:'RoleSwitch',participantRole:'spectator'},m=>m.type==='joined');
  watcher.send({type:'changeParticipantRole',participantRole:'player'});
  const asPlayer=(await watcher.next(m=>m.type==='state'&&m.state?.participantRole==='player')).state;
  assert.strictEqual(asPlayer.players.length,2);
  watcher.send({type:'changeParticipantRole',participantRole:'spectator'});
  const asSpectator=(await watcher.next(m=>m.type==='state'&&m.state?.participantRole==='spectator')).state;
  assert.strictEqual(asSpectator.players.length,1);
  const hostClosed=host2.next(m=>m.type==='roomClosed');
  const spectatorClosed=watcher.next(m=>m.type==='roomClosed');
  host2.send({type:'clearRoom'});
  const closed=await Promise.all([hostClosed,spectatorClosed]);
  assert(closed.every(m=>m.reason==='hostCleared'));

  const spectatorHost=await openPeer();peers.push(spectatorHost);
  const spectatorRoom=await sendAwait(spectatorHost,{type:'create',name:'SpectatorHost',participantRole:'spectator'},m=>m.type==='created');
  assert.strictEqual(spectatorRoom.participantRole,'spectator');
  spectatorHost.send({type:'addCpu'});
  const hostedState=(await spectatorHost.next(m=>m.type==='state'&&m.state?.players?.length===1)).state;
  assert.strictEqual(hostedState.hostId,hostedState.you,'spectator host retains lobby authority');
  assert.strictEqual(hostedState.spectatorCount,1);
  await sendAwait(spectatorHost,{type:'clearRoom'},m=>m.type==='roomClosed');

  peers.forEach(peer=>peer.close());child.kill('SIGTERM');
  console.log(JSON.stringify({result:'passed',suite:'websocket-spectator-v37',players:4,spectators:3,privacy:'viewer-specific'}));
})().catch(error=>{child.kill('SIGTERM');console.error(error.stack||error);if(stderr)console.error(stderr);process.exitCode=1;});
