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

class FakeWebSocketServer {
  on() {}
}
const FakeWebSocket = {Server:FakeWebSocketServer, OPEN:1};
const fakeHttpServer = {listen() {}};
const sandbox = {
  console,
  process:{env:{}},
  __dirname:root,
  setTimeout:()=>0,
  clearTimeout:()=>{},
  setInterval:()=>0,
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

const exportSource = `${source}\n;globalThis.__rulesTestApi={
  SUIT_DEFINITIONS, suits, makeDeck, cardText, isMadPig, sortHand, playableIds, judgeWeakestCard,
  normalizePenaltyMode, normalizeRoundDealMode, normalizeShootThePigLimit, normalizeFeastPointPerCard, normalizePickProviderRole, handPenaltyForRoom, madPigPenaltyForRoom,
  playerHasMadPigInHand, playerHasUsedShootThePig, playerShootLimitReached, playerCanShootThePig,
  applyShootThePigForRound, makeRoundSnapshot, cpuCardHandRisk, feastPileScore,
  roomPenaltyLabel, publicState, score, createRoom, rooms,
  registerMadPigEvent, registerPairCleanEvent, pickResultDisplayMs, beginNextRound
};`;
vm.runInNewContext(exportSource, sandbox, {filename:serverPath});
const api = sandbox.__rulesTestApi;

const card = (suit, rank, id=`${suit}${rank}`)=>({id, suit, rank:String(rank), val:Number(rank), joker:false});
const joker = (id='J')=>({id, faceKey:'JOKER', suit:null, rank:'JOKER', val:0, joker:true});
const basePlayer = (name, hand=[], pile=[])=>({
  id:name, name, cpu:false, ws:null, hand, scorePile:pile, pairs:[],
  completedRoundCardScoreBank:0, jokerPenaltyBank:0, shootPigPenaltyBank:0,
  shootPigFinalMadPigWaived:false, shootPigGameEndJokerWaived:false,
  shootPigActivatedRounds:[], out:false
});
const baseRoom = (players, extra={})=>({
  players, roundDealMode:'reshuffle', feastPointPerCard:1, pickProviderRole:'winner', penaltyMode:'mud6', madPigEnabled:true,
  shootThePigEnabled:true, shootThePigLimit:'unlimited', jokerPenalty:20, jokerPenaltyTiming:'perRound',
  round:1, totalRounds:3, shootPigRoundResults:{}, shootPigEvent:null,
  log:[], commentary:[], ...extra
});

// Cinematic event payloads are deterministic game state, deduplicated by ID,
// and do not reveal initial-pair suits that were previously private.
{
  const players=[basePlayer('A'),basePlayer('B'),basePlayer('C'),basePlayer('D')];
  const room=baseRoom(players,{
    code:'FX01',hostId:'A',phase:'playing',round:2,totalRounds:3,
    lead:0,current:null,leadSuit:null,trick:[],pendingPick:null,
    initialPairDone:[],passDone:[],passSelections:{},lastTrick:null
  });
  const mad=card('mud',11,'mad-event');
  const madEvent=api.registerMadPigEvent(room,1,mad,'trick');
  assert.ok(madEvent.id.startsWith('mad-2-1-'));
  assert.strictEqual(madEvent.ownerName,'B');
  assert.strictEqual(madEvent.source,'trick');
  assert.strictEqual(madEvent.card.id,'mad-event');

  const pair=[card('apple',7,'pair-a'),card('corn',7,'pair-b')];
  const visiblePair=api.registerPairCleanEvent(room,2,pair,'pick',true);
  assert.ok(visiblePair.id.startsWith('pair-2-2-'));
  assert.deepStrictEqual([...visiblePair.cards].map(c=>c.id),['pair-a','pair-b']);
  const hiddenPair=api.registerPairCleanEvent(room,0,[mad,card('apple',11,'hidden-11')],'initial',false);
  assert.strictEqual(hiddenPair.cards,null);
  assert.strictEqual(hiddenPair.rank,'11');
  assert.strictEqual(hiddenPair.containsMadPig,false);

  assert.strictEqual(api.pickResultDisplayMs(room,{drawn:joker()}),5600);
  assert.strictEqual(api.pickResultDisplayMs(room,{drawn:card('apple',4),paired:true}),4500);
  assert.strictEqual(api.pickResultDisplayMs(room,{drawn:mad}),5000);
  assert.strictEqual(api.pickResultDisplayMs(room,{drawn:card('cabbage',4)}),2350);
  const publicView=api.publicState(room,'A');
  assert.strictEqual(publicView.madPigEvent.id,madEvent.id);
  assert.strictEqual(publicView.pairCleanEvent.cards,null);
}

// New missing/unknown values fall back to the adopted default; legacy options remain valid.
assert.strictEqual(api.normalizePenaltyMode(undefined), 'mud6');
assert.strictEqual(api.normalizePenaltyMode('mud6'), 'mud6');
assert.strictEqual(api.normalizePenaltyMode('spade6'), 'mud6'); // old-client alias
assert.strictEqual(api.normalizePenaltyMode('flat3'), 'flat3');
assert.strictEqual(api.normalizePenaltyMode('faceValue'), 'faceValue');
assert.strictEqual(api.normalizePenaltyMode('mudSuit'), 'mudSuit');
assert.strictEqual(api.normalizePenaltyMode('spadeSuit'), 'mudSuit'); // old-client alias
assert.strictEqual(api.normalizeRoundDealMode(undefined), 'reshuffle');
assert.strictEqual(api.normalizeRoundDealMode('reshuffle'), 'reshuffle');
assert.strictEqual(api.normalizeRoundDealMode('carryOver'), 'carryOver');
assert.strictEqual(api.normalizeShootThePigLimit(undefined), 'unlimited');
assert.strictEqual(api.normalizeShootThePigLimit('unlimited'), 'unlimited');
assert.strictEqual(api.normalizeShootThePigLimit('once'), 'once');
assert.strictEqual(api.normalizeShootThePigLimit('legacy-once'), 'unlimited');
assert.strictEqual(api.normalizeRoundDealMode('unknown'), 'reshuffle');
for(const [input,expected] of [[undefined,1],[-1,1],[0,0],[1,1],[2,2],[5,5],[10,10],[11,1],['2',2],[2.9,1]]) assert.strictEqual(api.normalizeFeastPointPerCard(input),expected);
assert.strictEqual(api.normalizePickProviderRole(undefined),'winner');
assert.strictEqual(api.normalizePickProviderRole('winner'),'winner');
assert.strictEqual(api.normalizePickProviderRole('weakest'),'weakest');
assert.strictEqual(api.normalizePickProviderRole('legacy'),'winner');

// The physical deck uses only the four pig-flavored suits.
{
  assert.deepStrictEqual([...api.suits],['apple','corn','cabbage','mud']);
  const deck=api.makeDeck();
  const normal=deck.filter(c=>!c.joker);
  assert.strictEqual(normal.length,52);
  assert.deepStrictEqual([...new Set(normal.map(c=>c.suit))],['apple','corn','cabbage','mud']);
  assert.deepStrictEqual(normal.reduce((out,c)=>(out[c.suit]=(out[c.suit]||0)+1,out),{}),{apple:13,corn:13,cabbage:13,mud:13});
  assert.strictEqual(api.isMadPig(normal.find(c=>c.suit==='mud'&&c.rank==='11')),true);
  assert.match(api.cardText(normal.find(c=>c.suit==='apple'&&c.rank==='5')),/5 🍎 リンゴ/);
}

// Follow-suit, hand ordering, and weakest-card logic operate on the new suit IDs.
{
  const p=basePlayer('P',[card('apple',5),card('corn',2),card('mud',9),joker()]);
  const room=baseRoom([p],{phase:'playing',current:0,leadSuit:'apple',trick:[]});
  assert.deepStrictEqual([...api.playableIds(room,0)],[p.hand[0].id]);
  room.leadSuit='cabbage';
  assert.deepStrictEqual([...api.playableIds(room,0)].sort(),p.hand.filter(c=>!c.joker).map(c=>c.id).sort());

  api.sortHand(p.hand);
  assert.deepStrictEqual(p.hand.map(c=>c.suit || 'joker'),['apple','corn','mud','joker']);

  const trickRoom=baseRoom([
    basePlayer('A'),basePlayer('B'),basePlayer('C'),basePlayer('D')
  ],{leadSuit:'apple',trick:[
    {pid:0,card:card('apple',10,'t0')},
    {pid:1,card:card('apple',3,'t1')},
    {pid:2,card:card('mud',7,'t2')},
    {pid:3,card:card('corn',2,'t3')}
  ]});
  assert.strictEqual(api.judgeWeakestCard(trickRoom,'apple').pid,3);
}

// Default: apple/corn/cabbage -3, ordinary mud -6, Mad Pig is a separate -13.
{
  const p=basePlayer('P',[card('apple',5),card('corn',8),card('cabbage',2),card('mud',5),card('mud',11)]);
  const room=baseRoom([p]);
  assert.strictEqual(api.handPenaltyForRoom(room,p), 15); // 3+3+3+6; Mad skipped here.
  assert.strictEqual(api.madPigPenaltyForRoom(room,p), 13);
  assert.strictEqual(api.cpuCardHandRisk(room,card('mud',7)), 6);
  assert.strictEqual(api.cpuCardHandRisk(room,card('apple',7)), 3);
  assert.strictEqual(api.cpuCardHandRisk(room,card('mud',11)), 13);
  assert.strictEqual(api.roomPenaltyLabel(room), '💧-6/他-3');
}

// The final score uses exactly the same default decomposition; there is no weakest/pick bonus.
{
  const p=basePlayer('P',[card('apple',2),card('mud',5),joker()],[card('mud',11,'mad-pile')]);
  const room=baseRoom([p]);
  p.jokerPenaltyBank=20;
  api.score(room);
  assert.strictEqual(p.final.pile,1);
  assert.strictEqual(p.final.handPenalty,9);
  assert.strictEqual(p.final.madPigPenalty,13);
  assert.strictEqual(p.final.jokerPenalty,20);
  assert.strictEqual(p.final.total,-41);
}

// Mad Pig does not double with the ordinary-card penalty outside face-value mode.
{
  const madHand=card('mud',11,'mad-hand');
  const madPile=card('mud',11,'mad-pile');
  const p=basePlayer('P',[madHand],[madPile]);
  const room=baseRoom([p]);
  assert.strictEqual(api.handPenaltyForRoom(room,p), 0);
  assert.strictEqual(api.madPigPenaltyForRoom(room,p), 26);

  room.penaltyMode='flat3';
  assert.strictEqual(api.handPenaltyForRoom(room,p), 0);
  assert.strictEqual(api.madPigPenaltyForRoom(room,p), 26);

  room.penaltyMode='faceValue';
  assert.strictEqual(api.handPenaltyForRoom(room,p), 40);
  assert.strictEqual(api.madPigPenaltyForRoom(room,p), 40); // pile copy only; hand copy is in hand penalty.

  room.penaltyMode='mud6'; room.madPigEnabled=false;
  assert.strictEqual(api.handPenaltyForRoom(room,p), 6);
  assert.strictEqual(api.madPigPenaltyForRoom(room,p), 0);
}

// Every selectable penalty mode keeps its intended slope and Mad treatment.
{
  const p=basePlayer('P',[card('apple',5),card('mud',5),card('mud',11)]);
  const room=baseRoom([p]);
  const expected={
    mud6:{hand:9,mad:13},
    flat3:{hand:6,mad:13},
    mudSuit:{hand:4,mad:13},
    faceValue:{hand:50,mad:0}
  };
  for(const [mode,result] of Object.entries(expected)){
    room.penaltyMode=mode;
    assert.strictEqual(api.handPenaltyForRoom(room,p),result.hand,`${mode} hand`);
    assert.strictEqual(api.madPigPenaltyForRoom(room,p),result.mad,`${mode} Mad`);
  }
}


// Shoot OFF and Mad OFF both prevent activation.
{
  const combo=basePlayer('combo',[joker(),card('mud',11)]);
  const room=baseRoom([combo]);
  room.shootThePigEnabled=false;
  assert.strictEqual(api.playerCanShootThePig(room,combo),false);
  assert.strictEqual(api.applyShootThePigForRound(room),null);

  room.shootThePigEnabled=true;
  room.madPigEnabled=false;
  room.shootPigRoundResults={};
  assert.strictEqual(api.playerCanShootThePig(room,combo),false);
  assert.strictEqual(api.applyShootThePigForRound(room),null);
}

// With game-end Joker timing, Shoot is checked only in the final round and waives that final Joker loss.
{
  const shooter=basePlayer('LateShooter',[joker(),card('mud',11)]);
  const room=baseRoom([shooter,basePlayer('B'),basePlayer('C'),basePlayer('D')],{
    jokerPenaltyTiming:'gameEnd', round:2, totalRounds:3
  });
  assert.strictEqual(api.applyShootThePigForRound(room),null);
  assert.deepStrictEqual([...shooter.shootPigActivatedRounds],[]);
  room.round=3;
  const result=api.applyShootThePigForRound(room);
  assert.strictEqual(result.shooterPid,0);
  assert.deepStrictEqual([...shooter.shootPigActivatedRounds],[3]);
  api.score(room);
  assert.strictEqual(shooter.final.jokerPenaltyAtGameEnd,0);
  assert.strictEqual(shooter.final.madPigPenalty,0);
}

// Shoot requires both dangerous cards in hand; a scored Mad Pig is insufficient.
{
  const handCombo=basePlayer('hand-combo',[joker(),card('mud',11)]);
  const pileOnly=basePlayer('pile-only',[joker('J2')],[card('mud',11,'pile-mad')]);
  const room=baseRoom([handCombo,pileOnly]);
  assert.strictEqual(api.playerHasMadPigInHand(room,handCombo), true);
  assert.strictEqual(api.playerCanShootThePig(room,handCombo), true);
  assert.strictEqual(api.playerHasMadPigInHand(room,pileOnly), false);
  assert.strictEqual(api.playerCanShootThePig(room,pileOnly), false);
}

// Shoot is idempotent inside a round. Standard unlimited mode allows the same player to fire again in a later round.
{
  const shooter=basePlayer('Shooter',[joker(),card('mud',11)]);
  const others=[basePlayer('B',[card('apple',2)]),basePlayer('C',[card('corn',3)]),basePlayer('D',[card('cabbage',4)])];
  const room=baseRoom([shooter,...others]);
  const first=api.applyShootThePigForRound(room);
  assert.strictEqual(first.shooterPid,0);
  assert.strictEqual(first.limitMode,'unlimited');
  assert.strictEqual(first.activationCount,1);
  assert.deepStrictEqual([...shooter.shootPigActivatedRounds],[1]);
  assert.deepStrictEqual(others.map(p=>p.shootPigPenaltyBank),[10,10,10]);
  const cached=api.applyShootThePigForRound(room);
  assert.strictEqual(cached,first);
  assert.deepStrictEqual(others.map(p=>p.shootPigPenaltyBank),[10,10,10]);

  room.round=2;
  const second=api.applyShootThePigForRound(room);
  assert.strictEqual(second.shooterPid,0);
  assert.strictEqual(second.activationCount,2);
  assert.deepStrictEqual([...shooter.shootPigActivatedRounds],[1,2]);
  assert.strictEqual(api.playerShootLimitReached(room,shooter),false);
  assert.strictEqual(api.playerCanShootThePig(room,shooter),true);
  assert.deepStrictEqual(others.map(p=>p.shootPigPenaltyBank),[20,20,20]);
}

// Optional once mode blocks a second activation, and a prior Shoot does not waive later-round Mad/Joker loss.
{
  const shooter=basePlayer('OnceShooter',[joker(),card('mud',11)]);
  const others=[basePlayer('B',[card('apple',2)]),basePlayer('C',[card('corn',3)]),basePlayer('D',[card('cabbage',4)])];
  const room=baseRoom([shooter,...others],{shootThePigLimit:'once'});
  const first=api.applyShootThePigForRound(room);
  assert.strictEqual(first.shooterPid,0);
  assert.strictEqual(first.limitMode,'once');
  assert.strictEqual(api.playerShootLimitReached(room,shooter),true);

  room.round=2;
  const second=api.applyShootThePigForRound(room);
  assert.strictEqual(second,null);
  assert.strictEqual(api.playerCanShootThePig(room,shooter),false);
  const summary=api.makeRoundSnapshot(room,1,'test');
  assert.strictEqual(summary.rows[0].madPigPenalty,13);
  assert.strictEqual(summary.rows[0].shootPigMadPigWaived,false);
  assert.strictEqual(summary.rows[0].jokerPenalty,20);

  room.round=room.totalRounds;
  room.shootPigRoundResults[String(room.round)]=null;
  api.score(room);
  assert.strictEqual(shooter.final.shootPigMadPigWaived,false);
  assert.strictEqual(shooter.final.madPigPenalty,13);
  assert.strictEqual(shooter.final.jokerPenaltyFromRounds,20);
}

// Shoot also removes the hand-side 40-point Mad loss in face-value mode.
{
  const shooter=basePlayer('Shooter',[joker(),card('mud',11)]);
  const room=baseRoom([shooter,basePlayer('B'),basePlayer('C'),basePlayer('D')],{penaltyMode:'faceValue'});
  const summary=api.makeRoundSnapshot(room,0,'face value Shoot');
  assert.strictEqual(summary.rows[0].shootThePig,true);
  assert.strictEqual(summary.rows[0].rawHandPenalty,40);
  assert.strictEqual(summary.rows[0].handPenalty,0);
  assert.strictEqual(summary.rows[0].madPigPenalty,0);
  assert.strictEqual(summary.rows[0].jokerPenalty,0);
  assert.deepStrictEqual(summary.rows.slice(1).map(r=>r.shootPigPenalty),[10,10,10]);
}

// In once mode, another player may still use their own activation after the Joker moves.
{
  const a=basePlayer('A',[card('apple',2)]); a.shootPigActivatedRounds=[1];
  const b=basePlayer('B',[joker(),card('mud',11)]);
  const room=baseRoom([a,b,basePlayer('C',[card('corn',2)]),basePlayer('D',[card('cabbage',2)])],{round:2,shootThePigLimit:'once'});
  const result=api.applyShootThePigForRound(room);
  assert.strictEqual(result.shooterPid,1);
  assert.deepStrictEqual([...b.shootPigActivatedRounds],[2]);
}

// Server-side create defaults match the adopted rule even when an old/missing client omits options.
{
  const sent=[];
  const ws={readyState:1,send:x=>sent.push(JSON.parse(x))};
  api.createRoom(ws,'Tester');
  const room=[...api.rooms.values()].at(-1);
  assert.strictEqual(room.totalRounds,3);
  assert.strictEqual(room.roundDealMode,'reshuffle');
  assert.strictEqual(room.penaltyMode,'mud6');
  assert.strictEqual(room.pickTargetCount,2);
  assert.strictEqual(room.shootThePigEnabled,true);
  assert.strictEqual(room.shootThePigLimit,'unlimited');
  assert.strictEqual(room.forceJokerPickCandidate,false);
  assert.strictEqual(room.shootRequiresBabaMoved,false);
  assert.strictEqual(room.passThreeEnabled,false);
  assert.strictEqual(room.initialPairDiscardEnabled,false);
  assert.ok(sent.some(x=>x.type==='created'));
  const state=api.publicState(room,room.players[0].id);
  assert.strictEqual(state.shootThePigLimit,'unlimited');
  assert.strictEqual(state.shootThePigPerPlayerLimit,null);
  assert.strictEqual(state.roundDealMode,'reshuffle');
  assert.strictEqual(state.forceJokerPickCandidate,false);
  assert.strictEqual(state.shootRequiresBabaMoved,false);
  assert.strictEqual(state.players[0].shootUsed,false);
}

// Hosts can opt into the legacy one-activation-per-player limit.
{
  const ws={readyState:1,send() {}};
  api.createRoom(ws,'OnceRoom',3,true,-20,false,false,'mud6',2,'perRound',true,'reshuffle','once');
  const room=[...api.rooms.values()].at(-1);
  assert.strictEqual(room.shootThePigLimit,'once');
  const state=api.publicState(room,room.players[0].id);
  assert.strictEqual(state.shootThePigLimit,'once');
  assert.strictEqual(state.shootThePigPerPlayerLimit,1);
}

// Mad OFF also forces Shoot OFF at room creation, regardless of a stale client value.
{
  const ws={readyState:1,send() {}};
  api.createRoom(ws,'NoMad',3,false,-20,false,false,undefined,2,'perRound',true);
  const room=[...api.rooms.values()].at(-1);
  assert.strictEqual(room.madPigEnabled,false);
  assert.strictEqual(room.shootThePigEnabled,false);
}


// Default round transition collects every card, banks the finished round's card score,
// and deals a fresh 13-card hand to every player.
{
  const players=[basePlayer('RA'),basePlayer('RB'),basePlayer('RC'),basePlayer('RD')];
  players[0].completedRoundCardScoreBank=4;
  players.forEach((p,i)=>{ p.hand=[card('apple',i+1,`old-${i}`)]; p.scorePile=[card('corn',i+1,`pile-${i}`)]; p.pairs=[card('cabbage',i+1,`pair-a-${i}`),card('mud',i+1,`pair-b-${i}`)]; });
  const room=baseRoom(players,{
    code:'RS01',phase:'roundEnd',round:1,totalRounds:3,roundDealMode:'reshuffle',
    roundEndOutPid:2,roundEndSummary:{rows:[
      {pid:0,currentRoundCardScore:5},{pid:1,currentRoundCardScore:-3},
      {pid:2,currentRoundCardScore:0},{pid:3,currentRoundCardScore:2}
    ]},lead:0,current:null,trick:[],stock:[],log:[],commentary:[]
  });
  api.beginNextRound(room);
  assert.strictEqual(room.round,2);
  assert.strictEqual(room.current,2);
  assert.strictEqual(room.roundDealMode,'reshuffle');
  assert.deepStrictEqual(players.map(p=>p.completedRoundCardScoreBank),[9,-3,0,2]);
  assert.ok(players.every(p=>p.hand.length===13));
  assert.ok(players.every(p=>p.scorePile.length===0 && p.pairs.length===0));
  assert.strictEqual(players.flatMap(p=>p.hand).filter(c=>c.joker).length,1);
  assert.ok(room.removedCard && !room.removedCard.joker);
  assert.match(room.message,/全カードを回収してシャッフル/);
}


// Final scoring in reshuffle mode includes banked card scores from earlier rounds exactly once.
{
  const a=basePlayer('SA',[card('apple',2,'sa-hand')],[card('corn',4,'sa-pile-1'),card('cabbage',5,'sa-pile-2')]);
  const others=[basePlayer('SB',[card('apple',3,'sb')]),basePlayer('SC',[card('apple',4,'sc')]),basePlayer('SD',[card('apple',5,'sd')])];
  a.completedRoundCardScoreBank=12;
  const room=baseRoom([a,...others],{roundDealMode:'reshuffle',round:3,totalRounds:3});
  api.score(room);
  // Current round card score: pile 2 - hand penalty 3 = -1; previous rounds +12 => 11.
  assert.strictEqual(a.final.completedRoundCardScore,12);
  assert.strictEqual(a.final.currentRoundCardScore,-1);
  assert.strictEqual(a.final.total,11);
}

// Optional legacy mode keeps the existing zones and only refills hands.
{
  const deck=api.makeDeck();
  const removed=deck.find(c=>!c.joker);
  const active=deck.filter(c=>c!==removed);
  const players=[basePlayer('CA'),basePlayer('CB'),basePlayer('CC'),basePlayer('CD')];
  for(let i=0;i<4;i++) players[i].hand=active.slice(i*13,(i+1)*13);
  for(let i=0;i<3;i++) players[i].scorePile.push(players[i].hand.pop());
  players[0].pairs=[card('apple',7,'history-a'),card('corn',7,'history-b')];
  const bankBefore=players.map((p,i)=>(p.completedRoundCardScoreBank=i));
  const room=baseRoom(players,{
    code:'CO01',phase:'roundEnd',round:1,totalRounds:3,roundDealMode:'carryOver',removedCard:removed,
    roundEndOutPid:1,roundEndSummary:{rows:players.map((p,pid)=>({pid,currentRoundCardScore:99}))},
    lead:0,current:null,trick:[],stock:[],log:[],commentary:[]
  });
  api.beginNextRound(room);
  assert.ok(players.every(p=>p.hand.length===13));
  assert.strictEqual(players[0].scorePile.length,1);
  assert.strictEqual(players[0].pairs.length,2);
  assert.deepStrictEqual(players.map(p=>p.completedRoundCardScoreBank),bankBefore);
  assert.match(room.message,/持ち越し/);
}

// Static UI contract: selected option, standard preset, help copy, and no weakest +3 bonus.
{
  const html=fs.readFileSync(htmlPath,'utf8');
  assert.match(html,/<option value="mud6" selected>リンゴ・トウモロコシ・キャベツは-3点、通常の💧は-6点<\/option>/);
  assert.match(html,/<select id="roundDealMode"[^>]*><option value="reshuffle" selected>全カードを回収してシャッフル<\/option>/);
  assert.match(html,/values:\{rounds:'3',roundDealMode:'reshuffle',feastPointPerCard:'1',penaltyMode:'mud6'.*pickProviderRole:'winner',pickTargetCount:'2'.*passThreeEnabled:'false'.*initialPairDiscardEnabled:'false'/);
  assert.strictEqual((html.match(/feastPointPerCard:'1'/g) || []).length,4);
  assert.strictEqual((html.match(/pickProviderRole:'winner'/g) || []).length,4);
  assert.match(html,/両方が手札にある状態/);
  assert.match(html,/シュート発動回数/);
  assert.match(html,/無制限/);
  assert.match(html,/1人1回まで/);
  assert.strictEqual((html.match(/penaltyMode:'mud6'/g) || []).length,4);
  assert.match(html,/🍎リンゴ/);
  assert.match(html,/🌽トウモロコシ/);
  assert.match(html,/🥬キャベツ/);
  assert.match(html,/💧ぬかるみ（灰）|灰色・高失点スート/);
  assert.match(html,/\.playing-card\.apple \.rank[^\n]*#c31f36/);
  assert.match(html,/\.playing-card\.corn \.rank[^\n]*#7d5a00/);
  assert.match(html,/\.playing-card\.cabbage \.rank[^\n]*#176b34/);
  assert.match(html,/\.playing-card\.mud \.rank[^\n]*#4f5960/);
  assert.doesNotMatch(html,/[♥♦♣♠]/);
  assert.doesNotMatch(html,/ピックされた最弱.{0,20}\+3点/);
  assert.doesNotMatch(source,/ピックされた最弱.{0,20}\+3点/);
  assert.doesNotMatch(html,/id="pickStatus"/);
  assert.match(html,/querySelector\('\[data-pick-status\]'\)/);

  // Gameplay-only and responsive contracts stay present while the rule UI changes.
  assert.match(html,/body\.gameplay-mode #lobby\{display:none/);
  assert.match(html,/height:100dvh/);
  assert.match(html,/env\(safe-area-inset-bottom/);
  assert.match(html,/@media \(max-width: 640px\) and \(orientation: portrait\)/);
  assert.match(html,/@media \(max-height:520px\) and \(orientation:landscape\)/);
  assert.match(html,/@media \(prefers-reduced-motion:reduce\)/);
  assert.match(html,/\.scene-effects\{[^}]*pointer-events:none/);
}

console.log('default rules regression: all assertions passed');
