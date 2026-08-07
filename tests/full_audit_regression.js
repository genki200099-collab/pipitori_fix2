'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const serverPath = path.join(root, 'server.js');
const htmlPath = path.join(root, 'public', 'index.html');
const source = fs.readFileSync(serverPath, 'utf8');
const html = fs.readFileSync(htmlPath, 'utf8');

class FakeWebSocketServer {
  constructor(){ this.clients = new Set(); }
  on() {}
}
const FakeWebSocket = {Server:FakeWebSocketServer, OPEN:1};
const fakeHttpServer = {listen() {}};
const sandbox = {
  console,
  Buffer,
  process:{env:{}},
  __dirname:root,
  setTimeout:()=>1,
  clearTimeout:()=>{},
  setInterval:()=>1,
  clearInterval:()=>{},
  require(name){
    if(name === 'http') return {createServer:()=>fakeHttpServer};
    if(name === 'ws') return FakeWebSocket;
    if(name === 'crypto') return crypto;
    if(name === 'fs') return fs;
    if(name === 'path') return path;
    if(name === './cpu_personality_dialogue') return require(path.join(root, 'cpu_personality_dialogue.js'));
    if(name === './spotlight_priority') return require(path.join(root, 'spotlight_priority.js'));
    throw new Error(`Unexpected require: ${name}`);
  }
};
sandbox.globalThis = sandbox;

const exportSource = `${source}\n;globalThis.__auditApi={
  ensureLobbyHost, reconnectRoom, ensureRoomProgress,
  maybeFinishPassPhase, maybeFinishInitialPairPhase, finishPassThreePhase,
  resolveTrick, finishAfterPick, makeDeck, sortHand, rooms,
  rememberEndAfterTrick, endCandidatePid, safeFinishBecauseNoPlayable, cleanName
};`;
vm.runInNewContext(exportSource, sandbox, {filename:serverPath});
const api = sandbox.__auditApi;

const openWs = ()=>({readyState:1, sent:[], send(v){ this.sent.push(v); }, close(){ this.readyState=3; }});
const player = (id, hand=[])=>({
  id, name:id, resumeToken:`token-${id}`, cpu:false, ws:openWs(), disconnectedAt:null,
  hand, scorePile:[], pairs:[], completedRoundCardScoreBank:0, jokerPenaltyBank:0, shootPigPenaltyBank:0,
  shootPigFinalMadPigWaived:false, shootPigGameEndJokerWaived:false,
  shootPigActivatedRounds:[], out:false
});
const baseRoom = (players, extra={})=>({
  code:'AUD1', hostId:players[0]?.id, players, phase:'playing', round:1, totalRounds:2,
  madPigEnabled:true, shootThePigEnabled:true, jokerPenalty:20, jokerPenaltyTiming:'perRound',
  roundDealMode:'reshuffle', penaltyMode:'mud6', pickTargetCount:2, initialPairDiscardEnabled:false, passThreeEnabled:false,
  lead:0, current:0, leadSuit:null, trick:[], stock:[], log:[], commentary:[], pendingPick:null,
  trickReview:null, roundEndSummary:null, roundEndDeferred:null, shootPigRoundResults:{},
  initialPairDone:[], passDone:[], passSelections:{}, ...extra
});

// A disconnected lobby host must not strand the remaining players.
{
  const a=player('A'); a.ws=null;
  const b=player('B');
  const room=baseRoom([a,b],{phase:'lobby',hostId:'A'});
  assert.strictEqual(api.ensureLobbyHost(room),true);
  assert.strictEqual(room.hostId,'B');
  assert.match(room.message,/新しい部屋主/);
}


// A disconnected host on the final result must not block rematch for connected players.
{
  const a=player('FA'); a.ws=null;
  const b=player('FB');
  const room=baseRoom([a,b],{phase:'finished',hostId:'FA'});
  assert.strictEqual(api.ensureLobbyHost(room),true);
  assert.strictEqual(room.hostId,'FB');
  assert.match(room.message,/再戦/);
}

// When nobody is connected, host authority must not move to another disconnected seat.
{
  const a=player('HA'); a.ws=null;
  const b=player('HB'); b.ws=null;
  const room=baseRoom([a,b],{phase:'lobby',hostId:'HA'});
  assert.strictEqual(api.ensureLobbyHost(room),false);
  assert.strictEqual(room.hostId,'HA');

  // As soon as B reconnects, reconnectRoom must re-evaluate and hand authority to B.
  api.rooms.set(room.code,room);
  const ws=openWs();
  api.reconnectRoom(ws,room.code,'HB','HB',b.resumeToken);
  assert.strictEqual(room.hostId,'HB');
  assert.strictEqual(b.ws,ws);
  api.rooms.delete(room.code);
}

// Setup phases must auto-resolve after 30 seconds even when the idle player is still connected.
{
  const deck=api.makeDeck().filter(c=>!c.joker);
  const players=Array.from({length:4},(_,i)=>player(`P${i}`,deck.slice(i*13,(i+1)*13)));
  const room=baseRoom(players,{
    phase:'passing',passThreeEnabled:true,setupPhaseStartedAt:Date.now()-31000,
    passDone:[],passSelections:{},current:null
  });
  api.maybeFinishPassPhase(room);
  assert.strictEqual(room.phase,'playing');
  assert.ok(players.every(p=>p.hand.length===13));
  assert.ok(room.log.some(x=>/30秒間操作がなかった/.test(x.text)));
}

{
  const deck=api.makeDeck().filter(c=>!c.joker);
  const pairRank=deck[0].rank;
  const sameRank=deck.find(c=>c.id!==deck[0].id && c.rank===pairRank);
  const p0=player('P0',[deck[0],sameRank]);
  const players=[p0,player('P1',[deck[2]]),player('P2',[deck[3]]),player('P3',[deck[4]])];
  const room=baseRoom(players,{
    phase:'initialPair',initialPairDiscardEnabled:true,setupPhaseStartedAt:Date.now()-31000,
    initialPairDone:[],current:null
  });
  api.maybeFinishInitialPairPhase(room);
  assert.strictEqual(room.phase,'playing');
  assert.ok(room.log.some(x=>/開始時ペア捨てをスキップ/.test(x.text)));
}

// Corrupt five-card tricks recover without deleting the extra card or stalling on an invalid lead suit.
{
  const deck=api.makeDeck().filter(c=>!c.joker);
  const players=[player('A'),player('B'),player('C'),player('D')];
  const extra=deck[4];
  const room=baseRoom(players,{
    lead:0,current:null,leadSuit:'invalid-suit',
    trick:[0,1,2,3,0].map((pid,i)=>({pid,card:deck[i],order:i}))
  });
  api.resolveTrick(room);
  assert.strictEqual(room.trick.length,4);
  assert.ok(players[0].hand.some(c=>c.id===extra.id),'extra card should return to its owner');
  assert.ok(room.trickReview,'trick should continue to review instead of stalling');
  assert.strictEqual(players.reduce((n,p)=>n+p.scorePile.length,0),4);
}



// A completed but unresolved trick must be scored before an empty hand ends the round.
{
  const deck=api.makeDeck().filter(c=>!c.joker);
  const players=[player('EA'),player('EB'),player('EC'),player('ED')];
  const room=baseRoom(players,{
    lead:0,current:null,leadSuit:deck[0].suit,
    trick:[0,1,2,3].map((pid,i)=>({pid,card:deck[i],order:i}))
  });
  api.ensureRoomProgress(room);
  assert.strictEqual(room.phase,'playing');
  assert.ok(room.trickReview,'the completed trick must enter review first');
  assert.ok(room.roundEndDeferred,'empty-hand ending must be deferred until the pick finishes');
  assert.strictEqual(players.reduce((n,p)=>n+p.scorePile.length,0),4);
}

// The watchdog path for a five-card trick must also restore the fifth card.
{
  const deck=api.makeDeck().filter(c=>!c.joker);
  const players=[player('WA',[deck[8]]),player('WB',[deck[9]]),player('WC',[deck[10]]),player('WD',[deck[11]])];
  const extra=deck[4];
  const room=baseRoom(players,{
    lead:0,current:null,leadSuit:deck[0].suit,
    trick:[0,1,2,3,0].map((pid,i)=>({pid,card:deck[i],order:i}))
  });
  api.ensureRoomProgress(room);
  assert.ok(players[0].hand.some(c=>c.id===extra.id),'watchdog must return the extra card');
  assert.ok(room.trickReview,'watchdog should resolve the valid four-card trick');
}

// A syntactically valid but stale lead suit must not choose the wrong winner.
{
  const card=(id,suit,val)=>({id,faceKey:`${suit}:${val}`,suit,rank:String(val),val,joker:false});
  const players=[player('LA'),player('LB'),player('LC'),player('LD')];
  const room=baseRoom(players,{
    lead:0,current:null,leadSuit:'mud',
    trick:[
      {pid:0,card:card('a2','apple',2),order:0},
      {pid:1,card:card('a9','apple',9),order:1},
      {pid:2,card:card('c1','corn',1),order:2},
      {pid:3,card:card('g13','cabbage',13),order:3}
    ]
  });
  api.resolveTrick(room);
  assert.strictEqual(room.leadSuit,'apple');
  assert.strictEqual(room.lastTrick.winnerPid,1);
  assert.strictEqual(room.lastTrick.weakestPid,2);
  assert.strictEqual(players[1].scorePile.length,4);
}

// Severe trick corruption is canceled safely instead of assigning a provisional winner.
{
  const deck=api.makeDeck().filter(c=>!c.joker).slice(0,4);
  const players=[player('CA'),player('CB'),player('CC'),player('CD')];
  const room=baseRoom(players,{
    lead:0,current:null,leadSuit:deck[0].suit,
    trick:[
      {pid:0,card:deck[0],order:0},
      {pid:0,card:deck[1],order:1},
      {pid:2,card:deck[2],order:2},
      {pid:3,card:deck[3],order:3}
    ]
  });
  api.resolveTrick(room);
  assert.strictEqual(room.trick.length,0);
  assert.strictEqual(room.trickReview,null);
  assert.strictEqual(players.reduce((n,p)=>n+p.scorePile.length,0),0);
  assert.strictEqual(players.reduce((n,p)=>n+p.hand.length,0),4);
}

// Duplicate/stale pass IDs must never invoke splice(-1) and remove an unrelated card.
{
  const deck=api.makeDeck().filter(c=>!c.joker);
  const players=Array.from({length:4},(_,i)=>player(`DP${i}`,deck.slice(i*13,(i+1)*13)));
  const selections={};
  players.forEach((p,i)=>{ selections[i]=p.hand.slice(0,3).map(c=>c.id); });
  selections[0]=[players[0].hand[0].id,players[0].hand[0].id,'stale-id'];
  const room=baseRoom(players,{
    phase:'passing',passThreeEnabled:true,passSelections:selections,passDone:[0,1,2,3]
  });
  api.finishPassThreePhase(room);
  assert.strictEqual(room.phase,'playing');
  assert.ok(players.every(p=>p.hand.length===13));
  assert.ok(room.log.some(x=>/自動補正/.test(x.text)));
}

// Joker-only round ending happens immediately when the next lead is assigned, not one watchdog tick later.
{
  const joker={id:'J',faceKey:'JOKER',suit:null,rank:'JOKER',val:0,joker:true};
  const deck=api.makeDeck().filter(c=>!c.joker);
  const players=[player('A',[joker]),player('B',[deck[0]]),player('C',[deck[1]]),player('D',[deck[2]])];
  const room=baseRoom(players,{
    phase:'playing',current:null,lead:1,trick:[],pendingPick:{winnerPid:0},round:1,totalRounds:2
  });
  api.finishAfterPick(room,0);
  assert.strictEqual(room.phase,'roundEnd');
  assert.strictEqual(room.roundEndOutPid,0);
  assert.match(room.roundEndSummary.reasonText,/ババブタ1枚だけ/);
}


// When more than one player empties in the same trick, preserve the first actual finisher.
{
  const players=[player('E0'),player('E1'),player('E2'),player('E3')];
  const room=baseRoom(players,{round:2,trick:[{pid:2,card:{id:'played',suit:'apple',rank:1,val:1}}]});
  api.rememberEndAfterTrick(room,2);
  api.rememberEndAfterTrick(room,0);
  assert.strictEqual(room.roundEndDeferred.pid,2);
  assert.strictEqual(api.endCandidatePid(room),2);
}

// If an impossible empty-hand turn appears during a partial trick, restore the table card before ending.
{
  const card={id:'restore-me',faceKey:'apple-5',suit:'apple',rank:5,val:5,joker:false};
  const players=[player('R0',[]),player('R1',[]),player('R2',[{id:'r2',suit:'corn',rank:2,val:2,joker:false}]),player('R3',[{id:'r3',suit:'mud',rank:3,val:3,joker:false}])];
  const room=baseRoom(players,{current:1,lead:0,leadSuit:'apple',trick:[{pid:0,card,order:0}]});
  assert.strictEqual(api.safeFinishBecauseNoPlayable(room,1),true);
  assert.strictEqual(room.phase,'roundEnd');
  assert.strictEqual(room.trick.length,0);
  assert.ok(players[0].hand.some(c=>c.id==='restore-me'));
  assert.strictEqual(players.reduce((n,p)=>n+p.scorePile.length,0),0);
}

// Player names collapse line breaks and count Unicode characters without splitting emoji.
{
  assert.strictEqual(api.cleanName('  A\n\tB  '),'A B');
  const cleaned=api.cleanName('🐷'.repeat(20));
  assert.strictEqual(Array.from(cleaned).length,12);
  assert.ok(!cleaned.includes('\uFFFD'));
}

// Client regressions: two commentary rows, non-blocking rapid taps, accurate result labels and tie ranks.
assert.match(html,/state\.commentary\|\|\[\]\)\.filter\([\s\S]*\.slice\(0,2\)/);
assert.match(html,/__commentaryExpiryTimer/);
assert.match(html,/speech-bubble:nth-child\(n\+3\)/);
assert.match(html,/shouldHandleActionEvent\(ev,'pick-target'\)/);
assert.match(html,/ev\.pointerType === 'mouse' && ev\.button !== 0/);
assert.doesNotMatch(html,/__lastPickTargetPointerAt|__lastPickTargetTapAt/);
assert.match(html,/残り手札（ババ除く）/);
assert.match(html,/同率.*位/);
assert.doesNotMatch(html,/r\.normalHand\|\|0\)\*3/);
assert.doesNotMatch(source,/同じ名前で再接続してください/);
assert.match(html,/pair-decision-layout/);
assert.match(html,/pick-target-panel>\.btn/);
assert.match(html,/body\.finished-mode \.hype-toast/);
assert.match(html,/@media \(max-width:360px\) and \(orientation:portrait\)[\s\S]*round-grid/);
assert.match(html,/classList\.toggle\('is-setup-mode'/);
assert.match(html,/game-screen\.is-setup-mode \.hand-dock #handNote[\s\S]*pointer-events:auto/);
assert.match(html,/game-screen\.is-setup-mode[\s\S]*grid-template-rows:44px 30px minmax\(0,1fr\) 224px/);


assert.match(html,/id="roundDealMode"/);
assert.match(html,/全カードを回収してシャッフル/);
assert.match(html,/roundDealMode:\$\('roundDealMode'\)\.value/);
assert.match(html,/毎R全シャッフル/);
assert.match(html,/visibility probe timeout/);
assert.match(html,/70000[\s\S]*heartbeat timeout/);
assert.match(html,/not\(\.ui-phone\) \.commentary-layer[\s\S]*padding:3px 2px 3px 4px/);
assert.match(source,/WS_HEARTBEAT_MAX_MISSES/);
assert.match(source,/missedHeartbeats/);
assert.match(source,/const deferred = room\.roundEndDeferred/);
assert.match(source,/空手札の手番がトリック途中に発生/);
assert.match(source,/if\(!silent\) maybeFinishInitialPairPhase/);
assert.match(html,/function penaltyDisplay/);
assert.match(html,/累計暫定得点/);
assert.doesNotMatch(html,/`-\$\{r\.jokerPenalty \?\? 0\}`/);
assert.match(html,/compactPortrait \? 6 : 10/);
assert.match(html,/function isTerminalReconnectError/);
assert.match(html,/mode === 'expired'/);
assert.match(html,/const sent=send\(\{type:'pickTargets'/);
assert.match(html,/const sent=send\(\{type:'passThree'/);

console.log('full audit regression: all assertions passed');
