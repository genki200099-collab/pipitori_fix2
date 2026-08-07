'use strict';

const assert=require('assert');
const crypto=require('crypto');
const fs=require('fs');
const path=require('path');
const vm=require('vm');
const root=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'server.js'),'utf8');

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
vm.runInNewContext(`${source}\n;globalThis.__ruleMatrixApi={
 normalizeRoundCount,normalizeRoundDealMode,normalizePenaltyMode,normalizeMadPigEnabled,
 normalizeJokerPenalty,normalizeJokerPenaltyTiming,normalizeShootThePigEnabled,normalizeShootThePigLimit,
 normalizePickTargetCount,normalizeFeastPointPerCard,normalizePickProviderRole,normalizePassThreeEnabled,normalizeInitialPairDiscardEnabled,
 shootThePigEnabled,shootThePigLimit,shootThePigLabel,rulePenaltyPointLabel,roomOptionSummary,
 playerCanShootThePig,playerShootLimitReached,shouldCheckShootThePigThisRound,applyShootThePigForRound,
 cpuShootPotential,handPenaltyForRoom,madPigPenaltyForRoom,pickCandidateLimit
};`,sandbox,{filename:'server.js'});
const api=sandbox.__ruleMatrixApi;

const card=(suit,rank,id=`${suit}-${rank}-${Math.random()}`)=>({id,faceKey:`${suit}:${rank}`,suit,rank:String(rank),val:Number(rank),joker:false});
const joker=(id='J')=>({id,faceKey:'JOKER',suit:null,rank:'JOKER',val:0,joker:true});
const player=(name,hand=[])=>({id:name,name,cpu:false,ws:null,hand,scorePile:[],pairs:[],completedRoundCardScoreBank:0,jokerPenaltyBank:0,shootPigPenaltyBank:0,shootPigActivatedRounds:[],out:false});
const makeRoom=(overrides={})=>({
 players:[player('A',[joker(),card('mud',11,'M')]),player('B',[card('apple',2,'B2')]),player('C',[card('corn',3,'C3')]),player('D',[card('cabbage',4,'D4')])],
 totalRounds:3,round:1,roundDealMode:'reshuffle',feastPointPerCard:1,pickProviderRole:'winner',penaltyMode:'mud6',madPigEnabled:true,jokerPenalty:20,
 jokerPenaltyTiming:'perRound',shootThePigEnabled:true,shootThePigLimit:'unlimited',pickTargetCount:2,
 passThreeEnabled:false,initialPairDiscardEnabled:false,shootPigRoundResults:{},shootPigEvent:null,log:[],commentary:[],...overrides
});

// Exhaustively verify every selectable enum/boolean combination normalizes and labels consistently.
const rounds=[1,3,6];
const dealModes=['reshuffle','carryOver'];
const penaltyModes=['mud6','flat3','faceValue','mudSuit'];
const madModes=[true,false];
const jokerValues=[0,20,999];
const timings=['perRound','gameEnd'];
const shootModes=[true,false];
const shootLimits=['unlimited','once'];
const pickCounts=[0,1,2,13];
const feastPoints=[0,1,2,5];
const pickProviderRoles=['winner','weakest'];
const toggles=[false,true];
let combinations=0;
for(const totalRounds of rounds) for(const roundDealMode of dealModes) for(const penaltyMode of penaltyModes)
for(const madPigEnabled of madModes) for(const jokerPenalty of jokerValues) for(const jokerPenaltyTiming of timings)
for(const requestedShoot of shootModes) for(const shootThePigLimit of shootLimits) for(const pickTargetCount of pickCounts)
for(const feastPointPerCard of feastPoints) for(const pickProviderRole of pickProviderRoles)
for(const passThreeEnabled of toggles) for(const initialPairDiscardEnabled of toggles){
  const room=makeRoom({totalRounds,roundDealMode,penaltyMode,madPigEnabled,jokerPenalty,jokerPenaltyTiming,
    shootThePigEnabled:madPigEnabled && requestedShoot,shootThePigLimit,pickTargetCount,feastPointPerCard,pickProviderRole,passThreeEnabled,initialPairDiscardEnabled});
  const summary=api.roomOptionSummary(room);
  combinations++;
  assert(!/undefined|NaN|\[object Object\]|-0(?:\D|$)/.test(summary),summary);
  assert(summary.includes(`全${totalRounds}R`));
  assert(summary.includes(roundDealMode==='carryOver'?'カード持ち越し':'毎R全シャッフル'));
  assert(summary.includes(api.rulePenaltyPointLabel(jokerPenalty)));
  assert(summary.includes(`ごちそう:1枚${feastPointPerCard}点`));
  assert(summary.includes(pickProviderRole==='winner'?'勝者から最弱者へ':'最弱者から勝者へ'));
  assert.strictEqual(api.shootThePigEnabled(room),madPigEnabled && requestedShoot);
  assert.strictEqual(api.shootThePigLimit(room),shootThePigLimit);
  if(!madPigEnabled) assert(summary.includes('シュート:不可'));
  else if(!requestedShoot) assert(summary.includes('シュート:なし'));
  else if(jokerPenaltyTiming==='gameEnd') assert(summary.includes('最終Rのみ'));
  else assert(summary.includes(shootThePigLimit==='once'?'1人1回まで':'無制限'));
}
assert.strictEqual(combinations,3*2*4*2*3*2*2*2*4*4*2*2*2);

// Zero-point Joker must never be rendered as negative zero.
assert.strictEqual(api.rulePenaltyPointLabel(0),'0');
assert.strictEqual(api.rulePenaltyPointLabel(20),'-20');
assert(!api.roomOptionSummary(makeRoom({jokerPenalty:0})).includes('-0'));

// Every penalty mode and Mad ON/OFF combination must keep one decomposition.
const expected={
  true:{mud6:[9,13],flat3:[6,13],mudSuit:[4,13],faceValue:[50,0]},
  false:{mud6:[15,0],flat3:[9,0],mudSuit:[7,0],faceValue:[21,0]}
};
for(const madPigEnabled of madModes){
  for(const penaltyMode of penaltyModes){
    const p=player('P',[card('apple',5,'A5'),card('mud',5,'M5'),card('mud',11,'M11')]);
    const room=makeRoom({players:[p],madPigEnabled,penaltyMode,shootThePigEnabled:false});
    const [hand,mad]=expected[String(madPigEnabled)][penaltyMode];
    assert.strictEqual(api.handPenaltyForRoom(room,p),hand,`${madPigEnabled}/${penaltyMode}/hand`);
    assert.strictEqual(api.madPigPenaltyForRoom(room,p),mad,`${madPigEnabled}/${penaltyMode}/mad`);
  }
}

// Shoot timing/limit combinations: -10 exactly once per activation, and waiver only on eligible rounds.
{
  const room=makeRoom({jokerPenaltyTiming:'perRound',shootThePigLimit:'unlimited'});
  const first=api.applyShootThePigForRound(room);
  assert(first && first.shooterPid===0);
  assert.deepStrictEqual(room.players.slice(1).map(p=>p.shootPigPenaltyBank),[10,10,10]);
  room.round=2;
  const second=api.applyShootThePigForRound(room);
  assert(second && second.activationCount===2);
  assert.deepStrictEqual(room.players.slice(1).map(p=>p.shootPigPenaltyBank),[20,20,20]);
}
{
  const room=makeRoom({jokerPenaltyTiming:'perRound',shootThePigLimit:'once'});
  assert(api.applyShootThePigForRound(room));
  room.round=2;
  assert.strictEqual(api.applyShootThePigForRound(room),null);
  assert.deepStrictEqual(room.players.slice(1).map(p=>p.shootPigPenaltyBank),[10,10,10]);
}
{
  const room=makeRoom({jokerPenaltyTiming:'gameEnd',round:1,totalRounds:3,roundDealMode:'reshuffle'});
  assert.strictEqual(api.applyShootThePigForRound(room),null);
  assert.strictEqual(api.cpuShootPotential(room,room.players[0]),false,'reshuffle+gameEnd early CPU must not hoard a combo that will be redealt');
  room.round=3;
  assert(api.applyShootThePigForRound(room));
}
{
  const room=makeRoom({jokerPenaltyTiming:'gameEnd',round:1,totalRounds:3,roundDealMode:'carryOver'});
  assert.strictEqual(api.applyShootThePigForRound(room),null);
  assert.strictEqual(api.cpuShootPotential(room,room.players[0]),true,'carryOver+gameEnd CPU may preserve combo until final round');
}
{
  const room=makeRoom({madPigEnabled:false,shootThePigEnabled:true});
  assert.strictEqual(api.shootThePigEnabled(room),false);
  assert.strictEqual(api.playerCanShootThePig(room,room.players[0]),false);
}

// Pick candidates must clamp to the actual hand size for every selector value.
for(const configured of [0,1,2,13]){
  const p=player('P',[card('apple',1,'1'),card('corn',2,'2'),card('mud',3,'3')]);
  const room=makeRoom({pickTargetCount:configured});
  assert.strictEqual(api.pickCandidateLimit(room,p),configured===0?3:Math.min(configured,3));
}

console.log(JSON.stringify({result:'passed',combinations},null,2));
