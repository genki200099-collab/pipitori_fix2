'use strict';

const assert=require('assert');
const crypto=require('crypto');
const fs=require('fs');
const path=require('path');
const vm=require('vm');
const root=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'server.js'),'utf8');
const html=fs.readFileSync(path.join(root,'public','index.html'),'utf8');
class FakeWSS{on(){}}
const FakeWebSocket={Server:FakeWSS,OPEN:1};
const sandbox={console,process:{env:{}},__dirname:root,setTimeout:()=>0,clearTimeout:()=>{},setInterval:()=>0,clearInterval:()=>{},require(name){
  if(name==='http') return {createServer:()=>({listen(){}})};
  if(name==='ws') return FakeWebSocket;
  if(name==='crypto') return crypto;
  if(name==='fs') return fs;
  if(name==='path') return path;
  if(name==='./cpu_personality_dialogue') return require(path.join(root,'cpu_personality_dialogue.js'));
  if(name==='./spotlight_priority') return require(path.join(root,'spotlight_priority.js'));
  throw new Error(`unexpected require ${name}`);
}};
sandbox.globalThis=sandbox;
vm.runInNewContext(`${source}\n;globalThis.__shootApi={normalizeShootThePigLimit,playerCanShootThePig,playerShootLimitReached,applyShootThePigForRound,makeRoundSnapshot,score,createRoom,publicState,rooms};`,sandbox,{filename:'server.js'});
const api=sandbox.__shootApi;
const card=(suit,rank,id=`${suit}-${rank}`)=>({id,suit,rank:String(rank),val:Number(rank),joker:false});
const joker=(id='J')=>({id,faceKey:'JOKER',suit:null,rank:'JOKER',val:0,joker:true});
const player=(name,hand=[])=>({id:name,name,cpu:false,ws:null,hand,scorePile:[],pairs:[],completedRoundCardScoreBank:0,jokerPenaltyBank:0,shootPigPenaltyBank:0,shootPigActivatedRounds:[],out:false});
const room=(limit='unlimited')=>({players:[player('A',[joker(),card('mud',11)]),player('B',[card('apple',2)]),player('C',[card('corn',3)]),player('D',[card('cabbage',4)])],roundDealMode:'reshuffle',penaltyMode:'mud6',madPigEnabled:true,shootThePigEnabled:true,shootThePigLimit:limit,jokerPenalty:20,jokerPenaltyTiming:'perRound',round:1,totalRounds:3,shootPigRoundResults:{},shootPigEvent:null,log:[],commentary:[]});

assert.strictEqual(api.normalizeShootThePigLimit(undefined),'unlimited');
assert.strictEqual(api.normalizeShootThePigLimit('once'),'once');

{
  const r=room();
  const first=api.applyShootThePigForRound(r);
  assert.strictEqual(first.limitMode,'unlimited');
  assert.strictEqual(first.activationCount,1);
  r.round=2;
  const second=api.applyShootThePigForRound(r);
  assert.strictEqual(second.activationCount,2);
  assert.deepStrictEqual([...r.players[0].shootPigActivatedRounds],[1,2]);
  assert.deepStrictEqual(r.players.slice(1).map(p=>p.shootPigPenaltyBank),[20,20,20]);
  assert.strictEqual(api.playerShootLimitReached(r,r.players[0]),false);
}

{
  const r=room('once');
  api.applyShootThePigForRound(r);
  r.round=2;
  assert.strictEqual(api.playerShootLimitReached(r,r.players[0]),true);
  assert.strictEqual(api.playerCanShootThePig(r,r.players[0]),false);
  assert.strictEqual(api.applyShootThePigForRound(r),null);
  const summary=api.makeRoundSnapshot(r,1,'once-limit');
  assert.strictEqual(summary.rows[0].shootPigMadPigWaived,false);
  assert.strictEqual(summary.rows[0].madPigPenalty,13);
  assert.strictEqual(summary.rows[0].jokerPenalty,20);
}

{
  const sent=[];
  const ws={readyState:1,send:x=>sent.push(JSON.parse(x))};
  api.createRoom(ws,'Default');
  const r=[...api.rooms.values()].at(-1);
  const s=api.publicState(r,r.players[0].id);
  assert.strictEqual(r.shootThePigLimit,'unlimited');
  assert.strictEqual(s.shootThePigLimit,'unlimited');
  assert.strictEqual(s.shootThePigPerPlayerLimit,null);
}

assert.match(html,/id="shootThePigLimit"/);
assert.match(html,/<option value="unlimited" selected>無制限<\/option>/);
assert.match(html,/<option value="once">1人1回まで<\/option>/);
assert.match(html,/shootThePigLimit:\$\('shootThePigLimit'\)\.value \|\| 'unlimited'/);
assert.match(html,/シュートON（両方とも手札・無制限）/);
assert.doesNotMatch(html,/シュートON（両方とも手札・各自1回）/);
console.log('shoot limit regression: all assertions passed');
