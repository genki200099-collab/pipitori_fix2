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
const fakeMath=Object.create(Math);let randomSeq=0;fakeMath.random=()=>((++randomSeq*0.173)%0.96)+0.02;
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
vm.runInNewContext(`${source}\n;globalThis.__v39Api={
  rooms,createRoom,newMatchStats,matchStatsFor,publicState,gameSeatCount,canHostAddCpu,addCpu,removeCpu,
  normalizeEnableMiddleRankPick,normalizeShootLoadFireMode,rankTrickPlayers,buildPostTrickFlow,beginPickStep,
  offerShootDecisionOrBeginPick,startParallelPickGroup,finishPickLane,resolveShootDecision,finishShootPresentation,doPick,finishAfterPick,
  playerIsShootLoaded,refreshShootLoadStates,cpuShouldFireShoot,recordRoundStats,initializeMatch,beginNextRound,
  makeRoundSnapshot,clearAllProgressTimers
};`,sandbox,{filename:'server.js'});
const api=sandbox.__v39Api;

const ws=()=>({readyState:1,sent:[],send(raw){this.sent.push(JSON.parse(raw));}});
const normal=(id,rank=5,suit='apple')=>({id,faceKey:`${suit}:${rank}:${id}`,suit,rank:String(rank),val:Number(rank),joker:false});
const joker=(id='J')=>({id,faceKey:'JOKER',suit:null,rank:'JOKER',val:0,joker:true});
const mad=id=>normal(id,11,'mud');
const participant=(id,hand=[],cpu=false,key=null)=>({
  id,name:id,avatar:'🐷',cpu,cpuCharacter:key?{key,name:id}:null,ws:cpu?null:ws(),participantRole:'player',
  hand,scorePile:[],pairs:[],out:false,completedRoundCardScoreBank:0,jokerPenaltyBank:0,
  shootPigPenaltyBank:0,shootPigActivatedRounds:[],matchStats:api.newMatchStats()
});
function baseRoom(extra={}){
  const players=[
    participant('A',[normal('A1',4),normal('A2',7),normal('A3',12)]),
    participant('B',[normal('B1',3),normal('B2',8),normal('B3',10)]),
    participant('C',[normal('C1',2),normal('C2',9),normal('C3',13)]),
    participant('D',[normal('D1',1),normal('D2',6),normal('D3',11)])
  ];
  return {
    code:'V390',hostId:'A',players,spectators:[],phase:'playing',round:1,totalRounds:3,
    roundDealMode:'carryOver',feastPointPerCard:1,pickProviderRole:'winner',pickTargetCount:0,
    enableMiddleRankPick:false,shootLoadFireMode:false,forceJokerPickCandidate:false,shootRequiresBabaMoved:false,
    babaMovedThisRound:false,babaMoveCountThisRound:0,babaMoveHistory:[],madPigEnabled:true,
    shootThePigEnabled:true,shootThePigLimit:'unlimited',jokerPenalty:20,jokerPenaltyTiming:'perRound',penaltyMode:'mud6',
    lead:0,current:null,leadSuit:null,trick:[],stock:[],pendingPick:null,pendingShootDecision:null,
    pendingShootTransition:null,postTrickFlow:null,trickRankings:[0,1,2,3],trickReview:null,trickNumber:1,
    initialPairDone:[],passDone:[],passSelections:{},log:[],commentary:[],spotlightHistory:[],spotlightRoundCounts:{},
    transientTimers:new Map(),shootPigRoundResults:{},shootBlockedByUnmovedBabaResults:{},
    completedRoundTotalScores:[0,0,0,0],shootFiredThisRound:false,shootFiredByPid:null,shootFireEvent:null,
    ...extra
  };
}

assert.strictEqual(api.normalizeEnableMiddleRankPick(undefined),false);
assert.strictEqual(api.normalizeShootLoadFireMode(undefined),false);
assert.strictEqual(api.normalizeEnableMiddleRankPick('true'),true);
assert.strictEqual(api.normalizeShootLoadFireMode(true),true);

// A single ranking fixes all four places. Its ends preserve the v38 winner and weakest tie policy.
{
  const r=baseRoom();
  const entries=[
    {pid:0,order:0,card:normal('T0',10,'apple')},
    {pid:1,order:1,card:normal('T1',8,'apple')},
    {pid:2,order:2,card:normal('T2',5,'corn')},
    {pid:3,order:3,card:normal('T3',5,'mud')}
  ];
  const ranks=api.rankTrickPlayers(r,'apple',entries);
  assert.deepStrictEqual([...ranks.map(x=>x.pid)],[0,1,2,3]);
  assert.strictEqual(ranks[0].pid,0,'rank[0] is the existing lead-suit winner');
  assert.strictEqual(ranks[3].pid,3,'later equal off-suit card is weakest');
}

// OFF has one pick. v40 changes ON to two simultaneous lanes; both must finish before next-leader work.
{
  const off=baseRoom();off.postTrickFlow=api.buildPostTrickFlow(off,0,3);
  assert.strictEqual(off.postTrickFlow.steps.length,1);

  const r=baseRoom({enableMiddleRankPick:true});
  r.postTrickFlow=api.buildPostTrickFlow(r,0,3);
  assert.deepStrictEqual([...r.postTrickFlow.rankings],[0,1,2,3]);
  assert.strictEqual(r.postTrickFlow.steps.length,2);
  api.startParallelPickGroup(r,r.postTrickFlow);
  assert.strictEqual(r.pendingPick,null);
  assert.ok(r.parallelPickGroup);
  const primary=r.parallelPickGroup.primary,secondary=r.parallelPickGroup.secondary;
  assert.notStrictEqual(primary.pickId,secondary.pickId);
  assert.strictEqual(primary.pickProviderPid,0);assert.strictEqual(primary.pickerPid,3);
  assert.strictEqual(secondary.pickProviderPid,1);assert.strictEqual(secondary.pickerPid,2);
  assert.strictEqual(r.players[1].matchStats.middlePickProviderCount,1);
  assert.strictEqual(r.players[2].matchStats.middlePickerCount,1);
  primary.readyAt=0;api.doPick(r,'D',0,primary.pickId);api.finishPickLane(r,primary,0);
  assert.ok(r.parallelPickGroup,'secondary remains active after primary completion');
  secondary.readyAt=0;api.doPick(r,'C',0,secondary.pickId);
  assert.strictEqual(r.players[1].matchStats.middlePickTransferredCards,1);
  assert.strictEqual(r.players[2].matchStats.middlePickReceivedCards,1);
  api.finishPickLane(r,secondary,0);
  assert.strictEqual(r.pendingPick,null);assert.strictEqual(r.parallelPickGroup,null);assert.strictEqual(r.postTrickFlow,null);
  assert.strictEqual(r.lead,0);assert.strictEqual(r.current,0,'next leader remains trick winner');
}

// Mandatory Baba candidate applies to the secondary pick too.
{
  const r=baseRoom({enableMiddleRankPick:true,forceJokerPickCandidate:true,pickTargetCount:1});
  r.players[1].hand=[joker('MID-J'),normal('MID-X',4)];
  r.postTrickFlow=api.buildPostTrickFlow(r,0,3);r.postTrickFlow.index=1;
  api.beginPickStep(r,r.postTrickFlow.steps[1]);
  assert.strictEqual(r.pendingPick.pickStage,'secondary');
  assert.deepStrictEqual([...r.pendingPick.targetCandidateIds],['MID-J']);
  assert.strictEqual(r.pendingPick.forcedJokerCandidate,true);
}

// Load is hand-only and private; spectators may inspect it because their mode already exposes all hands.
{
  const r=baseRoom({enableMiddleRankPick:true,shootLoadFireMode:true,shootRequiresBabaMoved:true});
  r.players[0].hand=[joker('FIRE-J'),mad('FIRE-M'),normal('FIRE-X',12)];
  r.players[1].scorePile=[mad('PILE-M')];
  r.spectators=[{id:'S',name:'Watcher',avatar:'👁',participantRole:'spectator',ws:ws()}];
  api.refreshShootLoadStates(r);
  assert.strictEqual(api.playerIsShootLoaded(r,r.players[0]),true);
  assert.strictEqual(api.playerIsShootLoaded(r,r.players[1]),false,'Mad in feast pile never loads');
  const ownerView=api.publicState(r,'A'),otherView=api.publicState(r,'B'),spectatorView=api.publicState(r,'S');
  assert.strictEqual(ownerView.shootLoadState.loaded,true);assert(ownerView.shootLoadState.event);
  assert.strictEqual(otherView.shootLoadState.loaded,false);assert.strictEqual(otherView.spectatorShootLoadStates,null);
  assert.strictEqual(otherView.pendingShootDecision,null);
  assert.strictEqual(spectatorView.spectatorShootLoadStates[0].loaded,true);
  assert(!r.log.some(line=>String(line).includes('装填条件')),'private load never enters shared log');

  r.postTrickFlow=api.buildPostTrickFlow(r,0,3);
  api.offerShootDecisionOrBeginPick(r);
  assert(r.pendingShootDecision);const choiceId=r.pendingShootDecision.id;
  assert.strictEqual(api.publicState(r,'B').pendingShootDecision,null,'choice is private from other players');
  assert.strictEqual(api.publicState(r,'S').pendingShootDecision.shooterPid,0);
  assert.strictEqual(r.players[0].matchStats.shootFireOpportunityCount,1);
  const targetBefore=r.players[3].hand.length;
  assert.strictEqual(api.resolveShootDecision(r,'A',true),true);
  assert.strictEqual(r.players[0].hand.some(c=>c.joker),false);
  assert.strictEqual(r.players[0].hand.some(c=>c.id==='FIRE-M'),true,'Mad remains with shooter');
  assert.strictEqual(r.players[3].hand.length,targetBefore+1);
  assert.strictEqual(r.players[3].hand.some(c=>c.id==='FIRE-J'),true,'Baba moves directly to weakest');
  assert.strictEqual(r.shootFiredThisRound,true);assert.strictEqual(r.shootFiredByPid,0);
  assert(r.shootFireEvent.id.startsWith('shoot-fire-'));
  assert.strictEqual(r.shootFireEvent.babaCardId,'FIRE-J');assert.strictEqual(r.shootFireEvent.madCardId,'FIRE-M');
  assert.strictEqual(r.players[0].matchStats.shootFiredCount,1);
  assert.strictEqual(r.players[3].matchStats.shootReceivedBabaCount,1);
  assert.deepStrictEqual([...r.players.map(player=>player.shootPigPenaltyBank)],[0,10,10,10]);
  const scoreOnce=api.makeRoundSnapshot(r,0,'fire score').rows.map(row=>row.total);
  const scoreAgain=api.makeRoundSnapshot(r,0,'fire score repeat').rows.map(row=>row.total);
  assert.deepStrictEqual([...scoreAgain],[...scoreOnce],'snapshot resend cannot apply shoot score twice');
  assert.deepStrictEqual([...r.players.map(player=>player.shootPigPenaltyBank)],[0,10,10,10]);
  const eventId=r.shootFireEvent.id;
  assert.strictEqual(api.resolveShootDecision(r,'A',true),false,'same choice cannot fire twice');
  assert.strictEqual(r.shootFireEvent.id,eventId);assert.strictEqual(r.players[0].matchStats.shootFiredCount,1);
  api.finishShootPresentation(r,choiceId);
  assert.strictEqual(r.parallelPickGroup.primary.status,'completed','shoot completes only primary lane');
  assert.strictEqual(r.parallelPickGroup.secondary.pickStage,'secondary','secondary has been active throughout the shoot');
  assert.strictEqual(r.parallelPickGroup.secondary.pickProviderPid,1);assert.strictEqual(r.parallelPickGroup.secondary.pickerPid,2);
  r.shootThePigLimit='once';r.shootFiredThisRound=false;r.round=2;r.players[0].hand.push(joker('FIRE-J2'));
  assert.strictEqual(api.playerIsShootLoaded(r,r.players[0]),false,'per-player once limit persists across rounds');
}

// The table-wide one-shot guard and its public event reset at the next round only.
{
  const r=baseRoom({phase:'roundEnd',round:1,totalRounds:2,shootLoadFireMode:true,shootFiredThisRound:true,shootFiredByPid:0,shootFireEvent:{id:'old-fire'},roundEndOutPid:0,roundEndSummary:{rows:[]}});
  r.players[0].shootLoadedNow=true;r.players[0].shootLoadEvent={id:'old-load'};
  api.beginNextRound(r);
  assert.strictEqual(r.round,2);assert.strictEqual(r.shootFiredThisRound,false);assert.strictEqual(r.shootFiredByPid,null);
  assert.strictEqual(r.shootFireEvent,null);assert(r.players.every(player=>player.shootLoadedNow===false&&player.shootLoadEvent===null));
}

// Declining keeps both cards and starts the ordinary primary pick.
{
  const r=baseRoom({shootLoadFireMode:true});
  r.players[0].hand=[joker('NO-J'),mad('NO-M'),normal('NO-X',9)];
  r.postTrickFlow=api.buildPostTrickFlow(r,0,3);api.offerShootDecisionOrBeginPick(r);
  assert.strictEqual(api.resolveShootDecision(r,'A',false),true);
  assert.strictEqual(r.players[0].hand.some(c=>c.id==='NO-J'),true);
  assert.strictEqual(r.players[0].hand.some(c=>c.id==='NO-M'),true);
  assert.strictEqual(r.pendingPick.pickStage,'primary');assert.strictEqual(r.players[0].matchStats.shootDeclinedCount,1);
}

// CPU personalities make a decision from public counts/current scores, never candidate card faces.
{
  const r=baseRoom({shootLoadFireMode:true});r.pendingShootDecision={targetPid:3};
  r.players[0].cpu=true;r.players[0].cpuCharacter={key:'wakumodoki'};
  assert.strictEqual(api.cpuShouldFireShoot(r,0),true);
  r.players[0].cpuCharacter={key:'kamomodoki'};assert.strictEqual(api.cpuShouldFireShoot(r,0),true);
  r.players[3].hand=[normal('ONLY',2)];assert.strictEqual(api.cpuShouldFireShoot(r,0),false);
  r.players[0].cpuCharacter={key:'rikumodoki'};r.players[0].hand.push(normal('MORE',5));
  assert.strictEqual(typeof api.cpuShouldFireShoot(r,0),'boolean');
}

// Confirmed totals are server snapshots only: R1 is visible during R2, then R1+R2 during R3.
{
  const r=baseRoom();
  api.recordRoundStats(r,{round:1,rows:[0,1,2,3].map(pid=>({pid,total:[12,-4,7,0][pid],handCount:2,handPenalty:6,pileCardCount:8,pileScore:8}))});
  r.round=2;
  assert.deepStrictEqual([...api.publicState(r,'A').completedRoundTotalScores],[12,-4,7,0]);
  assert.strictEqual(api.publicState(r,'A').players[0].completedRoundTotalScore,12);
  api.recordRoundStats(r,{round:2,rows:[0,1,2,3].map(pid=>({pid,total:[20,3,5,-8][pid],handCount:1,handPenalty:3,pileCardCount:12,pileScore:12}))});
  r.round=3;
  assert.deepStrictEqual([...api.publicState(r,'A').completedRoundTotalScores],[20,3,5,-8]);
  r.phase='finished';api.initializeMatch(r,{rematch:true});
  assert.deepStrictEqual([...r.completedRoundTotalScores],[0,0,0,0],'rematch resets totals');
}

// Defaults/dependencies/UI contracts remain aligned.
{
  const socket=ws();api.createRoom(socket,'Default-v39');const d=[...api.rooms.values()].at(-1);
  assert.strictEqual(d.enableMiddleRankPick,false);assert.strictEqual(d.shootLoadFireMode,false);
  const socket2=ws();api.createRoom(socket2,'Normalized',3,true,-20,false,false,'mud6',2,'perRound',true,'reshuffle','unlimited',1,'winner','player',false,true,true,true);
  const n=[...api.rooms.values()].at(-1);
  assert.strictEqual(n.enableMiddleRankPick,true);assert.strictEqual(n.shootLoadFireMode,true);
  assert.strictEqual(n.shootRequiresBabaMoved,false,'load/fire server-normalizes old movement requirement');
  assert.match(html,/🔥 テスト中の注目ルール/);
  assert.strictEqual((html.match(/id="enableMiddleRankPick"/g)||[]).length,1);
  assert.strictEqual((html.match(/id="shootLoadFireMode"/g)||[]).length,1);
  assert.strictEqual((html.match(/id="forceJokerPickCandidate"/g)||[]).length,1);
  assert.match(html,/あなたの番です/);assert.match(html,/shoot-fire-cutscene/);
  assert.match(html,/prefers-reduced-motion: reduce/);assert.match(html,/__lastShootFireEventId/);
  assert.match(html,/\.shoot-fire-cutscene\{[^}]*pointer-events:none/);
  assert.match(html,/if\(!__animationStateHydrated\)\{ __lastShootFireEventId=ev\.id;return true; \}/);
  assert.match(html,/window\.clearTimeout\(window\.__shootPigOverlayTimer\)/);
  assert.match(html,/window\.__shootPigOverlayTimer=window\.setTimeout/);
  assert.match(html,/SHOOT SUCCESS!/);assert.match(html,/ババブタ直撃/);
  assert.match(html,/completedRoundTotalScore/);assert.match(html,/総合/);
}

console.log(JSON.stringify({result:'passed',suite:'pipitori-v39-regression',middlePick:true,loadFire:true,privacy:true,cumulativeScores:true}));
