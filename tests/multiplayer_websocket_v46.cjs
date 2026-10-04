'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path'),{spawn}=require('child_process'),WS=require('ws');
const root=path.resolve(__dirname,'..'),port=35080+(process.pid%10000),peers=[],rows=[];let active=null,started=false;let errors='';
const child=spawn(process.execPath,['-r','./tests/accelerated_clock_v46.cjs','server.js'],{cwd:root,env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','pipe']});child.stderr.on('data',d=>errors+=d);
class Peer{
 constructor(ws,index){this.ws=ws;this.index=index;this.last=new Set();this.queue=[];this.wait=[];ws.on('message',raw=>{const m=JSON.parse(raw);try{if(m.type==='errorMsg')throw Error(m.message);if(m.type==='state')this.drive(m.state);const i=this.wait.findIndex(w=>w.pred(m));if(i>=0)this.wait.splice(i,1)[0].resolve(m);else this.queue.push(m);}catch(e){finish(e);}});}
 next(pred){const i=this.queue.findIndex(pred);return i>=0?Promise.resolve(this.queue.splice(i,1)[0]):new Promise(resolve=>this.wait.push({pred,resolve}));}
 send(msg){this.ws.send(JSON.stringify(msg));}
 once(key,msg){if(this.last.has(key))return;this.last.add(key);this.send(msg);}
 drive(s){
  if(!active||s.code!==active.code||this.spectator||this.suspended)return;
  if(s.phase==='lobby')return;
  assert.equal(s.playerSeatCapacity,active.seats);assert.equal(s.players.length,active.seats);
  assert(s.players.every((p,i)=>i===s.yourIndex?Array.isArray(p.hand):p.hand===null),'only own hand is visible');
  if(s.phase==='finished'){if(this.index===0)active.resolve(s);return;}
  if(s.phase==='roundEnd'){if(this.index===0)this.once('next:'+s.round,{type:'continueRound'});return;}
  if(s.phase==='passing'){const ids=s.passableCardIds.slice(0,3);this.once('pass',{type:'passThree',cardIds:ids});return;}
  if(s.phase==='initialPair'){this.once('initial',{type:'skipInitialPairs'});return;}
  if(s.pendingShootDecision?.shooterPid===s.yourIndex){this.once('shoot:'+s.pendingShootDecision.id,{type:'shootDecision',fire:true});return;}
  const lanes=s.parallelPickGroup?[s.parallelPickGroup.primary,s.parallelPickGroup.secondary].filter(Boolean):[s.pendingPick].filter(Boolean);
  for(const pp of lanes){
   if(pp.status==='shootDecision'||pp.status==='presenting'||pp.status==='completed'||pp.status==='skipped')continue;
   if(pp.targetSelectionRequired&&!pp.targetSelectionDone&&pp.pickProviderPid===s.yourIndex){const mandatory=pp.mandatoryCandidateIds||[];const ids=[...mandatory,...(pp.targetSelectableCardIds||[]).filter(id=>!mandatory.includes(id))].slice(0,pp.targetCount);this.once('target:'+pp.pickId,{type:'pickTargets',pickId:pp.pickId,cardIds:ids});}
   else if(pp.pairChoice&&!pp.result&&pp.pickerPid===s.yourIndex)this.once('pair:'+pp.pickId,{type:'pairChoice',pickId:pp.pickId,skip:true});
   else if(!pp.result&&pp.ready&&pp.pickerPid===s.yourIndex)this.once('pick:'+pp.pickId,{type:'pick',pickId:pp.pickId,index:0});
  }
  if(s.isYourTurn&&s.playableCardIds.length)this.once('play:'+s.round+':'+s.playableCardIds[0],{type:'play',cardId:s.playableCardIds[0]});
 }
}
function open(index){return new Promise((resolve,reject)=>{const s=new WS(`ws://127.0.0.1:${port}`);s.once('open',()=>{const p=new Peer(s,index);peers.push(p);resolve(p)});s.once('error',reject);});}
let finished=false;const deadline=setTimeout(()=>finish(Error('integration timeout')),90000);
function finish(error){if(finished)return;finished=true;clearTimeout(deadline);peers.forEach(p=>p.ws.close());child.kill();if(error){console.error(error.stack,errors);process.exitCode=1;}else{const result={result:'passed',method:'real local WebSocket with accelerated test clock',rows};fs.writeFileSync(path.join(root,'qa/v46/websocket-completion.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));}}
async function run(){
 for(const seats of [3,4,5])for(const provider of ['winner','weakest']){
  const host=await open(0);const created=host.next(m=>m.type==='created');host.send({type:'create',name:'QA',playerCount:seats,rounds:3,pickProviderRole:provider,roundDealMode:provider==='winner'?'reshuffle':'carryOver',enableMiddleRankPick:true,forceJokerPickCandidate:true,passThreeEnabled:true,initialPairDiscardEnabled:provider==='weakest'});
  const ack=await created;active={code:ack.code,seats};
  let returning,identity;
  for(let i=1;i<seats;i++){const p=await open(i);const waiting=p.next(m=>m.type==='joined');p.send({type:'join',code:ack.code,name:'QA'+i});const joined=await waiting;returning=p;identity=joined;}
  // Spectator sees every hand; players above only see their own.
  const watch=await open(-1);watch.spectator=true;watch.send({type:'join',code:ack.code,name:'watch',participantRole:'spectator'});await watch.next(m=>m.type==='joined');
  const completed=new Promise(resolve=>active.resolve=resolve);host.send({type:'start'});
  const observation=await watch.next(m=>m.type==='state'&&m.state.phase==='playing');assert(observation.state.players.every(p=>Array.isArray(p.hand)));
  returning.suspended=true;await new Promise(resolve=>{returning.ws.once('close',resolve);returning.ws.close();});
  const restored=await open(seats-1);restored.last=returning.last;const resumed=restored.next(m=>m.type==='reconnected');restored.send({type:'reconnect',code:ack.code,playerId:identity.playerId,name:identity.name,resumeToken:identity.resumeToken});const recovered=await resumed;assert.equal(recovered.playerId,identity.playerId);
  const resumedState=await restored.next(m=>m.type==='state');assert.equal(resumedState.state.yourIndex,seats-1);assert(Array.isArray(resumedState.state.players[seats-1].hand));
  const final=await completed;assert.equal(final.round,3);assert(final.players.every(p=>Number.isFinite(p.final.total)));
  rows.push({seats,provider,deal:provider==='winner'?'reshuffle':'carryOver',rounds:final.round,finished:true,playerPrivacy:true,spectatorHands:true,reconnect:true,initialPairs:provider==='weakest',totals:final.players.map(p=>p.final.total)});console.log(JSON.stringify({progress:rows.length,seats,provider}));
  for(const p of peers.filter(p=>p.ws.readyState===1))p.ws.close();active=null;
 }
 finish();
}
child.stdout.on('data',d=>{if(!started&&String(d).includes('server listening')){started=true;run().catch(finish);}});child.on('exit',c=>{if(!finished)finish(Error('server exited '+c));});
