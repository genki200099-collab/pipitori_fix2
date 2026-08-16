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
let timerId=0;
const fakeMath=Object.create(Math);
fakeMath.random=()=>0.75;
const sandbox={
  console,Buffer,Math:fakeMath,process:{env:{}},__dirname:root,
  setTimeout(){return{id:++timerId,unref(){}};},clearTimeout(){},
  setInterval(){return{id:++timerId,unref(){}};},clearInterval(){},
  require(name){
    if(name==='http')return{createServer:()=>({listen(){}})};
    if(name==='ws')return{Server:FakeWSS,OPEN:1};
    if(name==='crypto')return crypto;
    if(name==='fs')return fs;
    if(name==='path')return path;
    if(name==='./cpu_personality_dialogue')return require(path.join(root,'cpu_personality_dialogue.js'));
    if(name==='./spotlight_priority')return require(path.join(root,'spotlight_priority.js'));
    throw new Error(`unexpected require ${name}`);
  }
};
sandbox.globalThis=sandbox;
vm.runInNewContext(`${source}\n;globalThis.__v38Api={
  rooms,createRoom,publicState,newMatchStats,matchStatsFor,generatePlayEvaluation,
  normalizeForceJokerPickCandidate,normalizeShootRequiresBabaMoved,
  forcedJokerCandidateIds,mergeMandatoryPickTargetIds,forcedJokerRuleChangesCandidates,
  chooseCpuPickTargetIds,chooseCpuPickIndex,disconnectedPickTargetFallbackIds,
  cpuShootPotential,cpuNearShootPotential,cpuStrategyLineFor,
  resolvedPickRoles,advanceReviewToPick,submitPickTargets,doPick,finishAfterPick,
  shootEligibilityState,playerCanShootThePig,applyShootThePigForRound,
  initializeMatch,beginNextRound
};`,sandbox,{filename:'server.js'});
const api=sandbox.__v38Api;

const normal=(id,rank=5,suit='apple')=>({id,faceKey:`${suit}:${rank}`,suit,rank:String(rank),val:Number(rank),joker:false});
const joker=(id='J')=>({id,faceKey:'JOKER',suit:null,rank:'JOKER',val:0,joker:true});
const participant=(id,hand=[],cpu=false)=>({
  id,name:id,avatar:'🐷',cpu,ws:null,hand,scorePile:[],pairs:[],out:false,
  completedRoundCardScoreBank:0,jokerPenaltyBank:0,shootPigPenaltyBank:0,
  shootPigActivatedRounds:[],matchStats:api.newMatchStats()
});
function baseRoom(extra={}){
  const players=[
    participant('A',[joker('J'),normal('A1',4),normal('A2',7)]),
    participant('B',[normal('B1',3),normal('B2',8)]),
    participant('C',[normal('C1',2),normal('C2',9)]),
    participant('D',[normal('D1',1),normal('D2',10)])
  ];
  return {
    code:'V380',hostId:'A',players,spectators:[],phase:'playing',round:1,totalRounds:3,
    roundDealMode:'carryOver',feastPointPerCard:1,pickProviderRole:'winner',pickTargetCount:2,
    forceJokerPickCandidate:false,shootRequiresBabaMoved:false,babaMovedThisRound:false,babaMoveCountThisRound:0,babaMoveHistory:[],
    madPigEnabled:true,shootThePigEnabled:true,shootThePigLimit:'unlimited',jokerPenalty:20,jokerPenaltyTiming:'perRound',penaltyMode:'mud6',
    lead:0,current:null,leadSuit:null,trick:[],stock:[],pendingPick:null,trickReview:null,
    initialPairDone:[],passDone:[],passSelections:{},log:[],commentary:[],spotlightHistory:[],spotlightRoundCounts:{},transientTimers:new Map(),
    shootPigRoundResults:{},shootBlockedByUnmovedBabaResults:{},
    ...extra
  };
}
function setPending(room,{providerPid=0,pickerPid=1,candidates=['J'],forced=false}={}){
  room.pendingPick={
    winnerPid:0,weakestPid:1,trickWinnerPid:0,trickWeakestPid:1,
    pickProviderPid:providerPid,pickerPid,readyAt:0,targetCount:candidates.length,
    targetSelectionRequired:false,targetSelectionDone:true,targetCandidateIds:candidates.slice(),
    pickOrderIds:candidates.slice(),mandatoryCandidateIds:forced?['J']:[],forcedJokerCandidate:forced,
    token:`pick-${providerPid}-${pickerPid}-${candidates.join('-')}`
  };
}

assert.strictEqual(api.normalizeForceJokerPickCandidate(undefined),false);
assert.strictEqual(api.normalizeShootRequiresBabaMoved(undefined),false);
assert.strictEqual(api.normalizeForceJokerPickCandidate(true),true);
assert.strictEqual(api.normalizeShootRequiresBabaMoved('true'),true);

// Rule A: every candidate-count boundary and the OFF compatibility path.
{
  const r=baseRoom();
  assert.deepStrictEqual([...api.forcedJokerCandidateIds(r,r.players[0])],[],'OFF keeps v37 candidates');
  r.forceJokerPickCandidate=true;
  r.pickTargetCount=0;
  assert.deepStrictEqual([...api.forcedJokerCandidateIds(r,r.players[0])],[],'unrestricted already includes all cards');
  r.pickTargetCount=1;
  assert.deepStrictEqual([...api.forcedJokerCandidateIds(r,r.players[0])],['J']);
  assert.deepStrictEqual([...api.mergeMandatoryPickTargetIds(r,r.players[0],['A1'],1)],['J']);
  r.pickTargetCount=2;
  assert.deepStrictEqual([...api.mergeMandatoryPickTargetIds(r,r.players[0],['A1','A2'],2)],['J','A1']);
  r.pickTargetCount=13;
  const all=api.mergeMandatoryPickTargetIds(r,r.players[0],r.players[0].hand.map(c=>c.id),13);
  assert.strictEqual(all.length,3,'provider hand shorter than requested count uses all live cards');
  assert.strictEqual(new Set(all).size,all.length);
  r.players[0].hand=r.players[0].hand.filter(c=>!c.joker);
  assert.deepStrictEqual([...api.forcedJokerCandidateIds(r,r.players[0])],[],'provider without Baba uses v37 path');
}

// Server rejects a human candidate list that omits the mandatory Baba.
{
  const r=baseRoom({forceJokerPickCandidate:true});
  setPending(r,{candidates:[],forced:true});
  Object.assign(r.pendingPick,{targetCount:2,targetSelectionRequired:true,targetSelectionDone:false,targetCandidateIds:[],pickOrderIds:[]});
  assert.strictEqual(api.submitPickTargets(r,'A',['A1','A2'],true),false);
  assert.strictEqual(r.pendingPick.targetSelectionDone,false);
  assert.match(r.message,/必須候補/);
  assert.strictEqual(api.submitPickTargets(r,'A',['J','A1'],true),true);
  assert.strictEqual(r.pendingPick.targetSelectionDone,true);
}

// One-candidate forced Baba is server-confirmed without asking the provider to click.
{
  const r=baseRoom({forceJokerPickCandidate:true,pickTargetCount:1});
  r.trickReview={winnerPid:0,weakestPid:1,until:123};
  api.advanceReviewToPick(r,123,0,1);
  assert.strictEqual(r.pendingPick.targetSelectionRequired,false);
  assert.strictEqual(r.pendingPick.targetSelectionDone,true);
  assert.deepStrictEqual([...r.pendingPick.targetCandidateIds],['J']);
  assert.strictEqual(r.pendingPick.forcedJokerCandidate,true);
  assert.match(r.message,/自動/);
}

// CPU and disconnected fallback must obey the mandatory slot; picker selects only a random position.
{
  const r=baseRoom({forceJokerPickCandidate:true,pickTargetCount:2});
  r.players[0].cpu=true;
  const cpuIds=api.chooseCpuPickTargetIds(r,0,2);
  assert(cpuIds.includes('J'));
  setPending(r,{candidates:[],forced:true});
  Object.assign(r.pendingPick,{targetCount:2,targetSelectionRequired:true,targetSelectionDone:false});
  const fallback=api.disconnectedPickTargetFallbackIds(r,r.pendingPick);
  assert(fallback.includes('J'));
  const idx1=api.chooseCpuPickIndex(r,r.pendingPick,[joker('hidden-a'),normal('safe-a')]);
  const idx2=api.chooseCpuPickIndex(r,r.pendingPick,[normal('safe-b'),joker('hidden-b')]);
  assert.strictEqual(idx1,idx2,'CPU random position does not depend on hidden card identity');
  assert.strictEqual(idx1,1);
}

// Candidate inclusion alone never marks movement. Only an actual provider -> picker Baba transfer does.
{
  const r=baseRoom({forceJokerPickCandidate:true,shootRequiresBabaMoved:true,pickTargetCount:2});
  setPending(r,{candidates:['J','A1'],forced:true});
  assert.strictEqual(r.babaMovedThisRound,false);
  api.doPick(r,'B',1); // draw A1, not Baba
  assert.strictEqual(r.babaMovedThisRound,false);
  assert.strictEqual(r.babaMoveCountThisRound,0);
  assert.strictEqual(r.players[0].matchStats.babaForcedTransferCount,0);

  // The unpicked unique Baba remains with the provider for the next real transfer.
  setPending(r,{candidates:['J'],forced:true});
  api.doPick(r,'B',0);
  assert.strictEqual(r.babaMovedThisRound,true);
  assert.strictEqual(r.babaMoveCountThisRound,1);
  assert.strictEqual(r.players[0].matchStats.babaForcedTransferCount,1);

  // Move the same unique Baba a second time in the opposite direction.
  setPending(r,{providerPid:1,pickerPid:0,candidates:['J'],forced:true});
  api.doPick(r,'A',0);
  assert.strictEqual(r.babaMoveCountThisRound,2);
  assert.strictEqual(r.players[0].hand.filter(c=>c.joker).length,1);
  assert.strictEqual(r.players.flatMap(p=>p.hand).filter(c=>c.joker).length,1);
}

// Winner/weakest role derivation remains independent from the new candidate rule.
{
  assert.deepStrictEqual({...api.resolvedPickRoles({pickProviderRole:'winner'},0,1)},{trickWinnerPid:0,trickWeakestPid:1,pickProviderPid:0,pickerPid:1});
  assert.deepStrictEqual({...api.resolvedPickRoles({pickProviderRole:'weakest'},0,1)},{trickWinnerPid:0,trickWeakestPid:1,pickProviderPid:1,pickerPid:0});
}

// Rule B: OFF is v37-compatible; ON blocks only the missing-movement case.
{
  const mad=normal('M',11,'mud');
  const off=baseRoom();
  off.players[0].hand=[joker('JO'),mad];
  assert.strictEqual(api.playerCanShootThePig(off,off.players[0]),true);
  assert.strictEqual(api.applyShootThePigForRound(off).shooterPid,0);

  const blocked=baseRoom({shootRequiresBabaMoved:true});
  blocked.players[0].hand=[joker('JB'),normal('MB',11,'mud')];
  assert.strictEqual(api.playerCanShootThePig(blocked,blocked.players[0]),false);
  assert.strictEqual(api.applyShootThePigForRound(blocked),null);
  assert.strictEqual(blocked.shootBlockedByUnmovedBabaResults['1'].pid,0);
  assert.strictEqual(blocked.players[0].matchStats.shootBlockedByUnmovedBabaCount,1);

  const moved=baseRoom({shootRequiresBabaMoved:true,babaMovedThisRound:true,babaMoveCountThisRound:1});
  moved.players[0].hand=[joker('JM'),normal('MM',11,'mud')];
  assert.strictEqual(api.playerCanShootThePig(moved,moved.players[0]),true);
  assert.strictEqual(api.applyShootThePigForRound(moved).shooterPid,0);
}

// All three CPU personalities distinguish an unfinished movement requirement from a ready shoot.
{
  for(const key of ['kamomodoki','wakumodoki','rikumodoki']){
    const r=baseRoom({forceJokerPickCandidate:true,shootRequiresBabaMoved:true,pickTargetCount:2});
    const cpu=r.players[0];cpu.cpu=true;cpu.name={kamomodoki:'かももどき',wakumodoki:'ワクもどき',rikumodoki:'リクもどき'}[key];cpu.hand=[joker(`J-${key}`),normal(`M-${key}`,11,'mud'),normal(`N-${key}`,6)];
    assert.strictEqual(api.cpuShootPotential(r,cpu),false,`${key} must not treat unmoved Baba as completed shoot`);
    assert.strictEqual(api.cpuNearShootPotential(r,cpu),true);
    const line=api.cpuStrategyLineFor(r,0,'shootNeedsBabaMove',{});
    assert.match(line,/移動|動か|未完成/);
    const ids=api.chooseCpuPickTargetIds(r,0,2);
    assert(ids.includes(`J-${key}`),`${key} must obey mandatory Baba candidate`);
    r.babaMovedThisRound=true;
    assert.strictEqual(api.cpuShootPotential(r,cpu),true,`${key} may preserve a completed shoot`);
  }
}

// OFF/ON dependencies, gameEnd final-round scope, once/unlimited, and Mad in pile only.
{
  for(const limit of ['unlimited','once']){
    const r=baseRoom({shootRequiresBabaMoved:true,babaMovedThisRound:true,shootThePigLimit:limit});
    r.players[0].hand=[joker(`J-${limit}`),normal(`M-${limit}`,11,'mud')];
    assert.strictEqual(api.playerCanShootThePig(r,r.players[0]),true);
  }
  const noShoot=baseRoom({shootRequiresBabaMoved:true,babaMovedThisRound:true,shootThePigEnabled:false});
  noShoot.players[0].hand=[joker('JNS'),normal('MNS',11,'mud')];
  assert.strictEqual(api.playerCanShootThePig(noShoot,noShoot.players[0]),false);
  const noMadRule=baseRoom({shootRequiresBabaMoved:true,babaMovedThisRound:true,madPigEnabled:false});
  noMadRule.players[0].hand=[joker('JNM'),normal('MNM',11,'mud')];
  assert.strictEqual(api.playerCanShootThePig(noMadRule,noMadRule.players[0]),false);
  const pileMad=baseRoom({shootRequiresBabaMoved:true,babaMovedThisRound:true});
  pileMad.players[0].hand=[joker('JP')];pileMad.players[0].scorePile=[normal('MP',11,'mud')];
  assert.strictEqual(api.playerCanShootThePig(pileMad,pileMad.players[0]),false);
  const early=baseRoom({shootRequiresBabaMoved:true,babaMovedThisRound:true,jokerPenaltyTiming:'gameEnd',round:2,totalRounds:3});
  early.players[0].hand=[joker('JE'),normal('ME',11,'mud')];
  assert.strictEqual(api.applyShootThePigForRound(early),null,'gameEnd checks only the final round');
  early.round=3;early.babaMovedThisRound=false;
  assert.strictEqual(api.applyShootThePigForRound(early),null);
  assert.strictEqual(early.shootBlockedByUnmovedBabaResults['3'].pid,0,'past-round movement is not carried into final round');
}

// Both rules ON: a forced real transfer unlocks the movement condition for the same round.
{
  const r=baseRoom({forceJokerPickCandidate:true,shootRequiresBabaMoved:true,pickTargetCount:1});
  r.players[1].hand.push(normal('MAD-B',11,'mud'));
  setPending(r,{candidates:['J'],forced:true});
  api.doPick(r,'B',0);
  assert.strictEqual(r.babaMovedThisRound,true);
  assert.strictEqual(api.shootEligibilityState(r,r.players[1]).eligibleNow,true);
  assert.strictEqual(api.applyShootThePigForRound(r).shooterPid,1);
}

// New match and next round always reset movement, including carry-over.
{
  const r=baseRoom({babaMovedThisRound:true,babaMoveCountThisRound:3});
  r.phase='finished';
  api.initializeMatch(r,{rematch:true});
  assert.strictEqual(r.babaMovedThisRound,false);
  assert.strictEqual(r.babaMoveCountThisRound,0);

  const next=baseRoom({phase:'roundEnd',round:1,totalRounds:2,babaMovedThisRound:true,babaMoveCountThisRound:2,roundEndOutPid:0,roundEndSummary:{rows:[]}});
  api.beginNextRound(next);
  assert.strictEqual(next.babaMovedThisRound,false);
  assert.strictEqual(next.babaMoveCountThisRound,0);
}

// Public state exposes rule/movement state without leaking another player's hand.
{
  const r=baseRoom({forceJokerPickCandidate:true,shootRequiresBabaMoved:true,babaMovedThisRound:true,babaMoveCountThisRound:2});
  const view=api.publicState(r,'A');
  assert.strictEqual(view.forceJokerPickCandidate,true);
  assert.strictEqual(view.shootRequiresBabaMoved,true);
  assert.strictEqual(view.babaMovedThisRound,true);
  assert.strictEqual(view.babaMoveCountThisRound,2);
  assert.strictEqual(view.players[1].hand,null);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(view,'babaHolderPid'),false);
}

// Defaults, presets, help, UI affordances and create payload stay aligned.
{
  const sent=[];const ws={readyState:1,send:raw=>sent.push(JSON.parse(raw))};
  api.createRoom(ws,'Default-v38');
  const r=[...api.rooms.values()].at(-1);
  assert.strictEqual(r.forceJokerPickCandidate,false);
  assert.strictEqual(r.shootRequiresBabaMoved,false);
  assert.match(html,/id="forceJokerPickCandidate"/);
  assert.match(html,/id="shootRequiresBabaMoved"/);
  assert.match(html,/そのラウンド中のババ実移動が必要/);
  assert.match(html,/ババブタ＋マッドに加え、そのラウンド中のババ実移動が必要/);
  assert.match(html,/forceJokerPickCandidate:\$\('forceJokerPickCandidate'\)\.value==='true'/);
  assert.match(html,/shootRequiresBabaMoved:\$\('shootLoadFireMode'\)\.value!=='true' && \$\('shootRequiresBabaMoved'\)\.value==='true'/);
  assert.strictEqual((html.match(/forceJokerPickCandidate:'false'/g)||[]).length,4);
  assert.strictEqual((html.match(/shootRequiresBabaMoved:'false'/g)||[]).length,4);
  assert.match(html,/mandatory-pick-badge/);
  assert.match(html,/ババブタがこのラウンド中に一度も移動/);

  api.rooms.clear();
  const invalidWs={readyState:1,send() {}};
  api.createRoom(invalidWs,'Invalid dependency',3,false,-20,false,false,'mud6',2,'perRound',true,'reshuffle','unlimited',1,'winner','player',false,true);
  const normalized=[...api.rooms.values()].at(-1);
  assert.strictEqual(normalized.shootThePigEnabled,false);
  assert.strictEqual(normalized.shootRequiresBabaMoved,false,'Mad/Shoot OFF normalizes the dependent movement option to OFF');
}

// Forced behavior is described factually, not praised as a voluntary tactic.
{
  const p=participant('CPU',[]);p.cpu=true;p.cpuKey='kamomodoki';
  p.matchStats.babaTransferred=1;p.matchStats.babaForcedCandidateCount=1;p.matchStats.babaForcedTransferCount=1;
  const comments=api.generatePlayEvaluation(baseRoom(),p);
  assert(comments.some(line=>line.includes('強制候補ルール')));
  assert(!comments.some(line=>line.includes('巧み') || line.includes('攻撃的なピック')));
}

console.log(JSON.stringify({result:'passed',suite:'baba-movement-rules-v38',ruleStates:4,assertions:'A/B/CPU/public-state/UI/evaluation'},null,2));
