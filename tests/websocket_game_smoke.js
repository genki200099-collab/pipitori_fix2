'use strict';

const assert = require('assert');
const path = require('path');
const {spawn} = require('child_process');
const WebSocket = require('ws');

const root = path.resolve(__dirname, '..');
const port = 32000 + (process.pid % 20000);
const startedAt = Date.now();
const deadlineMs = 300000;
const serverErrors = [];
const phases = new Set();
const seenCommentEvents = new Set();
const seenCinematicEvents = new Set();
const seenSuits = new Set();
const allowedSuits = new Set(['apple','corn','cabbage','mud']);
let humanPlays = 0;
let humanPicks = 0;
let humanTargetSelections = 0;
let humanPairChoices = 0;
let ws;
let finished = false;
let lastPlayKey = '';
let lastTargetKey = '';
let lastPickKey = '';
let lastPairKey = '';

const child = spawn(process.execPath, ['server.js'], {
  cwd:root,
  env:{...process.env, PORT:String(port)},
  stdio:['ignore','pipe','pipe']
});

child.stderr.on('data', chunk=>serverErrors.push(String(chunk)));
child.on('exit', code=>{
  if(!finished && code !== null) fail(new Error(`server exited before finish: ${code}`));
});

const timer = setTimeout(()=>fail(new Error(`smoke test timed out after ${deadlineMs}ms`)), deadlineMs);

function stop(){
  clearTimeout(timer);
  if(ws && ws.readyState < WebSocket.CLOSING) ws.close();
  if(!child.killed) child.kill('SIGTERM');
}

function fail(error){
  if(finished) return;
  finished = true;
  stop();
  console.error(error.stack || error);
  if(serverErrors.length) console.error(serverErrors.join(''));
  process.exitCode = 1;
}

function send(message){
  if(ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function handleState(state){
  phases.add(state.phase);
  for(const item of state.commentary || []) if(item?.eventKey) seenCommentEvents.add(item.eventKey);
  const visibleCards=[...(state.trick || []).map(x=>x.card),...((state.players?.[state.yourIndex]?.hand) || [])];
  for(const card of visibleCards){
    if(!card || card.joker) continue;
    assert.ok(allowedSuits.has(card.suit),`unexpected suit: ${card.suit}`);
    seenSuits.add(card.suit);
  }
  if(state.leadSuit != null) assert.ok(allowedSuits.has(state.leadSuit),`unexpected lead suit: ${state.leadSuit}`);

  assert.strictEqual(state.penaltyMode, 'mud6');
  assert.strictEqual(state.pickTargetCount, 2);
  assert.strictEqual(state.shootThePigEnabled, true);
  assert.strictEqual(state.shootThePigLimit, 'unlimited');
  assert.strictEqual(state.shootThePigPerPlayerLimit, null);
  assert.ok((state.players || []).every(p=>typeof p.shootUsed === 'boolean'));
  if(state.shootPigEvent){ assert.ok(state.shootPigEvent.id); seenCinematicEvents.add('shoot'); }
  if(state.madPigEvent){
    assert.ok(state.madPigEvent.id && state.madPigEvent.card?.suit==='mud' && String(state.madPigEvent.card?.rank)==='11');
    seenCinematicEvents.add(`mad-${state.madPigEvent.source}`);
  }
  if(state.pairCleanEvent){
    assert.ok(state.pairCleanEvent.id && state.pairCleanEvent.rank);
    if(state.pairCleanEvent.source==='initial') assert.strictEqual(state.pairCleanEvent.cards,null);
    else assert.strictEqual(state.pairCleanEvent.cards?.length,2);
    seenCinematicEvents.add(`pair-${state.pairCleanEvent.source}`);
  }
  if(state.pendingPick?.result){
    assert.ok(state.pendingPick.result.eventId,'pick result needs a stable cinematic event ID');
    if(state.pendingPick.result.drawn?.joker) seenCinematicEvents.add('baba');
  }

  if(state.phase === 'lobby'){
    if(state.players.length < 4) send({type:'addCpu'});
    else send({type:'start'});
    return;
  }

  if(state.phase === 'roundEnd'){
    send({type:'continueRound'});
    return;
  }

  if(state.phase === 'playing'){
    const pp = state.pendingPick;
    if(pp?.targetSelectionRequired && !pp.targetSelectionDone && pp.pickProviderPid === state.yourIndex){
      const count = Math.min(pp.targetCandidateCount || 0, pp.targetSelectableCardIds?.length || 0);
      const ids = (pp.targetSelectableCardIds || []).slice(0, count);
      const key = `${pp.readyAt}:${ids.join(',')}`;
      if(ids.length && key !== lastTargetKey){
        lastTargetKey = key;
        humanTargetSelections++;
        send({type:'pickTargets', cardIds:ids});
      }
      return;
    }
    if(pp?.pairChoice && pp.pickerPid === state.yourIndex){
      const key = String(pp.pairChoice.drawn?.id || pp.readyAt);
      if(key !== lastPairKey){
        lastPairKey = key;
        humanPairChoices++;
        send({type:'pairChoice', skip:true});
      }
      return;
    }
    if(pp && !pp.result && pp.pickerPid === state.yourIndex && pp.ready){
      const key = String(pp.readyAt);
      if(key !== lastPickKey){
        lastPickKey = key;
        humanPicks++;
        send({type:'pick', index:0});
      }
      return;
    }
    if(state.isYourTurn && state.playableCardIds?.length){
      const cardId = state.playableCardIds[0];
      const key = `${state.round}:${state.trick?.length || 0}:${cardId}:${state.players[state.yourIndex]?.handCount}`;
      if(key !== lastPlayKey){
        lastPlayKey = key;
        humanPlays++;
        send({type:'play', cardId});
      }
    }
    return;
  }

  if(state.phase === 'finished'){
    assert.strictEqual(state.players.length, 4);
    assert.ok(state.players.every(p=>p.final && Number.isFinite(p.final.total)));
    assert.ok(phases.has('lobby') && phases.has('playing'));
    assert.ok(humanPlays > 0, 'human should have played at least one card');
    assert.ok(seenSuits.size >= 3,`expected at least three flavored suits, saw ${[...seenSuits]}`);
    assert.strictEqual(serverErrors.join('').trim(), '');
    finished = true;
    stop();
    console.log(JSON.stringify({
      result:'passed',
      elapsedMs:Date.now()-startedAt,
      phases:[...phases],
      humanPlays,
      humanPicks,
      humanTargetSelections,
      humanPairChoices,
      commentEvents:[...seenCommentEvents].sort(),
      cinematicEvents:[...seenCinematicEvents].sort(),
      seenSuits:[...seenSuits].sort(),
      totals:state.players.map(p=>p.final.total)
    }));
  }
}

child.stdout.on('data', chunk=>{
  const line = String(chunk);
  if(!ws && line.includes('server listening')){
    ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on('open', ()=>send({type:'create', name:'SmokeTester', rounds:1}));
    ws.on('message', raw=>{
      try {
        const message = JSON.parse(String(raw));
        if(message.type === 'errorMsg') throw new Error(message.message);
        if(message.type === 'state') handleState(message.state);
      } catch(error){ fail(error); }
    });
    ws.on('error', fail);
  }
});
