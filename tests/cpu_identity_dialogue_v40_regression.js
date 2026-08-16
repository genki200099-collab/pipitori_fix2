'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const {spawn}=require('child_process');
const WebSocket=require('ws');
const root=path.resolve(__dirname,'..');
const serverSource=fs.readFileSync(path.join(root,'server.js'),'utf8');
const html=fs.readFileSync(path.join(root,'public','index.html'),'utf8');
const port=45000+(process.pid%9000);

class Peer{
  constructor(ws){this.ws=ws;this.queue=[];this.waiters=[];ws.on('message',raw=>{let msg;try{msg=JSON.parse(String(raw));}catch{return;}const i=this.waiters.findIndex(w=>w.test(msg));if(i>=0){const w=this.waiters.splice(i,1)[0];clearTimeout(w.timer);w.resolve(msg);}else this.queue.push(msg);});}
  send(payload){this.ws.send(JSON.stringify(payload));}
  next(test=()=>true,timeout=5000){const i=this.queue.findIndex(test);if(i>=0)return Promise.resolve(this.queue.splice(i,1)[0]);return new Promise((resolve,reject)=>{const w={test,resolve,reject,timer:setTimeout(()=>{const n=this.waiters.indexOf(w);if(n>=0)this.waiters.splice(n,1);reject(new Error('message timeout'));},timeout)};this.waiters.push(w);});}
}
const openPeer=()=>new Promise((resolve,reject)=>{const ws=new WebSocket(`ws://127.0.0.1:${port}`);ws.once('open',()=>resolve(new Peer(ws)));ws.once('error',reject);});
async function sendAwait(peer,payload,test){const waiting=peer.next(test);peer.send(payload);return waiting;}

const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','pipe']});
let stderr='';child.stderr.on('data',chunk=>stderr+=String(chunk));

(async()=>{
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('server start timeout')),5000);child.stdout.on('data',chunk=>{if(String(chunk).includes('server listening')){clearTimeout(timer);resolve();}});child.once('exit',code=>reject(new Error(`server exited ${code}`)));});
  const host=await openPeer();
  await sendAwait(host,{type:'create',name:'WatcherHost',participantRole:'spectator'},m=>m.type==='created');
  let latest;
  for(let count=1;count<=4;count++) latest=(await sendAwait(host,{type:'addCpu'},m=>m.type==='state'&&m.state?.players?.length===count)).state;
  const names=latest.players.map(p=>p.name),avatars=latest.players.map(p=>p.avatar);
  assert.deepStrictEqual(names.slice(0,3),['かももどき','ワクもどき','リクもどき'],'the three authored CPU character names stay fixed');
  assert.deepStrictEqual(avatars.slice(0,3),['🦆','✊🏻','📋'],'the three authored CPU character icons stay fixed');
  assert.deepStrictEqual(latest.players.slice(0,3).map(p=>p.displayIdentityKey),[null,null,null],'fixed personas use their authored portraits');
  assert.deepStrictEqual(latest.players.slice(0,3).map(p=>p.cpuKey),['kamomodoki','wakumodoki','rikumodoki']);
  const fourth=latest.players[3];
  assert(fourth.displayIdentityKey&&fourth.displayIdentityKey===`${fourth.name}:${fourth.avatar}`,'only the fourth CPU receives a paired animal display identity');
  assert(!names.slice(0,3).includes(fourth.name),'fourth display name does not replace a fixed persona');
  assert.strictEqual(new Set(names).size,4,'CPU display names are unique in one room');
  assert.strictEqual(new Set(avatars).size,4,'CPU icons are unique in one room');
  assert(names.every(name=>!/^CPU\d+$/i.test(name)),'internal CPU slot names never become display names');
  assert(latest.players.every(p=>['kamomodoki','wakumodoki','rikumodoki'].includes(p.cpuKey)),'three personality algorithms remain separate');
  const stable=latest.players.map(p=>[p.id,p.name,p.avatar,p.cpuKey]);
  host.send({type:'ping'});await host.next(m=>m.type==='pong');
  latest=(await sendAwait(host,{type:'removeCpu'},m=>m.type==='state'&&m.state?.players?.length===3)).state;
  assert.deepStrictEqual(latest.players.map(p=>[p.id,p.name,p.avatar,p.cpuKey]),stable.slice(0,3),'existing CPU identities survive state changes');
  latest=(await sendAwait(host,{type:'addCpu'},m=>m.type==='state'&&m.state?.players?.length===4)).state;
  assert(latest.players.every(p=>!/^CPU\d+$/i.test(p.name)));
  assert.strictEqual(new Set(latest.players.map(p=>p.avatar)).size,4);

  // Dialogue stability contract: server-created immutable event id + DOM update only on id change.
  assert.match(serverSource,/id:String\(meta\.id \|\| `comment-/);
  assert.match(html,/commentEventId/);
  assert.match(html,/commentary\.dataset\.commentEventId!==commentEventId/);
  assert.match(html,/if\(key === __lastCommentaryRenderKey\)/);
  assert.match(html,/data-comment-event-id/);
  const spectatorFunction=html.slice(html.indexOf('function renderSpectatorView()'),html.indexOf('function rememberAnimationEvent'));
  const guard=spectatorFunction.indexOf('commentary.dataset.commentEventId!==commentEventId');
  const rewrite=spectatorFunction.indexOf('commentary.innerHTML');
  assert(guard>=0&&rewrite>guard,'spectator bubble innerHTML is guarded by stable event id');

  host.ws.close();child.kill('SIGTERM');
  console.log(JSON.stringify({result:'passed',suite:'cpu-identity-dialogue-v40',cpuCount:4,names,avatars,fixedPersonas:names.slice(0,3),randomAnimalFourth:names[3],personalitySeparated:true,commentDomStable:true}));
})().catch(error=>{child.kill('SIGTERM');console.error(error.stack||error);if(stderr)console.error(stderr);process.exitCode=1;});
