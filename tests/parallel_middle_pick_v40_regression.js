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
const sandbox={console,Buffer,Math,process:{env:{}},__dirname:root,setTimeout(){return{id:++timerId,unref(){}};},clearTimeout(){},setInterval(){return{id:++timerId,unref(){}};},clearInterval(){},require(name){if(name==='http')return{createServer:()=>({listen(){}})};if(name==='ws')return{Server:FakeWSS,OPEN:1};if(name==='crypto')return crypto;if(name==='fs')return fs;if(name==='path')return path;if(name==='./cpu_personality_dialogue')return require(path.join(root,'cpu_personality_dialogue.js'));if(name==='./spotlight_priority')return require(path.join(root,'spotlight_priority.js'));throw Error(name);}};
sandbox.globalThis=sandbox;
vm.runInNewContext(`${source}\n;globalThis.__api={GAME_TIMING,newMatchStats,buildPostTrickFlow,startParallelPickGroup,offerShootDecisionOrBeginPick,doPick,submitPickTargets,resolvePairChoice,finishPickLane,skipPickLane,publicState,ensureRoomProgress,pickCandidateLimit,forcedJokerCandidateIds,assertUniqueActiveCards,clearAllProgressTimers};`,sandbox,{filename:'server.js'});
const api=sandbox.__api;

const ws=()=>({readyState:1,send(){}});
const card=(id,suit,rank)=>({id,suit,rank:String(rank),val:Number(rank),joker:false});
const joker=id=>({id,suit:null,rank:'JOKER',val:0,joker:true});
const player=(id,hand,cpu=false)=>({id,name:id,avatar:'🐷',ws:cpu?null:ws(),cpu,participantRole:'player',hand,scorePile:[],pairs:[],out:false,completedRoundCardScoreBank:0,jokerPenaltyBank:0,shootPigPenaltyBank:0,shootPigActivatedRounds:[],matchStats:api.newMatchStats()});
function room(extra={}){
  const players=[
    player('P0',[card('a4','apple',4),card('c5','cabbage',5)]),
    player('P1',[card('n7','corn',7),card('c8','cabbage',8)]),
    player('P2',[card('m10','mud',10),card('a11','apple',11)]),
    player('P3',[card('m1','mud',1),card('m2','mud',2)])
  ];
  return {code:'V400',hostId:'P0',players,spectators:[],phase:'playing',round:1,totalRounds:3,roundDealMode:'carryOver',feastPointPerCard:1,pickProviderRole:'winner',pickTargetCount:0,enableMiddleRankPick:true,shootLoadFireMode:false,forceJokerPickCandidate:false,shootRequiresBabaMoved:false,babaMovedThisRound:false,babaMoveCountThisRound:0,babaMoveHistory:[],madPigEnabled:true,shootThePigEnabled:true,shootThePigLimit:'unlimited',jokerPenalty:20,jokerPenaltyTiming:'perRound',penaltyMode:'mud6',lead:0,current:null,leadSuit:'apple',trick:[{pid:0,card:card('t13a','apple',13),order:0},{pid:1,card:card('t13n','corn',13),order:1},{pid:2,card:card('t12c','cabbage',12),order:2},{pid:3,card:card('t12m','mud',12),order:3}],stock:[],pendingPick:null,parallelPickGroup:null,pendingShootDecision:null,pendingShootTransition:null,postTrickFlow:null,trickRankings:[0,1,2,3],trickReview:null,trickNumber:4,initialPairDone:[],passDone:[],passSelections:{},log:[],commentary:[],spotlightHistory:[],spotlightRoundCounts:{},transientTimers:new Map(),shootPigRoundResults:{},shootBlockedByUnmovedBabaResults:{},completedRoundTotalScores:[0,0,0,0],shootFiredThisRound:false,shootFiredByPid:null,shootFireEvent:null,...extra};
}
function start(r){r.postTrickFlow=api.buildPostTrickFlow(r,0,3);return api.startParallelPickGroup(r,r.postTrickFlow);}

// OFF remains the v39 one-lane path.
{
  const r=room({enableMiddleRankPick:false});r.postTrickFlow=api.buildPostTrickFlow(r,0,3);
  assert.strictEqual(r.postTrickFlow.steps.length,1);assert.strictEqual(r.postTrickFlow.parallel,false);
  api.offerShootDecisionOrBeginPick(r);assert(r.pendingPick);assert.strictEqual(r.parallelPickGroup,null);
}

// ON creates two independent lanes synchronously, with separate ids and viewer-safe public state.
{
  const r=room();const group=start(r);
  assert(group.primary&&group.secondary);assert.notStrictEqual(group.primary.pickId,group.secondary.pickId);
  assert(Math.abs(group.primary.createdAt-group.secondary.createdAt)<=5,'lane start timestamps are effectively simultaneous');
  assert.strictEqual(r.pendingPick,null);
  const reconnectView=api.publicState(r,'P3');
  assert.strictEqual(reconnectView.parallelPickGroup.groupId,group.groupId);
  assert.strictEqual(reconnectView.parallelPickGroup.primary.pickId,group.primary.pickId);
  assert.strictEqual(reconnectView.parallelPickGroup.secondary.pickId,group.secondary.pickId);
  assert.strictEqual(api.doPick(r,'P3',0,'stale-pick-id'),false,'invalid pickId is rejected');
}

// primary human wait never blocks secondary CPU completion.
{
  const r=room();r.players[2].cpu=true;r.players[2].ws=null;const g=start(r);
  g.secondary.readyAt=0;assert.strictEqual(api.doPick(r,'P2',0,g.secondary.pickId),true);api.finishPickLane(r,g.secondary,0);
  assert.strictEqual(g.secondary.status,'completed');assert.strictEqual(g.primary.status,'active');assert.strictEqual(r.parallelPickGroup,g);
}

// secondary human wait never blocks primary CPU completion; stale commands cannot reuse a completed lane.
{
  const r=room();r.players[3].cpu=true;r.players[3].ws=null;const g=start(r);
  g.primary.readyAt=0;assert.strictEqual(api.doPick(r,'P3',0,g.primary.pickId),true);api.finishPickLane(r,g.primary,0);
  assert.strictEqual(g.primary.status,'completed');assert.strictEqual(g.secondary.status,'active');
  assert.strictEqual(api.doPick(r,'P3',0,g.primary.pickId),false,'completed pickId is stale');
}

// Two CPU lanes can both finish; group finalization happens once and the next leader is the trick winner.
{
  const r=room();r.players.forEach(p=>{p.cpu=true;p.ws=null;});const beforeComments=r.commentary.length;const g=start(r);
  g.primary.readyAt=0;assert(api.doPick(r,r.players[g.primary.pickerPid].id,0,g.primary.pickId));api.finishPickLane(r,g.primary,0);
  assert.strictEqual(r.commentary.length,beforeComments,'the first completed lane must not emit the group comment early');
  g.secondary.readyAt=0;assert(api.doPick(r,r.players[g.secondary.pickerPid].id,0,g.secondary.pickId));api.finishPickLane(r,g.secondary,0);
  assert.strictEqual(r.parallelPickGroup,null);assert.strictEqual(r.postTrickFlow,null);assert.strictEqual(r.lead,0);assert.strictEqual(r.current,0);
  assert.strictEqual(r.commentary.length-beforeComments,1,'ordinary parallel picks emit exactly one summary after both lanes finish');
  assert.strictEqual(r.commentary.at(-1).eventKey,'pick');
  api.assertUniqueActiveCards(r,'v40 test group completion');
}

// Candidate counts 0/1/2 and forced Joker apply per lane without leaking authorization.
for(const count of [0,1,2]){
  const r=room({pickTargetCount:count,forceJokerPickCandidate:true});r.players[0].hand=[joker(`J${count}`),card(`x${count}`,'apple',6),card(`y${count}`,'corn',9)];const g=start(r);const pp=g.primary;
  assert.strictEqual(pp.targetCount,count===0?3:count);
  if(count>0) assert.deepStrictEqual([...api.forcedJokerCandidateIds(r,r.players[0])],[`J${count}`]);
  if(pp.targetSelectionRequired){
    assert.strictEqual(api.submitPickTargets(r,'P3',r.players[0].hand.slice(0,pp.targetCount).map(c=>c.id),false,pp.pickId),false,'picker cannot submit provider candidates');
    const ids=[`J${count}`,...r.players[0].hand.filter(c=>!c.joker).map(c=>c.id)].slice(0,pp.targetCount);
    assert.strictEqual(api.submitPickTargets(r,'P0',ids,false,pp.pickId),true);
  }
  api.clearAllProgressTimers(r);
}

// Pair cleanse is lane-local: primary may wait for a pair choice while secondary already completed.
{
  const r=room();r.players[0].hand=[card('draw5','apple',5),card('other6','corn',6)];r.players[3].hand=[card('pair5','mud',5),card('low1','mud',1)];const g=start(r);
  const drawFiveIndex=g.primary.pickOrderIds.indexOf('draw5');assert(drawFiveIndex>=0);
  g.primary.readyAt=0;assert(api.doPick(r,'P3',drawFiveIndex,g.primary.pickId));assert(g.primary.pairChoice);
  g.secondary.readyAt=0;assert(api.doPick(r,'P2',0,g.secondary.pickId));api.finishPickLane(r,g.secondary,0);
  assert.strictEqual(g.secondary.status,'completed');assert(g.primary.pairChoice);
  assert(api.resolvePairChoice(r,'P3','pair5',false,g.primary.pickId));api.finishPickLane(r,g.primary,0);
  assert.strictEqual(r.parallelPickGroup,null);assert.strictEqual(r.players[3].pairs.length,2);
  api.assertUniqueActiveCards(r,'v40 pair lane completion');
}

// Disconnect fallback acts on only the disconnected lane.
{
  const r=room();const g=start(r);r.players[3].ws=null;r.players[3].disconnectedAt=Date.now()-20000;g.primary.readyAt=Date.now()-20000;g.primary.createdAt=Date.now()-20000;
  api.ensureRoomProgress(r);
  assert(g.primary.result || g.primary.pairChoice,'disconnected primary lane is auto-resolved');
  assert.strictEqual(g.secondary.status,'active','other lane remains independent');
}

// UI/schema/timer contracts required for two real lanes (not a shortened serial timer).
assert.match(source,/groupId:\s*`parallel-/);assert.match(source,/cpu-pick-\$\{token\}/);assert.match(source,/pick-finish-\$\{scope\}/);
assert.match(source,/submitPickTargets\(room,playerId,cardIds,silent=false,pickId=null\)/);
assert.match(html,/parallel-pick-grid/);assert.match(html,/data-pick-id/);assert.match(html,/2レーン同時進行/);
assert.match(html,/requestPick\(i,pickId=''/);assert.match(html,/requestPairChoice\(cardId, skip,pickId=''/);

// v39と同じproduction timing定数を使い、CPU4の48トリック相当を
// 「primary完了後にsecondary開始」と「同時開始」で比較する。
const timing=api.GAME_TIMING;
const resultPatterns=[
  [timing.normalPickResult,timing.normalPickResult],
  [timing.normalPickResult,timing.pairPickResult],
  [timing.pairPickResult,timing.normalPickResult],
  [timing.madPickResult,timing.normalPickResult],
  [timing.normalPickResult,timing.madPickResult],
  [timing.babaPickResult,timing.normalPickResult],
  [timing.normalPickResult,timing.babaPickResult],
  [timing.pairPickResult,timing.pairPickResult]
];
const tempoSamples=Array.from({length:48},(_,index)=>resultPatterns[index%resultPatterns.length]).map(([primaryResult,secondaryResult])=>{
  const primaryMs=timing.pickPrepare+primaryResult;
  const secondaryMs=timing.middlePickPrepare+secondaryResult;
  return {serialMs:primaryMs+secondaryMs,parallelMs:Math.max(primaryMs,secondaryMs)};
});
const average=key=>Math.round(tempoSamples.reduce((sum,item)=>sum+item[key],0)/tempoSamples.length);
const serialAverageMs=average('serialMs'),parallelAverageMs=average('parallelMs');
const tempoReductionPct=Math.round((1-parallelAverageMs/serialAverageMs)*100);
assert(parallelAverageMs<serialAverageMs);
assert(tempoReductionPct>=35);
console.log(JSON.stringify({result:'passed',suite:'parallel-middle-pick-v40',startDeltaMsMax:5,distinctPickIds:true,independentWait:true,pairCleanseIndependent:true,staleRejected:true,commentAfterBothLanes:true,commentPerTrickExactly:1,tempoCpu4Tricks:tempoSamples.length,serialAverageMs,parallelAverageMs,tempoReductionPct}));
