'use strict';

const assert=require('assert');
const path=require('path');
const {spawn}=require('child_process');
const WebSocket=require('ws');
const root=path.resolve(__dirname,'..');
const port=43000+(process.pid%10000);
let currentStep='startup';

class Peer{
  constructor(socket){
    this.socket=socket;this.queue=[];this.waiters=[];this.history=[];
    socket.on('message',raw=>{
      let message;try{message=JSON.parse(String(raw));}catch{return;}
      this.history.push(message);this.history=this.history.slice(-6);
      const index=this.waiters.findIndex(item=>item.predicate(message));
      if(index>=0){const item=this.waiters.splice(index,1)[0];clearTimeout(item.timer);item.resolve(message);}
      else this.queue.push(message);
    });
  }
  send(payload){this.socket.send(JSON.stringify(payload));}
  next(predicate=()=>true,timeout=9000){
    const index=this.queue.findIndex(predicate);if(index>=0)return Promise.resolve(this.queue.splice(index,1)[0]);
    return new Promise((resolve,reject)=>{const item={predicate,resolve,reject,timer:setTimeout(()=>{const i=this.waiters.indexOf(item);if(i>=0)this.waiters.splice(i,1);const recent=this.history.map(m=>m.type==='state'?`state:${m.state?.players?.length}/${m.state?.spectatorCount}:${m.state?.message}`:`${m.type}:${m.message||''}`).join(' | ');reject(new Error(`message timeout at ${currentStep}; recent=${recent}`));},timeout)};this.waiters.push(item);});
  }
  close(){try{this.socket.close();}catch{}}
}
function openPeer(){return new Promise((resolve,reject)=>{const socket=new WebSocket(`ws://127.0.0.1:${port}`);socket.once('open',()=>resolve(new Peer(socket)));socket.once('error',reject);});}
async function sendAwait(peer,payload,predicate){const waiting=peer.next(predicate);peer.send(payload);return waiting;}
const isState=(players,spectators,extra=()=>true)=>message=>message.type==='state'&&message.state?.players?.length===players&&message.state?.spectatorCount===spectators&&extra(message.state);

const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:String(port),ROOM_EMPTY_TTL_MS:'600000'},stdio:['ignore','pipe','pipe']});
let stderr='';child.stderr.on('data',chunk=>stderr+=String(chunk));
const peers=[];
async function peer(){const item=await openPeer();peers.push(item);return item;}
async function createHost(role='player',name='Host'){
  const host=await peer();
  const created=await sendAwait(host,{type:'create',name,participantRole:role},message=>message.type==='created');
  return {host,created};
}
async function join(code,role,name){
  const item=await peer();
  const joined=await sendAwait(item,{type:'join',code,name,participantRole:role},message=>message.type==='joined');
  assert.strictEqual(joined.participantRole,role);
  return {peer:item,joined};
}
async function fillPlayers(code,current,total,prefix){for(let i=current;i<total;i++)await join(code,'player',`${prefix}-P${i}`);}
async function fillSpectators(code,count,prefix){for(let i=0;i<count;i++)await join(code,'spectator',`${prefix}-S${i}`);}

async function threePlusSpectators(spectatorCount,index){
  currentStep=`three-plus-${spectatorCount}-setup`;
  const {host,created}=await createHost('player',`H-${index}`);
  await fillPlayers(created.code,1,3,`R${index}`);await fillSpectators(created.code,spectatorCount,`R${index}`);
  currentStep=`three-plus-${spectatorCount}-ready`;await host.next(isState(3,spectatorCount,state=>state.canAddCpu===true&&state.playerSeatCount===3));
  host.send({type:'addCpu'});
  currentStep=`three-plus-${spectatorCount}-added`;const after=(await host.next(isState(4,spectatorCount))).state;
  assert.strictEqual(after.playerSeatCount,4);assert.strictEqual(after.canAddCpu,false);
  assert.strictEqual(after.players.filter(player=>player.cpu).length,1);
}

(async()=>{
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('server start timeout')),7000);child.stdout.on('data',chunk=>{if(String(chunk).includes('server listening')){clearTimeout(timer);resolve();}});child.once('exit',code=>reject(new Error(`server exited ${code}`)));});

  for(const [index,count] of [0,1,3,12].entries()) await threePlusSpectators(count,index);

  // Two seats plus spectators can add two CPUs, one command per open game seat.
  {
    const {host,created}=await createHost('player','TwoHost');await fillPlayers(created.code,1,2,'Two');await fillSpectators(created.code,4,'Two');
    await host.next(isState(2,4,state=>state.canAddCpu));host.send({type:'addCpu'});
    await host.next(isState(3,4,state=>state.canAddCpu));host.send({type:'addCpu'});
    const full=(await host.next(isState(4,4))).state;assert.strictEqual(full.players.filter(player=>player.cpu).length,2);
  }

  // Four human seats reject an extra CPU regardless of spectators.
  {
    const {host,created}=await createHost('player','FullHuman');await fillPlayers(created.code,1,4,'Full');await fillSpectators(created.code,3,'Full');
    await host.next(isState(4,3));host.send({type:'addCpu'});
    const denied=(await host.next(isState(4,3,state=>/4席すべて/.test(state.message)))).state;
    assert.strictEqual(denied.players.filter(player=>player.cpu).length,0);assert.strictEqual(denied.canAddCpu,false);
  }

  // Three players + one CPU is also full; removing the CPU reopens exactly one seat and it can be re-added.
  {
    const {host,created}=await createHost('player','RepeatHost');await fillPlayers(created.code,1,3,'Repeat');await fillSpectators(created.code,5,'Repeat');
    await host.next(isState(3,5));host.send({type:'addCpu'});await host.next(isState(4,5));
    host.send({type:'addCpu'});const denied=(await host.next(isState(4,5,state=>/4席すべて/.test(state.message)))).state;
    assert.strictEqual(denied.players.filter(player=>player.cpu).length,1);
    host.send({type:'removeCpu'});const removed=(await host.next(isState(3,5,state=>state.canAddCpu))).state;assert.strictEqual(removed.players.some(player=>player.cpu),false);
    host.send({type:'addCpu'});const restored=(await host.next(isState(4,5))).state;assert.strictEqual(restored.players.filter(player=>player.cpu).length,1);
  }

  // A spectator host retains authority; the host itself never consumes a game seat.
  {
    const {host,created}=await createHost('spectator','SpectatorHost');await fillPlayers(created.code,0,3,'SH');await fillSpectators(created.code,2,'SH');
    await host.next(isState(3,3,state=>state.hostId===state.you&&state.canAddCpu));host.send({type:'addCpu'});
    const full=(await host.next(isState(4,3))).state;assert.strictEqual(full.participantRole,'spectator');assert.strictEqual(full.players.filter(player=>player.cpu).length,1);
  }

  // Reconnect keeps host authority and still derives capacity from players only.
  {
    currentStep='reconnect-setup';
    const {host,created}=await createHost('player','ReconnectHost');await fillPlayers(created.code,1,3,'RC');
    const reconnecting=await join(created.code,'spectator','RC-Watcher');await fillSpectators(created.code,1,'RC');
    await host.next(isState(3,2));reconnecting.peer.close();await new Promise(resolve=>setTimeout(resolve,80));
    // Reconnect the spectator's own stable identity; the host remains connected and authorized.
    const replacement2=await peer();await sendAwait(replacement2,{type:'reconnect',code:created.code,playerId:reconnecting.joined.playerId,name:reconnecting.joined.name,resumeToken:reconnecting.joined.resumeToken},message=>message.type==='reconnected');
    await replacement2.next(isState(3,2,state=>state.participantRole==='spectator'));
    currentStep='reconnect-add';host.send({type:'addCpu'});
    const state=(await host.next(isState(4,2))).state;assert.strictEqual(state.players.filter(player=>player.cpu).length,1);
  }

  // A role change from spectator to player changes playerSeatCount, not total participant count.
  {
    const {host,created}=await createHost('player','RoleHost');await fillPlayers(created.code,1,2,'Role');
    const changing=await join(created.code,'spectator','RoleSwitcher');await fillSpectators(created.code,2,'Role');
    await host.next(isState(2,3));changing.peer.send({type:'changeParticipantRole',participantRole:'player'});
    await changing.peer.next(message=>message.type==='state'&&message.state?.participantRole==='player'&&message.state?.playerSeatCount===3);
    await host.next(isState(3,2,state=>state.canAddCpu));host.send({type:'addCpu'});
    const state=(await host.next(isState(4,2))).state;assert.strictEqual(state.players.length,4);
  }

  peers.forEach(item=>item.close());child.kill('SIGTERM');
  console.log(JSON.stringify({result:'passed',suite:'v39-cpu-seat-websocket',spectatorCounts:[0,1,3,12],spectatorHost:true,reconnect:true,roleChange:true,removeAdd:true}));
})().catch(error=>{peers.forEach(item=>item.close());child.kill('SIGTERM');console.error(error.stack||error);if(stderr)console.error(stderr);process.exitCode=1;});
