'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const { PERSONA_PROFILES, createPersonaLine, getSpotlightPresentation } = require('./cpu_personality_dialogue');
const { chooseSpotlightCandidate } = require('./spotlight_priority');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATIC_CONTENT_TYPES = {
  '.html':'text/html; charset=utf-8',
  '.css':'text/css; charset=utf-8',
  '.js':'text/javascript; charset=utf-8',
  '.json':'application/json; charset=utf-8',
  '.webmanifest':'application/manifest+json; charset=utf-8',
  '.png':'image/png',
  '.jpg':'image/jpeg',
  '.jpeg':'image/jpeg',
  '.webp':'image/webp',
  '.svg':'image/svg+xml',
  '.ico':'image/x-icon',
  '.woff':'font/woff',
  '.woff2':'font/woff2'
};

const server = http.createServer((req, res) => {
  let filePath = req.url.split('?')[0];
  if (filePath === '/' || filePath === '') filePath = '/index.html';
  const safe = path.normalize(filePath).replace(/^([.][.][/\\])+/, '');
  const abs = path.join(PUBLIC_DIR, safe);
  if (!abs.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(abs, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(abs).toLowerCase();
    const type = STATIC_CONTENT_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type':type,
      'X-Content-Type-Options':'nosniff',
      'Cache-Control':ext === '.html' ? 'no-cache' : 'public, max-age=3600'
    }); res.end(data);
  });
});

const wss = new WebSocket.Server({ server, maxPayload:64 * 1024 });
const rooms = new Map();

// Render を含む実運用で、端末のスリープや回線切替により TCP 接続だけが
// 半開きで残ることがある。サーバー側からも生存確認し、切断を確実に検知する。
function positiveDuration(value, fallback, minimum=100){
  const parsed=Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? Math.floor(parsed) : fallback;
}
const WS_HEARTBEAT_INTERVAL_MS = positiveDuration(process.env.WS_HEARTBEAT_INTERVAL_MS, 20 * 1000);
const WS_HEARTBEAT_MAX_MISSES = Math.max(2, Math.min(6, Number(process.env.WS_HEARTBEAT_MAX_MISSES) || 3));
const DISCONNECTED_ACTION_GRACE_MS = positiveDuration(process.env.DISCONNECTED_ACTION_GRACE_MS, 45 * 1000);
const ROUND_END_AUTO_CONTINUE_MS = positiveDuration(process.env.ROUND_END_AUTO_CONTINUE_MS, 45 * 1000);
const ROOM_EMPTY_TTL_MS = positiveDuration(process.env.ROOM_EMPTY_TTL_MS, 10 * 60 * 1000);
const SPOTLIGHT_DISPLAY_MS = 2200;
// 通常進行と重要演出を同じ待機時間で扱わない。ゲーム状態は各演出の完了を
// 待たずにサーバーで確定し、ここでは表示の読みやすさだけを調整する。
const GAME_TIMING = Object.freeze({
  trickReview:2800,
  pickPrepare:1250,
  pickTargetConfirm:700,
  cpuPlay:700,
  cpuTargetSelect:520,
  cpuPairChoice:760,
  normalPickResult:2350,
  pairPickResult:4500,
  madPickResult:5000,
  babaPickResult:5600,
  failSafeExtra:4500
});
const MAX_WS_MESSAGE_BYTES = 64 * 1024;
const MAX_SPECTATORS_PER_ROOM = 12;
const DUPLICATE_ACTION_WINDOW_MS = 160;
// 二重実行でカードや状態を壊し得る不可逆操作だけを短時間重複除外する。
// addCpu/removeCpu は1回ごとに座席数が変わる正当な反復操作なので含めない。
const DEDUPED_CLIENT_ACTION_TYPES = new Set(['start','rematch','clearRoom','play','pick','pickTargets','pairChoice','passThree','initialPairDiscard','skipInitialPairs','continueRound']);
const GAMEPLAY_ACTION_TYPES = new Set(['play','pick','pickTargets','pairChoice','passThree','initialPairDiscard','skipInitialPairs','continueRound']);


// 同じ目的の短時間タスクをキーで一元管理し、再送や監視処理からの重複予約を防ぐ。
function transientTaskStore(room){
  if(!room) return null;
  if(!(room.transientTimers instanceof Map)) room.transientTimers=new Map();
  return room.transientTimers;
}
function scheduleRoomTask(room, key, delayMs, task, {replace=false}={}){
  const store=transientTaskStore(room);
  if(!store || !key || typeof task!=='function') return null;
  if(store.has(key)){
    if(!replace) return store.get(key);
    clearTimeout(store.get(key));
    store.delete(key);
  }
  const handle=setTimeout(()=>{
    if(store.get(key)!==handle) return;
    store.delete(key);
    try{ task(); }catch(error){ console.error(`room task failed: ${key}`,error); }
  },Math.max(0,Number(delayMs)||0));
  handle.unref?.();
  store.set(key,handle);
  return handle;
}
function clearTransientRoomTasks(room){
  const store=room?.transientTimers;
  if(!(store instanceof Map)) return;
  for(const handle of store.values()) clearTimeout(handle);
  store.clear();
}

const wsHeartbeatTimer = setInterval(()=>{
  for(const client of wss.clients){
    if(client.isAlive === false) client.missedHeartbeats = Number(client.missedHeartbeats || 0) + 1;
    else client.missedHeartbeats = 0;

    // モバイル回線切替・Safariの一時停止・Render側の瞬間的な遅延で、
    // 1回だけpongが遅れた接続を即座に切らない。複数回連続で応答がない時だけ切断する。
    if(client.missedHeartbeats >= WS_HEARTBEAT_MAX_MISSES){
      try { client.terminate(); } catch(e) {}
      continue;
    }
    client.isAlive = false;
    try { client.ping(); } catch(e) {}
  }
}, WS_HEARTBEAT_INTERVAL_MS);
wsHeartbeatTimer.unref?.();
wss.on('close', ()=>clearInterval(wsHeartbeatTimer));

// 進行停止監視。タイマーが不発になった場合でも、待機状態を定期的に拾って進める。
const progressWatchdogTimer=setInterval(()=>{
  for(const room of rooms.values()){
    try { ensureRoomProgress(room); } catch(e) { console.error('progress watchdog error', e); }
  }
}, 1000);
progressWatchdogTimer.unref?.();
wss.on('close',()=>clearInterval(progressWatchdogTimer));


const SUIT_DEFINITIONS = Object.freeze({
  apple:{id:'apple', name:'リンゴ', icon:'🍎', color:'red'},
  corn:{id:'corn', name:'トウモロコシ', icon:'🌽', color:'yellow'},
  cabbage:{id:'cabbage', name:'キャベツ', icon:'🥬', color:'green'},
  mud:{id:'mud', name:'泥', icon:'💧', color:'gray'}
});
const suits = ['apple','corn','cabbage','mud'];
const MUD_SUIT = 'mud';
const HUMAN_ANIMAL_IDENTITIES = Object.freeze([
  Object.freeze({name:'子ブタ',avatar:'🐷'}),
  Object.freeze({name:'子ネコ',avatar:'🐱'}),
  Object.freeze({name:'子イヌ',avatar:'🐶'}),
  Object.freeze({name:'子ウサギ',avatar:'🐰'}),
  Object.freeze({name:'子ギツネ',avatar:'🦊'}),
  Object.freeze({name:'子タヌキ',avatar:'🦝'}),
  Object.freeze({name:'子パンダ',avatar:'🐼'}),
  Object.freeze({name:'子コアラ',avatar:'🐨'}),
  Object.freeze({name:'子トラ',avatar:'🐯'}),
  Object.freeze({name:'子ライオン',avatar:'🦁'}),
  Object.freeze({name:'子サル',avatar:'🐵'}),
  Object.freeze({name:'子クマ',avatar:'🐻'}),
  Object.freeze({name:'子シカ',avatar:'🦌'}),
  Object.freeze({name:'子リス',avatar:'🐿️'}),
  Object.freeze({name:'子ヒツジ',avatar:'🐑'}),
  Object.freeze({name:'子ヤギ',avatar:'🐐'})
]);
function suitDefinition(suit){ return SUIT_DEFINITIONS[suit] || {id:String(suit || ''), name:String(suit || ''), icon:'?', color:'gray'}; }
function suitName(suit){ return suitDefinition(suit).name; }
function suitIcon(suit){ return suitDefinition(suit).icon; }
function suitDisplay(suit){ const def=suitDefinition(suit); return def.id === MUD_SUIT ? def.icon : `${def.icon} ${def.name}`; }
const ranks = ['1','2','3','4','5','6','7','8','9','10','11','12','13'];
let deckSerial = 0; // 次ラウンド補充時もカードIDが重複しないようにする。
const value = Object.fromEntries(ranks.map(r=>[r, Number(r)]));

function code(){
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s=''; for(let i=0;i<4;i++) s += chars[Math.floor(Math.random()*chars.length)];
  return rooms.has(s) ? code() : s;
}
function uid(){ return crypto.randomBytes(8).toString('hex'); }
function newResumeToken(){ return crypto.randomBytes(24).toString('hex'); }
function resumeTokenMatches(expected, provided){
  const a=Buffer.from(String(expected || ''), 'utf8');
  const b=Buffer.from(String(provided || ''), 'utf8');
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}
function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }
function makeDeck(){
  let deck=[]; let id=0;
  const serial = deckSerial++;
  for(const s of suits) for(const r of ranks) deck.push({id:`D${serial}-${s}-${r}-${id++}`,faceKey:`${s}:${r}`,suit:s,rank:r,val:value[r],joker:false});
  deck.push({id:`D${serial}-JOKER-${id++}`,faceKey:'JOKER',suit:null,rank:'JOKER',val:0,joker:true});
  return deck;
}

function cardFaceKey(card){
  if(!card) return 'NULL';
  if(card.faceKey) return card.faceKey;
  if(card.joker) return 'JOKER';
  return `${card.suit}:${card.rank}`;
}

function isMadPig(card){
  return !!card && !card.joker && card.suit===MUD_SUIT && card.rank==='11';
}

// 演出はクライアントだけの推測にせず、ゲーム状態と同じイベントIDを全員へ配る。
// これにより再接続や定期再送があっても同じ演出を何度も再生しない。
function registerMadPigEvent(room, ownerPid, card, source='pick'){
  if(!room || room.madPigEnabled === false || !isMadPig(card)) return null;
  const event={
    id:`mad-${room.round || 1}-${ownerPid}-${uid()}`,
    round:room.round || 1,
    ownerPid,
    ownerName:room.players?.[ownerPid]?.name || '',
    card,
    source:source === 'trick' ? 'trick' : 'pick',
    expiresAt:Date.now()+4800
  };
  room.madPigEvent=event;
  return event;
}

function registerPairCleanEvent(room, playerPid, cards, source='pick', revealCards=true){
  if(!room || !Array.isArray(cards) || cards.length !== 2) return null;
  const rank=String(cards[0]?.rank || cards[1]?.rank || '');
  const event={
    id:`pair-${room.round || 1}-${playerPid}-${uid()}`,
    round:room.round || 1,
    playerPid,
    playerName:room.players?.[playerPid]?.name || '',
    rank,
    cards:revealCards ? cards : null,
    // 非公開の開始時ペアでは、マッドを含むかどうかも追加情報になるため伏せる。
    containsMadPig:revealCards && room.madPigEnabled !== false && cards.some(isMadPig),
    source:source === 'initial' ? 'initial' : 'pick',
    expiresAt:Date.now()+4200
  };
  room.pairCleanEvent=event;
  return event;
}

function pickResultDisplayMs(room, result){
  // 専用演出の後に中央セリフを必ず2.2秒表示し、退場アニメーションまで
  // 次のトリック開始前に完了させるため、結果確認区間も経路別に確保する。
  if(result?.drawn?.joker) return GAME_TIMING.babaPickResult;
  if(result?.paired) return GAME_TIMING.pairPickResult;
  if(room?.madPigEnabled !== false && isMadPig(result?.drawn)) return GAME_TIMING.madPickResult;
  return GAME_TIMING.normalPickResult;
}


function spotlightDurationMs(){
  return SPOTLIGHT_DISPLAY_MS;
}

function spotlightTimingAfterPick(room, drawn, paired=false){
  // どの経路でも画像付き中央セリフの実表示時間は2.2秒で統一する。
  // 専用演出の開始待ちだけを場面ごとに変え、セリフの可読時間は変えない。
  if(drawn?.joker) return {delayMs:3100,durationMs:SPOTLIGHT_DISPLAY_MS};
  if(paired) return {delayMs:1950,durationMs:SPOTLIGHT_DISPLAY_MS};
  if(room?.madPigEnabled !== false && isMadPig(drawn)) return {delayMs:2450,durationMs:SPOTLIGHT_DISPLAY_MS};
  return {delayMs:100,durationMs:SPOTLIGHT_DISPLAY_MS};
}

function registerSpotlightEvent(room, payload){
  if(!room || !payload || !payload.text) return null;
  const durationMs = Math.max(800, Math.min(4500, Number(payload.durationMs) || 2600));
  const delayMs = Math.max(0, Math.min(5000, Number(payload.delayMs) || 0));
  const startsAt = Date.now() + delayMs;
  const event = {
    id: payload.id || `spotlight-${room.round || 1}-${payload.speakerPid ?? 'cpu'}-${uid()}`,
    speakerPid: payload.speakerPid,
    speakerName: payload.speakerName || '',
    cpuKey: payload.cpuKey || null,
    text: payload.text,
    emotion: payload.emotion || 'normal',
    portraitPath: payload.portraitPath || null,
    bubbleStyle: payload.bubbleStyle || 'normal',
    animation: payload.animation || 'slide-up',
    priority: Number(payload.priority || 0),
    selectionScore: Number(payload.selectionScore || 0),
    eventType: payload.eventType || 'normal',
    source: payload.source || 'trick',
    createdAt: Date.now(),
    startsAt,
    expiresAt: startsAt + durationMs,
    durationMs,
    delayMs
  };
  room.spotlightEvent = event;
  room.lastSpotlightSpeakerPid = Number.isInteger(payload.speakerPid) ? payload.speakerPid : null;
  room.spotlightHistory = Array.isArray(room.spotlightHistory) ? room.spotlightHistory : [];
  room.spotlightHistory.unshift({pid:event.speakerPid,eventType:event.eventType,round:room.round || 1,at:event.createdAt});
  room.spotlightHistory = room.spotlightHistory.slice(0,12);
  room.spotlightRoundCounts = room.spotlightRoundCounts || {};
  room.spotlightRoundCounts[event.speakerPid] = Number(room.spotlightRoundCounts[event.speakerPid] || 0) + 1;
  return event;
}

function chooseSpotlightPlan(room, plans){
  return chooseSpotlightCandidate(room, plans, Math.random);
}

function triggerSpotlight(room, plans, options={}){
  const plan = chooseSpotlightPlan(room, plans);
  if(!plan) return null;
  return registerSpotlightEvent(room, Object.assign({}, plan, {
    eventType: options.eventType || plan.eventType || 'normal',
    source: options.source || plan.source || 'trick',
    durationMs: options.durationMs || spotlightDurationMs(plan),
    delayMs: options.delayMs || 0
  }));
}

function spotlightPlan(room, pid, type, ctx, meta={}){
  const plan=cpuSpotlightPlanFor(room,pid,type,Object.assign({},ctx,meta));
  return plan ? Object.assign({eventType:type},plan,meta) : null;
}

function spotlightPlansAfterTrick(room, winnerPid, weakestPid, winnerCard, weakestCard, options={}){
  const wp=room?.players?.[winnerPid];
  const lp=room?.players?.[weakestPid];
  if(!wp || !lp) return [];
  const cpuPids=(room.players || []).map((p,i)=>p?.cpu ? i : -1).filter(i=>i>=0);
  const dramaticMad=options.capturedMadPig === true;
  const base={
    winner:wp.name, weakest:lp.name, target:lp.name, card:winnerCard,
    actorPid:winnerPid, affectedPid:weakestPid, targetPid:weakestPid,
    drama:dramaticMad ? 28 : 6
  };
  const plans=[];
  if(wp.cpu){
    const type=dramaticMad ? 'madPig' : 'trickWin';
    const plan=spotlightPlan(room,winnerPid,type,base,{role:'winner',relevance:dramaticMad?42:28});
    if(plan) plans.push(plan);
  }
  if(lp.cpu){
    const plan=spotlightPlan(room,weakestPid,'trickWeak',Object.assign({},base,{card:weakestCard,target:wp.name}),{role:'weakest',relevance:34});
    if(plan) plans.push(plan);
  }
  for(const pid of cpuPids){
    if(pid===winnerPid || pid===weakestPid) continue;
    const plan=spotlightPlan(room,pid,dramaticMad?'madPig':'watchDrama',Object.assign({},base,{target:lp.name}),{
      role:cpuCharacter(room.players[pid])?.key==='rikumodoki'?'analyst':'witness',
      relevance:dramaticMad?27:13
    });
    if(plan) plans.push(plan);
  }
  return plans;
}

function spotlightPlansAfterPick(room, pp, drawn, paired=false){
  if(!room || !pp || !drawn) return [];
  const roles=resolvedPickRoles(room,pp);
  const wp = room.players?.[roles.trickWinnerPid];
  const lp = room.players?.[roles.trickWeakestPid];
  const picker = room.players?.[roles.pickerPid];
  if(!wp || !lp) return [];
  const cpuPids = (room.players || []).map((p,i)=>p?.cpu ? i : -1).filter(i=>i >= 0);
  const otherCpuPids = cpuPids.filter(i=>i !== roles.pickerPid);
  const baseCtx = {
    winner: wp.name, weakest: lp.name, target: picker?.name || '', drawn, card: drawn,
    actorPid:roles.pickerPid, affectedPid:roles.pickerPid, targetPid:roles.pickProviderPid,
    picker:picker?.name || '', provider:room.players?.[roles.pickProviderPid]?.name || ''
  };
  const plans = [];

  if(drawn.joker){
    if(picker?.cpu){
      const plan=spotlightPlan(room,roles.pickerPid,'resultJoker',Object.assign({},baseCtx,{target:picker.name}),{role:'victim',relevance:55,drama:44,mustSpeak:true});
      if(plan) plans.push(plan);
    }
    otherCpuPids.forEach(i=>{
      const plan=spotlightPlan(room,i,'babaReveal',Object.assign({},baseCtx,{target:picker?.name,targetPid:roles.pickerPid}),{
        role:cpuCharacter(room.players[i])?.key==='rikumodoki'?'analyst':'witness',relevance:30,drama:40
      });
      if(plan) plans.push(plan);
    });
    return plans;
  }

  if(room.madPigEnabled !== false && isMadPig(drawn)){
    if(picker?.cpu){
      const type=paired ? 'resultPair' : 'madPig';
      const plan=spotlightPlan(room,roles.pickerPid,type,baseCtx,{role:'affected',relevance:paired?48:52,drama:38,mustSpeak:true});
      if(plan) plans.push(plan);
    }
    otherCpuPids.forEach(i=>{
      const plan=spotlightPlan(room,i,'madPig',Object.assign({},baseCtx,{target:picker?.name,targetPid:roles.pickerPid}),{
        role:cpuCharacter(room.players[i])?.key==='rikumodoki'?'analyst':'witness',relevance:29,drama:35
      });
      if(plan) plans.push(plan);
    });
    return plans;
  }

  if(paired){
    if(picker?.cpu){
      const plan=spotlightPlan(room,roles.pickerPid,'resultPair',baseCtx,{role:'actor',relevance:48,drama:24,mustSpeak:true});
      if(plan) plans.push(plan);
    }
    otherCpuPids.forEach(i=>{
      const plan=spotlightPlan(room,i,'pairClean',Object.assign({},baseCtx,{target:picker?.name,targetPid:roles.pickerPid}),{
        role:cpuCharacter(room.players[i])?.key==='rikumodoki'?'analyst':'witness',relevance:18,drama:18
      });
      if(plan) plans.push(plan);
    });
    return plans;
  }

  if(picker?.cpu){
    const plan=spotlightPlan(room,roles.pickerPid,'pickWin',baseCtx,{role:'actor',relevance:33,drama:8});
    if(plan) plans.push(plan);
  }
  otherCpuPids.forEach(i=>{
    const plan=spotlightPlan(room,i,'pickWatch',Object.assign({},baseCtx,{target:picker?.name,targetPid:roles.pickerPid}),{
      role:cpuCharacter(room.players[i])?.key==='rikumodoki'?'analyst':'witness',relevance:12,drama:5
    });
    if(plan) plans.push(plan);
  });
  return plans;
}

function cloneCardWithFreshId(card){
  if(!card) return null;
  if(card.joker) return {...card, faceKey:'JOKER', id:`D${deckSerial++}-JOKER-${Date.now()}-${Math.random().toString(16).slice(2)}`};
  return {...card, faceKey:`${card.suit}:${card.rank}`, id:`D${deckSerial++}-${card.suit}-${card.rank}-${Date.now()}-${Math.random().toString(16).slice(2)}`};
}



function collectActiveFaceKeys(room){
  const keys = new Set();
  if(!room || !room.players) return keys;

  // 次ラウンド補充の重複防止対象は、現在プレイ領域に残っているカード。
  // 得点パイル・ペア浄化済みカードは「得点/履歴」として保持し、補充山の重複制限からは外す。
  // ピック結果やペア候補は既に誰かの手札に含まれているため、ここでは重複登録しない。
  for(const p of room.players){
    for(const c of p.hand || []) keys.add(cardFaceKey(c));
  }
  for(const t of room.trick || []) keys.add(cardFaceKey(t.card));
  for(const c of room.stock || []) keys.add(cardFaceKey(c));

  return keys;
}





function assertUniqueActiveCards(room, context=''){
  const seen = new Map();
  const duplicates = [];
  function check(card, place){
    const key = cardFaceKey(card);
    if(key === 'NULL') return;
    if(seen.has(key)) duplicates.push(`${key}: ${seen.get(key)} / ${place}`);
    else seen.set(key, place);
  }

  if(room && room.players){
    for(const p of room.players){
      for(const c of p.hand || []) check(c, `${p.name}の手札`);
    }
  }
  for(const t of room?.trick || []) check(t.card, `場のカード:${t.pid}`);
  for(const c of room?.stock || []) check(c, '補充山');

  // 得点パイル・ペア浄化済みカードは得点/履歴として保持するため、
  // 次ラウンド補充カードとの同じ数字/スート重複はエラー扱いしない。
  // また、pendingPick.result / pairChoice は手札内カードへの参照なので二重チェックしない。
  if(duplicates.length){
    log(room, `⚠️ カード重複を検知しました${context ? '（'+context+'）' : ''}: ${duplicates.join(' / ')}`);
    return false;
  }
  return true;
}



function buildUniqueNormalRefillDeck(room){
  const active = collectActiveFaceKeys(room);
  const deck = [];
  for(const suit of suits){
    for(const rank of ranks){
      const base = {id:'', faceKey:`${suit}:${rank}`, suit, rank, val:value[rank], joker:false};
      if(!active.has(cardFaceKey(base))) deck.push(cloneCardWithFreshId(base));
    }
  }
  shuffle(deck);
  return deck;
}

function cardText(c){ return c.joker ? '🃏ババブタ' : `${c.rank} ${suitDisplay(c.suit)}`; }
function sortHand(h){
  h.sort((a,b)=>{
    if(a.joker) return 1; if(b.joker) return -1;
    const so = suits.indexOf(a.suit)-suits.indexOf(b.suit);
    if(so) return so;
    return b.val-a.val;
  });
}
function log(room, text){ room.log.unshift({time:new Date().toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit',second:'2-digit'}), text}); room.log = room.log.slice(0,80); }

function newMatchStats(){
  return {
    trickWins:0,weakestCount:0,feastCardsWon:0,feastPointsWon:0,
    pickProviderCount:0,pickerCount:0,receivedCards:[],transferredCards:[],
    babaReceived:0,babaTransferred:0,madReceived:0,madTransferred:0,
    pairCleans:0,pairDangerCards:0,shootCount:0,
    remainingHandCount:0,remainingHandPenalty:0,endgameTrickWins:0,
    highCardWins:0,efficientLowWins:0,voidCount:0,roundScores:[],finalScore:0,
    babaForcedCandidateCount:0,babaForcedTransferCount:0,
    shootBlockedByUnmovedBabaCount:0
  };
}

function matchStatsFor(player){
  if(!player) return newMatchStats();
  if(!player.matchStats) player.matchStats=newMatchStats();
  else{
    const defaults=newMatchStats();
    for(const [key,value] of Object.entries(defaults)){
      if(player.matchStats[key]===undefined) player.matchStats[key]=Array.isArray(value)?[]:value;
    }
  }
  return player.matchStats;
}

function matchCardSummary(room,card){
  return {
    id:String(card?.id || ''),label:cardText(card),rank:String(card?.rank || ''),
    val:Number(card?.val || 0),joker:!!card?.joker,mad:room?.madPigEnabled!==false && isMadPig(card)
  };
}

function publicMatchStats(stats){
  const source=stats || newMatchStats();
  const out={};
  for(const [key,value] of Object.entries(source)){
    out[key]=Array.isArray(value) ? value.map(item=>item && typeof item==='object' ? {...item} : item) : value;
  }
  return out;
}

function generatePlayEvaluation(room,player){
  const s=matchStatsFor(player);
  const comments=[];
  if(s.trickWins>0){
    comments.push(`トリック勝利${s.trickWins}回。ごちそう${s.feastCardsWon}枚・${s.feastPointsWon}点を集める収穫重視のプレイでした。`);
  }
  if(s.pairCleans>0){
    comments.push(`ペア浄化を${s.pairCleans}回成功${s.pairDangerCards?`し、危険度の高い札を${s.pairDangerCards}枚処理`:''}。手札整理が機能しました。`);
  }
  if(s.shootCount>0){
    comments.push(`シュート・ザ・ピッグを${s.shootCount}回成立。抱えた危険札を実際に逆転へつなげました。`);
  }
  if(comments.length<3 && s.shootBlockedByUnmovedBabaCount>0){
    comments.push(`ババブタとマッド・ピッグを揃えましたが、ババ未移動でシュート不成立が${s.shootBlockedByUnmovedBabaCount}回ありました。`);
  }
  if(comments.length<3 && s.babaForcedCandidateCount>0){
    comments.push(`強制候補ルールでババブタが${s.babaForcedCandidateCount}回候補入りし、${s.babaForcedTransferCount}回実際に移動しました。`);
  }
  if(comments.length<3 && (s.babaTransferred>0 || s.madTransferred>0)){
    const parts=[];
    const voluntaryBaba=Math.max(0,s.babaTransferred-s.babaForcedTransferCount);
    if(voluntaryBaba) parts.push(`自ら選んだババブタ${voluntaryBaba}回`);
    if(s.madTransferred) parts.push(`マッド・ピッグ${s.madTransferred}回`);
    if(parts.length) comments.push(`${parts.join('・')}を相手へ渡し、ピックで危険札を動かしました。`);
  }
  if(comments.length<3 && s.efficientLowWins>0){
    comments.push(`低いカードで効率よく${s.efficientLowWins}回勝利。強札を温存しながらごちそうを確保しました。`);
  }else if(comments.length<3 && s.highCardWins>0){
    comments.push(`高いカードを使った勝利が${s.highCardWins}回。勝ち切る場面を明確に選びました。`);
  }
  if(comments.length<3 && s.trickWins===0 && s.weakestCount>0){
    comments.push(`最弱${s.weakestCount}回。ピッカー${s.pickerCount}回・提供者${s.pickProviderCount}回として手札の流れに関わりました。`);
  }
  if(comments.length<3 && s.remainingHandPenalty>0){
    comments.push(`終了時は手札${s.remainingHandCount}枚・失点${s.remainingHandPenalty}点。ごちそうとの収支に改善余地が残りました。`);
  }
  const cpuKey=cpuCharacter(player)?.key;
  if(comments.length<3 && cpuKey==='kamomodoki' && (s.transferredCards.length>=3 || Math.max(0,s.babaTransferred-s.babaForcedTransferCount)>0)) comments.push('かももどきらしく、実績のある攻撃的なピックでした。');
  if(comments.length<3 && cpuKey==='wakumodoki' && s.highCardWins>=2) comments.push('ワクもどきらしく、高い札で大胆に勝負を取りにいきました。');
  if(comments.length<3 && cpuKey==='rikumodoki' && (s.pairCleans>=2 || s.efficientLowWins>=2)) comments.push('リクもどきらしく、浄化と効率を両立した工程管理型のプレイでした。');
  if(!comments.length){
    comments.push(`フォロー不能${s.voidCount}回、終了時の手札${s.remainingHandCount}枚。今回は手札維持を中心に進みました。`);
  }
  return comments.slice(0,3).map(text=>[...text].slice(0,92).join(''));
}

const CPU_COMMENT_PRESENTATIONS = {
  greeting:{mood:'intro',intensity:'soft',icon:'👋',label:'参戦'},
  'round-start':{mood:'hype',intensity:'strong',icon:'🎬',label:'ROUND START'},
  'card-play':{mood:'calm',intensity:'medium',icon:'🃏',label:'CARD PLAY'},
  'card-danger':{mood:'danger',intensity:'strong',icon:'⚠️',label:'危険札'},
  'shoot-threat':{mood:'scheme',intensity:'critical',icon:'🌕',label:'コンボ気配'},
  shoot:{mood:'hype',intensity:'critical',icon:'🌕',label:'SHOOT THE PIG'},
  endgame:{mood:'hype',intensity:'strong',icon:'🔥',label:'終盤'},
  'trick-win':{mood:'victory',intensity:'strong',icon:'👑',label:'TRICK WIN'},
  'trick-weak':{mood:'danger',intensity:'strong',icon:'💀',label:'最弱'},
  watch:{mood:'analysis',intensity:'medium',icon:'👀',label:'観戦'},
  'target-select':{mood:'scheme',intensity:'strong',icon:'🎯',label:'候補選択'},
  pick:{mood:'suspense',intensity:'strong',icon:'🐽',label:'PICK'},
  baba:{mood:'shock',intensity:'critical',icon:'🃏',label:'ババブタ'},
  pair:{mood:'relief',intensity:'strong',icon:'✨',label:'ペア浄化'},
  'round-end':{mood:'summary',intensity:'strong',icon:'🏁',label:'ROUND END'},
  finish:{mood:'victory',intensity:'critical',icon:'🏆',label:'FINISH'},
  default:{mood:'calm',intensity:'medium',icon:'💬',label:'COMMENT'}
};

function safeCommentToken(value, fallback){
  const token = String(value || '');
  return /^[a-z0-9-]{1,24}$/i.test(token) ? token : fallback;
}
function commentPresentation(text, meta={}){
  let eventKey = safeCommentToken(meta.eventKey, 'default');
  const line = String(text || '');
  if(eventKey === 'default'){
    if(line.includes('ババブタ') && (line.includes('引') || line.includes('直撃'))) eventKey = 'baba';
    else if(line.includes('ペア') || line.includes('浄化')) eventKey = 'pair';
    else if(line.includes('勝者') || line.includes('勝った')) eventKey = 'trick-win';
    else if(line.includes('最弱')) eventKey = 'trick-weak';
    else if(line.includes('ピック')) eventKey = 'pick';
  }
  const base = CPU_COMMENT_PRESENTATIONS[eventKey] || CPU_COMMENT_PRESENTATIONS.default;
  const intensity = safeCommentToken(meta.intensity, base.intensity);
  const priority=intensity==='critical'?3:intensity==='strong'?2:1;
  const chars=[...line].length;
  const readableMs=chars<=16?2800:chars<=32?3600:4700;
  const ttl = Number.isFinite(Number(meta.durationMs))
    // 旧演出が指定していた10秒超の寿命も、実況だけが長く居座らない範囲へ収める。
    // 演出本体の表示時間やゲーム進行タイマーとは独立している。
    ? Math.max(readableMs, Math.min(6500, Number(meta.durationMs)))
    : Math.max(readableMs,priority===3?4800:priority===2?3800:2800);
  return {
    eventKey,
    mood:safeCommentToken(meta.mood, base.mood),
    intensity,
    icon:String(meta.icon || base.icon).slice(0,8),
    label:String(meta.label || base.label).slice(0,24),
    durationMs:ttl,
    minimumVisibleMs:Math.min(ttl,readableMs),
    priority
  };
}

function compactCpuComment(text, eventKey='default'){
  let line = String(text || '').replace(/\s+/g, ' ').trim();
  if(!line) return '';

  // 実況レールでは話者名が別表示されるため、呼びかけを省いて要点を残す。
  line = line
    .replace(/^[^、。！？]{1,16}さん[、，]\s*/, '')
    .replace(/^[^、。！？]{1,16}さんの袋から/, '袋から')
    .replace(/^[^、。！？]{1,16}さんを/, '')
    .replace(/^[^、。！？]{1,16}さん方面へ[、，]?\s*/, '')
    .replace(/💧スートは失点が重いです。[ ]*/g, '')
    .replace(/ぬかるみスートは失点が重いです。[ ]*/g, '')
    .replace(/危険札と手札枚数を再点検します。?/g, '危険札を再点検します。')
    .replace(/ピック工程に入ります。?/g, '1枚ピックします。')
    .replace(/裏向きで1枚選びます。1枚ピックします。/g, '裏向きで1枚ピックします。')
    .replace(/候補選定に入ります。?/g, '候補を選びます。')
    .replace(/進捗を止めません。?/g, '進めます。')
    .replace(/締切内に決めます。?/g, 'すぐ決めます。')
    .replace(/^ごめん[！!、，\s]*/g, '')
    .replace(/自由なら大胆にいくぞぉ〜/g, '大胆にいくぞぉ〜')
    .replace(/私なら当たりを引ける/g, '当たりを引くぞぉ〜')
    .replace(/想定外ですが処理します/g, '想定外ですが対応します')
    .replace(/ここからは一手の影響が大きいです/g, '一手の影響が大きいです')
    .replace(/そのピック、めちゃくちゃ盛り上がる気がする/g, 'そのピック、盛り上がりそう！')
    .replace(/ここで取ったら盛り上がるよね？ 取ります/g, 'ここは取ります！')
    .replace(/丸メガネは見えてます。未来が！/g, '未来が見えてます！')
    .replace(/計画を更新します。?/g, '計画更新です。')
    .replace(/議事録に残します。?/g, '記録します。')
    .replace(/リカバリープランを立てます。?/g, '立て直します。')
    .replace(/\s+([、。！？])/g, '$1')
    .trim();

  // 危険な💧札は、カード情報を最優先して一目で読める文へまとめる。
  if(['card-danger','mud-penalty'].includes(eventKey) || line.includes('失点が重い')){
    const mud = line.match(/(?:^|\s)(\d{1,2})\s*💧|💧\s*(\d{1,2})/);
    const val = mud && (mud[1] || mud[2]);
    if(val) return `💧${val}を処理します。`;
  }

  const eventFallbacks = {
    pick:'裏向きで1枚ピックします。',
    watch:'ピックを見届けます。',
    'target-select':'候補を選びます。',
    'pair-clean':'ペア浄化します。',
    'round-end':'ラウンド終了です。',
    reconnect:'接続を確認します。'
  };

  const chars = [...line];
  const MAX = 24;
  if(chars.length <= MAX) return line;

  // 完結した短い文が先頭にあれば、途中で切らずその文を採用する。
  const sentences = line.match(/[^。！？]+[。！？]/g) || [];
  const complete = sentences.find(part => [...part].length >= 7 && [...part].length <= MAX);
  if(complete) return complete.trim();

  if(eventFallbacks[eventKey]) return eventFallbacks[eventKey];

  // 人格を表す短い語尾は可能な範囲で残す。
  const suffix = line.includes('✊🏻') ? '✊🏻' : line.endsWith('♡') ? '♡' : '';
  const budget = Math.max(8, MAX - [...suffix].length - 1);
  const clipped = chars.slice(0, budget).join('').replace(/[、，\s]+$/,'');
  return `${clipped}…${suffix}`;
}

function say(room, pid, text, meta={}){
  const p = room.players[pid]; if(!p || !text) return;
  const ch = cpuCharacter(p);
  const presentation = commentPresentation(text, meta);
  const createdAt=Date.now();
  const item = {
    pid,
    name:p.name,
    text,
    compactText:compactCpuComment(text, presentation.eventKey),
    cpuKey: ch?.key || null,
    avatar: cpuAvatar(p),
    avatarImage: ch?.imagePath || null,
    eventKey:presentation.eventKey,
    mood:presentation.mood,
    intensity:presentation.intensity,
    icon:presentation.icon,
    label:presentation.label,
    priority:presentation.priority,
    createdAt,
    minimumVisibleUntil:createdAt+presentation.minimumVisibleMs,
    expiresAt: createdAt+presentation.durationMs
  };
  p.lastComment = item;
  room.commentary = room.commentary || [];
  room.commentary.unshift(item);
  room.commentary = room.commentary.slice(0,8);
  log(room, `💬 ${p.name}「${text}」`);
}



function isEmptyHand(p){
  return !!p && Array.isArray(p.hand) && p.hand.length === 0;
}
function isJokerOnlyHand(p){
  return !!p && Array.isArray(p.hand) && p.hand.length === 1 && p.hand[0] && p.hand[0].joker;
}
function isRoundEndHand(p){
  return isEmptyHand(p) || isJokerOnlyHand(p);
}

function activePlayerCount(room){
  return room.players ? room.players.length : 0;
}
function safeBroadcast(room){
  try { broadcast(room); } catch(e) { console.error('safeBroadcast error', e); }
}


function safeFinishBecauseNoPlayable(room, pid){
  const p = room.players[pid];
  if(!p) return false;

  if(isJokerOnlyHand(p)){
    log(room, `🏁 ${p.name} の手番開始時、ババブタ1枚だけだったため、ラウンド終了処理へ進みます。`);
    room.pendingPick = null;
    room.trickReview = null;
    checkRoundEnd(room, pid);
    broadcast(room);
    return true;
  }

  if(isEmptyHand(p)){
    if(activeTrickInProgress(room)){
      rememberEndAfterTrick(room, pid);
      const alreadyPlayed = room.trick && room.trick.some(x=>x.pid===pid);
      if(alreadyPlayed){
        room.current = (pid + 1) % room.players.length;
        broadcast(room);
        return true;
      }
      // 異常状態で、まだ場に出していない空手札プレイヤーへ手番が来た場合、
      // 既に出ているカードを失わせず所有者へ戻してからラウンドを終了する。
      const interrupted = Array.isArray(room.trick) ? room.trick.slice() : [];
      log(room, `⚠️ ${p.name} がトリック途中で出せるカードを持たないため、場札を所有者へ戻してラウンド終了処理へ進みます。`);
      cancelCorruptTrick(room, interrupted, '空手札の手番がトリック途中に発生');
    } else {
      log(room, `🏁 ${p.name} の手札がなくなったため、ラウンド終了処理へ進みます。`);
    }
    room.pendingPick = null;
    room.trickReview = null;
    checkRoundEnd(room, pid);
    broadcast(room);
    return true;
  }
  return false;
}




const CPU_CHARACTERS = [
  {
    key:'kamomodoki',
    name:'かももどき',
    avatar:'🦆', imagePath:'/cpu_characters/kamomodoki.jpg',
    gender:'female',
    style:'attack',
    title:'駆け引き・挑発型',
    personality:PERSONA_PROFILES.kamomodoki.summary,
    catchphrase:'マストフォローは祝福です♡',
    motto:['人の不幸は蜜の味','下家のデスロード']
  },
  {
    key:'wakumodoki',
    name:'ワクもどき',
    avatar:'✊🏻', imagePath:'/cpu_characters/wakumodoki.jpg',
    gender:'female',
    style:'bold',
    title:'直感・大胆型',
    personality:PERSONA_PROFILES.wakumodoki.summary,
    catchphrase:'やるぞぉ〜✊🏻',
    motto:['できるぞぉ〜✊🏻','あたしゃ、魔神だよ…']
  },
  {
    key:'rikumodoki',
    name:'リクもどき',
    avatar:'📋', imagePath:'/cpu_characters/rikumodoki.png',
    gender:'male',
    style:'steady',
    title:'分析・堅実型',
    personality:PERSONA_PROFILES.rikumodoki.summary,
    catchphrase:'進捗確認します。',
    motto:['締切厳守','計画通りに進めましょう']
  }
];

function cpuCharacterByName(name){
  return CPU_CHARACTERS.find(c=>c.name===name) || null;
}
function cpuCharacter(player){
  if(!player || !player.cpu) return null;
  return player.cpuCharacter || cpuCharacterByName(player.name) || null;
}
function cpuAvatar(player){
  return cpuCharacter(player)?.avatar || '🐷';
}

function cleanName(n){
  const normalized = String(n || '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g,' ')
    .replace(/\s+/g,' ')
    .trim();
  return Array.from(normalized).slice(0,12).join('');
}

function normalizeParticipantRole(role){
  return role === 'spectator' ? 'spectator' : 'player';
}

function humanParticipants(room){
  if(!room) return [];
  const players=(room.players || []).filter(p=>p && !p.cpu);
  const spectators=Array.isArray(room.spectators) ? room.spectators.filter(Boolean) : [];
  return [...players,...spectators];
}

function participantById(room, participantId){
  if(!room || !participantId) return null;
  return humanParticipants(room).find(p=>p.id===participantId) || null;
}

function participantForWs(room, ws){
  if(!room || !ws) return null;
  const participant=participantById(room, ws.participantId || ws.playerId);
  return participant && participant.ws===ws ? participant : null;
}

function connectedHumanPlayers(room){
  return (room?.players || []).filter(p=>p && !p.cpu && isOpenWs(p.ws));
}

function createHumanParticipant(room, requestedName, ws, participantRole='player'){
  const role=normalizeParticipantRole(participantRole);
  const identity=assignHumanIdentity(room,requestedName,role);
  const base={id:uid(),resumeToken:newResumeToken(),name:identity.name,avatar:identity.avatar,ws,cpu:false,participantRole:role,disconnectedAt:null};
  if(role==='spectator') return base;
  return {...base,hand:[],scorePile:[],pairs:[],completedRoundCardScoreBank:0,jokerPenaltyBank:0,shootPigPenaltyBank:0,shootPigActivatedRounds:[],out:false,matchStats:null};
}

function assignHumanIdentity(room, requestedName, participantRole='player'){
  const cleaned = cleanName(requestedName);
  const humans = humanParticipants(room);
  const usedNames = new Set([...(room?.players || []),...(room?.spectators || [])].map(p=>p?.name).filter(Boolean));
  // 4席＋観戦上限ぶんの候補を用意し、役割をまたいでも既存参加者の絵文字を変更しない。
  const usedAvatars = new Set(humans.map(p=>p.avatar).filter(Boolean));

  let identity = null;
  if(!cleaned){
    identity = HUMAN_ANIMAL_IDENTITIES.find(item=>!usedNames.has(item.name) && !usedAvatars.has(item.avatar))
      || HUMAN_ANIMAL_IDENTITIES.find(item=>!usedNames.has(item.name));
  } else {
    identity = HUMAN_ANIMAL_IDENTITIES.find(item=>item.name===cleaned && !usedAvatars.has(item.avatar));
  }
  if(!identity) identity = HUMAN_ANIMAL_IDENTITIES.find(item=>!usedAvatars.has(item.avatar));
  if(!identity) identity = HUMAN_ANIMAL_IDENTITIES[humans.length % HUMAN_ANIMAL_IDENTITIES.length];

  let assignedName=cleaned || identity.name;
  if(!cleaned && usedNames.has(assignedName)){
    let suffix=2;
    while(usedNames.has(cleanName(`${identity.name}${suffix}`))) suffix++;
    assignedName=cleanName(`${identity.name}${suffix}`);
  }
  return {name:assignedName, avatar:identity.avatar};
}

function ensureHumanIdentities(room){
  if(!room || !Array.isArray(room.players)) return;
  const usedAvatars = new Set();
  for(const player of [...room.players,...(room.spectators || [])]){
    if(!player || player.cpu) continue;
    if(player.avatar && !usedAvatars.has(player.avatar)){
      usedAvatars.add(player.avatar);
      continue;
    }
    const matching = HUMAN_ANIMAL_IDENTITIES.find(item=>item.name===player.name && !usedAvatars.has(item.avatar));
    const identity = matching || HUMAN_ANIMAL_IDENTITIES.find(item=>!usedAvatars.has(item.avatar));
    player.avatar = identity?.avatar || '🐷';
    usedAvatars.add(player.avatar);
  }
}

function cpuIsMadPigCard(room, card){
  return !!(room && room.madPigEnabled !== false && card && !card.joker && card.suit===MUD_SUIT && card.rank==='11');
}
function cpuShootPotential(room, player){
  const state=shootEligibilityState(room,player);
  if(!state.eligibleNow) return false;
  if(shouldCheckShootThePigThisRound(room)) return true;
  // ババ失点がゲーム最後のみの場合、全シャッフルでは現在の2枚は次Rへ残らない。
  // その組合せでCPUが無意味に危険札を抱え込まないようにする。
  // 持ち越し方式では最終Rまで保持する戦略価値があるため、候補として維持する。
  return normalizeJokerPenaltyTiming(room?.jokerPenaltyTiming) === 'gameEnd'
    && normalizeRoundDealMode(room?.roundDealMode) === 'carryOver';
}
function cpuCardHandRisk(room, card){
  if(!card) return 0;
  if(card.joker) return room?.jokerPenalty ?? 20;
  const mode = normalizePenaltyMode(room?.penaltyMode);
  if(cpuIsMadPigCard(room, card)){
    return mode === 'faceValue' ? 40 : 13;
  }
  if(mode === 'faceValue') return Number(card.val || card.rank || 0);
  if(mode === 'mud6') return card.suit === MUD_SUIT ? 6 : 3;
  if(mode === 'mudSuit') return card.suit === MUD_SUIT ? 3 : 1;
  return 3;
}
function cpuHandRisk(room, player){
  return (player?.hand || []).reduce((sum,c)=>sum + cpuCardHandRisk(room, c), 0);
}
function cpuSuitCounts(player){
  const counts = Object.fromEntries(suits.map(suit=>[suit,0]));
  for(const c of player?.hand || []){
    if(c && !c.joker && counts[c.suit] !== undefined) counts[c.suit]++;
  }
  return counts;
}
function cpuCurrentLeadHigh(room){
  if(!room?.leadSuit) return 0;
  return (room.trick || []).filter(x=>x.card?.suit===room.leadSuit).reduce((m,x)=>Math.max(m, Number(x.card.val || 0)), 0);
}
function cpuWouldWinCurrentTrick(room, card){
  if(!room || !card || card.joker) return false;
  if(!room.leadSuit) return true;
  if(card.suit !== room.leadSuit) return false;
  return Number(card.val || 0) > cpuCurrentLeadHigh(room);
}

function cpuPersonalityWeights(player){
  const ch = cpuCharacter(player);
  // win:勝ちに行く度、dump:危険札処理度、risk:リスク回避度、chaos:揺らぎ、shoot:シュート狙い度、talk:発言頻度
  if(ch?.key === 'kamomodoki') return {win:1.36, dump:1.18, risk:0.74, chaos:.26, shoot:1.04, talk:.56};
  if(ch?.key === 'wakumodoki') return {win:1.14, dump:.95, risk:0.50, chaos:.72, shoot:1.52, talk:.62};
  if(ch?.key === 'rikumodoki') return {win:.68, dump:1.30, risk:1.46, chaos:.06, shoot:.70, talk:.46};
  return {win:1, dump:1, risk:1, chaos:.18, shoot:1, talk:.35};
}


function cpuCardPlayScore(room, pid, card){
  const player = room.players[pid];
  const ch = cpuCharacter(player);
  const w = cpuPersonalityWeights(player);
  const mode = normalizePenaltyMode(room.penaltyMode);
  const risk = cpuCardHandRisk(room, card);
  const isMad = cpuIsMadPigCard(room, card);
  const shoot = cpuShootPotential(room, player);
  const shootState=shootEligibilityState(room,player);
  const preserveMadForMove=shootState.needsBabaMove && ch?.key==='wakumodoki';
  const shootHold=shoot || preserveMadForMove;
  const nearShoot = cpuNearShootPotential(room, player);
  const counts = cpuSuitCounts(player);
  const suitCount = counts[card.suit] || 0;
  const lowCard = 14 - Number(card.val || 0);
  const highCard = Number(card.val || 0);
  const leadSuit = room.leadSuit;
  const handRisk = cpuHandRisk(room, player);
  let score = Math.random() * (8 + w.chaos * 25);

  // シュート・ザ・ピッグ狙い中は、発動条件に必要な手札のマッドをうっかり捨てない。
  // ごちそう山へ取ったマッドは発動条件にならないため、勝てる局面でも温存を優先する。
  if(shootHold && isMad){
    score -= 460 * w.shoot;
  }

  if(!leadSuit){
    // リード時：個性を強める。
    if(ch?.key === 'kamomodoki'){
      score += highCard * 10.2 * w.win;
      score += (suitCount <= 2 ? 28 : 0);       // 短いスートを切って将来フォロー不能を作る
      score += risk * (mode === 'faceValue' ? 1.1 : .55);
      if((mode === 'mud6' || mode === 'mudSuit') && card.suit === MUD_SUIT && !isMad) score += 18; // 重い泥も攻撃的に処理
    } else if(ch?.key === 'wakumodoki'){
      score += (Math.random() < .62 ? highCard * 8.8 : lowCard * 6.4);
      score += nearShoot ? 30 * w.shoot : 0;
      score += shoot && !isMad ? 34 : 0;
      score += risk * .38;
      if(highCard >= 12) score += Math.random()*35; // 大胆な高札リード
    } else {
      score += lowCard * 10.4;
      score += (suitCount <= 2 ? 20 : 0);
      score -= risk * 3.9 * w.risk;
      if(handRisk >= 34) score += risk * 2.35;      // 高リスク手札は棚卸し
      if((mode === 'mud6' || mode === 'mudSuit') && card.suit === MUD_SUIT && !isMad) score += 26; // 泥は早めに処理
    }
    if(isMad && !shootHold) score -= 170; // リードでマッドを自分の山に取る事故を避ける
    return score;
  }

  const follow = card.suit === leadSuit;
  const canWin = cpuWouldWinCurrentTrick(room, card);
  const trickRisk = cpuTrickRisk(room);
  const trickHasMad = cpuTrickHasMadPig(room);
  const hasJoker = playerHasJoker(player);

  if(!follow){
    // フォロー不能時：危険札処理のチャンス。
    score += risk * 19.5 * w.dump;
    score += highCard * .9;
    if((mode === 'mud6' || mode === 'mudSuit') && card.suit === MUD_SUIT) score += 26;
    if(isMad && !shootHold) score += 290;
    if(shootHold && isMad) score -= 820; // 成立済み、またはワクの移動挑戦中はマッドを渡さない
    if(ch?.key === 'kamomodoki') score += 20;      // かももどきは嫌がらせの放流が好き
    if(ch?.key === 'rikumodoki') score += risk * 3; // リクは棚卸し重視
    return score;
  }

  if(canWin){
    const over = Number(card.val || 0) - cpuCurrentLeadHigh(room);
    score += (82 - over * 7.5) * w.win;
    score += normalizeFeastPointPerCard(room.feastPointPerCard) * 4 * 2.8;
    // 新標準は勝者が提供者となり、勝利後に不要札を相手へ渡せる。
    // 従来モードは勝者がカードを受け取るため、同じ勝利でも手札増加リスクを見込む。
    if(normalizePickProviderRole(room.pickProviderRole)==='winner') score += 34 * w.dump;
    else score -= 22 * w.risk;
    score -= risk * 8.5 * w.risk;
    score -= trickRisk * (ch?.key === 'rikumodoki' ? 1.35 : .55); // 危険な山を取りたくない

    if(ch?.key === 'kamomodoki') score += 48; // 攻撃的に取りに行く
    if(ch?.key === 'wakumodoki') score += 28 + Math.random()*34;
    if(ch?.key === 'rikumodoki' && over <= 2) score += 52; // 最小勝ちを評価

    // シュートにはマッドを手札に残す必要がある。山へ取っても条件を満たさない。
    if(shootThePigEnabled(room) && hasJoker && trickHasMad) score -= 90 * w.risk;
    if(isMad && shootHold) score -= 520 * w.shoot;
    if(isMad && !shootHold) score -= 390;
    if(shootState.needsBabaMove && normalizeForceJokerPickCandidate(room.forceJokerPickCandidate)){
      const providerRole=normalizePickProviderRole(room.pickProviderRole);
      const personalityBoost=ch?.key==='wakumodoki'?95:ch?.key==='kamomodoki'?55:28;
      score += providerRole==='winner' ? personalityBoost : -personalityBoost;
    }
    return score;
  }

  // フォローして負ける：危険札や高札を逃がす。
  score += risk * 12.2 * w.dump;
  score += highCard * 2.4;
  score += lowCard * .6;
  if(isMad && !shootHold) score += 260;
  if(shootHold && isMad) score -= 650;
  if(shootState.needsBabaMove && normalizeForceJokerPickCandidate(room.forceJokerPickCandidate) && normalizePickProviderRole(room.pickProviderRole)==='weakest'){
    score += ch?.key==='wakumodoki'?80:ch?.key==='kamomodoki'?46:22;
  }
  if(ch?.key === 'rikumodoki' && risk <= 1) score += 10; // 安全な小札処理
  return score;
}

function chooseCpuPairCardForDiscard(room, player, drawn, candidates){
  if(!Array.isArray(candidates) || !candidates.length) return null;
  return candidates.slice()
    .map(c=>({card:c, score:cpuCardHandRisk(room, c) + (cpuIsMadPigCard(room, c) ? 100 : 0) + Math.random()}))
    .sort((a,b)=>b.score-a.score)[0].card;
}

function chooseCpuPickIndex(room, pp, candidates){
  // ピック画面は裏向きカードなので、CPUもカードの中身を見ない。
  // 以前は候補カードの中身を評価してババブタやマッド・ピッグを避けていたため、
  // 右側にババブタがある時に左側ばかり選ぶように見える問題があった。
  // 候補の配置順は ensurePickOrder() / shuffleIds() でランダム化済み。
  // CPUはそのランダム配置上の位置を、公平にランダム選択する。
  const n = Array.isArray(candidates) ? candidates.length : 0;
  if(n <= 0) return 0;
  return Math.floor(Math.random() * n);
}


function cpuSafeName(room, pid){
  return room?.players?.[pid]?.name || '相手';
}

function cpuNextName(room, pid){
  const count = Array.isArray(room?.players) ? room.players.length : 0;
  if(!count) return '相手';
  const np = (Number(pid) + 1 + count) % count;
  return cpuSafeName(room, np);
}

function cpuCurrentTrickLeaderPid(room){
  if(!room?.trick?.length) return -1;
  const leadSuit = room.leadSuit || room.trick[0]?.card?.suit;
  const leadCards = room.trick.filter(x=>x.card?.suit === leadSuit);
  if(!leadCards.length) return -1;
  return leadCards.slice().sort((a,b)=>Number(b.card.val||0)-Number(a.card.val||0))[0].pid;
}
function cpuCurrentTrickLeaderName(room){
  const pid = cpuCurrentTrickLeaderPid(room);
  return pid >= 0 ? cpuSafeName(room, pid) : '今の勝者';
}
function cpuTrickRisk(room){
  return (room?.trick || []).reduce((sum,x)=>sum + cpuCardHandRisk(room, x.card), 0);
}
function cpuTrickHasMadPig(room){
  return (room?.trick || []).some(x=>cpuIsMadPigCard(room, x.card));
}
function cpuNearShootPotential(room, player){
  const state=shootEligibilityState(room,player);
  return !!(state.enabled && !state.limitReached && (state.hasJoker || state.hasMad || state.needsBabaMove));
}
function cpuCommentChance(room, base=.36){
  if(!room) return false;
  const p = Math.max(.05, Math.min(.85, base));
  return Math.random() < p;
}


function personaContextText(value, fallback='', {cardLike=false}={}){
  if(value == null || value === '') return fallback;
  if(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if(cardLike && typeof value === 'object'){
    try{
      if(value.joker || value.rank != null || value.suit != null) return cardText(value);
    } catch(_e){}
  }
  if(typeof value === 'object'){
    if(value.name != null) return String(value.name);
    if(value.text != null) return String(value.text);
    if(value.label != null) return String(value.label);
  }
  return fallback;
}

function cpuPersonaLineFor(room, pid, type, ctx={}){
  const p = room?.players?.[pid];
  const ch = cpuCharacter(p);
  if(!p || !ch) return null;
  const recent = (room.commentary || [])
    .filter(item=>item && item.cpuKey===ch.key && item.text)
    .slice(0,6)
    .map(item=>item.text);

  // 既定値を作った後にctxを上書きすると、card/drawnへカードオブジェクトが
  // そのまま戻り、テンプレート展開時に「[object Object]」になる。
  // すべてのテンプレート変数を最終段で表示用文字列へ正規化する。
  const rawCtx = Object.assign({}, ctx || {});
  const fullCtx = {
    speaker:personaContextText(rawCtx.speaker, p.name),
    target:personaContextText(rawCtx.target, cpuNextName(room, pid)),
    winner:personaContextText(rawCtx.winner, '勝者'),
    weakest:personaContextText(rawCtx.weakest, '最弱'),
    card:personaContextText(rawCtx.card, 'この札', {cardLike:true}),
    drawn:personaContextText(rawCtx.drawn, 'この札', {cardLike:true}),
    round:personaContextText(rawCtx.round, room.round || 1),
    remaining:personaContextText(rawCtx.remaining, Array.isArray(p.hand) ? p.hand.length : '数'),
    penalty:personaContextText(rawCtx.penalty, room.jokerPenalty ?? 20),
    mode:personaContextText(rawCtx.mode, roomPenaltyLabel(room))
  };
  return createPersonaLine(ch.key, type, fullCtx, recent);
}

function cpuSpotlightPlanFor(room, pid, type, ctx={}){
  const p = room?.players?.[pid];
  const ch = cpuCharacter(p);
  if(!p || !ch) return null;
  const text = cpuPersonaLineFor(room, pid, type, ctx);
  if(!text) return null;
  const presentation = getSpotlightPresentation(ch.key, type);
  return {
    speakerPid:pid,
    cpuKey:ch.key,
    speakerName:p.name,
    text,
    emotion:presentation.emotion,
    portraitPath:`/cpu_characters/spotlight/${ch.key}/${presentation.imageFile}`,
    bubbleStyle:presentation.bubble,
    animation:presentation.animation,
    priority:presentation.priority,
    eventType:type,
    role:ctx.role || 'observer',
    actorPid:Number.isInteger(ctx.actorPid) ? ctx.actorPid : null,
    affectedPid:Number.isInteger(ctx.affectedPid) ? ctx.affectedPid : null,
    targetPid:Number.isInteger(ctx.targetPid) ? ctx.targetPid : null,
    relevance:Number(ctx.relevance || 0),
    drama:Number(ctx.drama || 0)
  };
}

function cpuStrategyLineFor(room, pid, type, ctx={}){
  const p = room.players[pid];
  const ch = cpuCharacter(p);
  if(!ch) return null;
  const card = ctx.card ? cardText(ctx.card) : '';
  const target = ctx.target || cpuNextName(room, pid);
  const winner = ctx.winner || '勝者';
  const weakest = ctx.weakest || '最弱';
  const drawn = ctx.drawn ? cardText(ctx.drawn) : '';
  const round = room.round || 1;
  const mode = roomPenaltyLabel(room);
  const penalty = room.jokerPenalty ?? 20;
  const shootState=shootEligibilityState(room,p);
  const pickCount=normalizePickTargetCount(room.pickTargetCount);
  const pickCountText=pickCount?`${pickCount}枚`:'全手札';
  const forcedBaba=normalizeForceJokerPickCandidate(room.forceJokerPickCandidate) && playerHasJoker(p) && pickCount>0;

  if(type==='shootNeedsBabaMove' && shootState.needsBabaMove){
    if(ch.key==='wakumodoki') return 'ババとマッドは揃った！まずババを一度動かして、シュート条件を開けるぞぉ〜✊🏻';
    if(ch.key==='rikumodoki') return 'ババ未移動のため、現在はシュート条件未成立。危険札の処理価値を再計算します。';
    return '二枚は揃いましたが、ババを一度動かすまではシュート未完成です♡';
  }
  if(type==='targetSelectSmart' && forcedBaba){
    const rest=Math.max(0,pickCount-1);
    if(ch.key==='wakumodoki') return `ババはルールで必須！残り${rest}枚を直感で選ぶぞぉ〜✊🏻`;
    if(ch.key==='rikumodoki') return `ババ必須枠を確認。残り${rest}枚を手札リスク順に選定します。`;
    return `ババは強制候補です♡ 残り${rest}枚に一番いやな札を混ぜます♡`;
  }
  const personaLine = cpuPersonaLineFor(room, pid, type, ctx);
  if(personaLine && Math.random() < .76) return personaLine;

  if(ch.key === 'kamomodoki'){
    if(type==='shootThreat') return sample([
      `${target}さん、ごめんね♡ 月が赤いので、シュートの準備をします♡`,
      `ババブタとマッド、揃うと${target}さん以外も全員しんどいですよ♡`,
      'ウホッ♡ 危険札コンボ、赤く育てておきます♡',
      `このラウンド、${target}さんの不幸も蜜の味にします♡`
    ]);
    if(type==='dumpDanger') return sample([
      `${target}さん、ごめんね♡ ${card}を投下します♡`,
      `${card}を処理します♡ 爆発先はできれば${target}さんで♡`,
      '危険物処理です♡ もちろん相手側で爆発希望です♡',
      `下家のデスロード、${target}さん方面に舗装します♡`
    ]);
    if(type==='mudPenalty') return sample([
      `${target}さん、💧は重いですよ♡ ${card}で圧を撒きます♡`,
      '💧の失点、誰かの心までずっしり沈め♡',
      `${mode}なら灰色の💧札は重たい未来です♡`
    ]);
    if(type==='targetSelectSmart') return sample([
      `${target}さんに渡す候補、甘く見せて毒を混ぜます♡`,
      `候補は${pickCountText}。危険札をどう混ぜるか…蜜の味です♡`,
      `${target}さん、ごめんね♡ 一番嫌な候補セット、完成です♡`
    ]);
    if(type==='trickWin') return sample([
      '勝者は私です♡ ごちそう山と、この部屋のピック役割を確認します♡',
      'ごちそう山ゲット♡ 次は設定どおりの公開ピックです♡',
      `ウホッ♡ 勝ちました。${weakest}さん、ごめんね♡`
    ]);
    if(type==='trickWeak') return sample([
      '最弱ですか♡ でもピックでは部屋設定どおりに動きます♡',
      `${winner}さん、勝敗役割とピック役割は別ですよ♡`,
      'ウホッ…次の役割に合わせて、きっちり仕込みます♡'
    ]);
    if(type==='watchDrama') return sample([
      `${winner}さんが取りましたね♡ 次は提供者とピッカーを確認です♡`,
      'ここから公開ピックです♡ 事故を期待しています♡',
      '人の不幸は蜜の味…さあ設定どおりに移動しましょう♡'
    ]);
    if(type==='babaReveal') return sample([
      `${target}さん、ババブタ直撃♡ -${penalty}の香りがします♡`,
      `出ました♡ ババブタ！ ${target}さん、ごめんねじゃ済まないやつです♡`,
      'ウホッ！公開ピックでこれは最高の赤信号です♡'
    ]);
    if(type==='pairClean') return sample([
      `${target}さん、浄化ですか♡ でもデスロードはまだ続きます♡`,
      'ペアで逃げましたね♡ 次は逃がしません♡',
      'ウホッ、消しても圧は残ります♡'
    ]);
  }

  if(ch.key === 'wakumodoki'){
    if(type==='shootThreat') return sample([
      `${target}さん見てて！シュート・ザ・ピッグ、狙える気がする！できるぞぉ〜✊🏻`,
      'ババとマッド？ 逆にチャンスじゃん！やるぞぉ〜✊🏻',
      'あたしゃ、魔神だよ…月まで撃ち抜く！',
      `${target}さん、ここからドラマ作るから！`
    ]);
    if(type==='dumpDanger') return sample([
      `${card}、ここで放流！${target}さん、ごめん！でも盛り上がる！`,
      '危ない札も勢いで処理！できるぞぉ〜✊🏻',
      `直感でいく！${target}さん方面に流れを変える！`
    ]);
    if(type==='mudPenalty') return sample([
      `💧は重い！だからこそ今切る！${card}！`,
      `${mode}でも私なら持ち上げられる！たぶん！`,
      `${target}さん、💧札でも盛り上げ札にします！`
    ]);
    if(type==='targetSelectSmart') return sample([
      `${target}さんへ渡る候補${pickCountText}！私の直感で選ぶぞぉ〜✊🏻`,
      'ここは魔神セレクト！どっち引いてもドラマ！',
      'できるぞぉ〜✊🏻 たぶん一番いい候補！'
    ]);
    if(type==='trickWin') return sample([
      '勝った！ごちそう獲得、次は設定どおりのピックだぞぉ〜✊🏻',
      'ごちそう山ゲット！ここから公開ピックで盛り上げる！',
      `やるぞぉ〜✊🏻 ${weakest}さん、ごめんね！`
    ]);
    if(type==='trickWeak') return sample([
      `最弱！？でも${winner}さんとのピックで見せ場を作る！`,
      '候補選びならできるぞぉ〜✊🏻',
      'あたしゃ、魔神だよ…最弱からでも見せ場作る！'
    ]);
    if(type==='watchDrama') return sample([
      `${winner}さんが取った！次は提供者からピッカーへ移動だ！`,
      '公開ピック、ここが一番盛り上がる！',
      'ババブタ出たら伝説！出なくてもドラマ！'
    ]);
    if(type==='babaReveal') return sample([
      `${target}さん、ババブタ引いた！？でもまだできるぞぉ〜✊🏻`,
      'うわー！公開ピックでババブタ！最高にゲームしてる！',
      'あたしゃ、魔神だよ…でもこれは震える！'
    ]);
    if(type==='pairClean') return sample([
      `${target}さん、ペア浄化！うまい！できてる！`,
      'ペアで消えた！これは気持ちいいやつ！',
      '手札整理、成功！やるぞぉ〜✊🏻'
    ]);
  }

  if(ch.key === 'rikumodoki'){
    if(type==='shootThreat') return sample([
      `シュート条件を確認。${target}さんへの影響も含めて管理します。`,
      'ババブタとマッド・ピッグの組み合わせ、リスクではなく計画に組み込みます。',
      `危険札コンボを管理対象にします。${target}さん、進行にご注意ください。`
    ]);
    if(type==='dumpDanger') return sample([
      `${card}をリスク処理します。${target}さん、すみませんが工程上必要です。`,
      '危険札を棚卸しします。不要資産は早めに外します。',
      `${target}さん方面へ負債を圧縮します。`
    ]);
    if(type==='mudPenalty') return sample([
      `💧スートは失点が重いです。${card}を処理します。`,
      `${mode}なので、💧リスクを優先管理します。`,
      '灰色の💧札は管理コスト高めです。早めに処理します。'
    ]);
    if(type==='targetSelectSmart') return sample([
      `${target}さんへの候補${pickCountText}をリスク順に選定します。`,
      'ババブタ、マッド、スート失点を考慮して候補を絞ります。',
      `対象範囲を${pickCountText}に圧縮。進捗良好です。`
    ]);
    if(type==='trickWin') return sample([
      '勝利を確認。次工程は設定された提供者とピッカーで公開ピックします。',
      'ごちそう山取得。リスクと得点を再計算します。',
      `${weakest}さん、勝敗とは別のピック役割を確認します。`
    ]);
    if(type==='trickWeak') return sample([
      `最弱を確認。${winner}さんとのピック役割を整理します。`,
      'リスクがあります。候補選定で被害を抑えます。',
      '想定外ですが、進行を止めません。'
    ]);
    if(type==='watchDrama') return sample([
      `${winner}さんが勝利。提供者とピッカーを確定して工程を進めます。`,
      '公開ピック工程に入ります。事故リスクがありますね。',
      'ババブタの所在が重要です。注視します。'
    ]);
    if(type==='babaReveal') return sample([
      `${target}さんがババブタ取得。失点リスク-${penalty}を確認しました。`,
      '公開ピックでババブタ。これは進捗に大きく影響します。',
      'リスク顕在化です。リカバリープランが必要です。'
    ]);
    if(type==='pairClean') return sample([
      `${target}さん、ペア処理完了。手札リスクが下がりました。`,
      '浄化工程完了。進捗良好です。',
      '手札整理が入りました。計画的です。'
    ]);
  }
  return null;
}



function cpuLineFor(room, pid, type, ctx={}){
  const p = room.players[pid];
  const ch = cpuCharacter(p);
  if(!ch) return null;
  const target = ctx.target || cpuNextName(room, pid);
  const cardTextShort = ctx.card ? cardText(ctx.card) : '';
  const drawnText = ctx.drawn ? cardText(ctx.drawn) : '';
  const round = room.round || 1;

  // 追加プロフィールを反映した大規模な状況別コメントを優先。
  // 既存コメントも残し、毎回同じ口癖だけにならないよう混在させる。
  const personaLine = cpuPersonaLineFor(room, pid, type, ctx);
  if(personaLine && Math.random() < .74) return personaLine;

  // 従来の状況特化コメントも引き続き利用する。
  const strategic = cpuStrategyLineFor(room, pid, type, ctx);
  if(strategic) return strategic;

  if(ch.key==='kamomodoki'){
    if(type==='roundStart') return sample([
      round === (room.totalRounds || 3) ? `最終ラウンド♡ ここまで育てたデスロード、完成させます♡` : `第${round}ラウンド♡ 甘い顔で危険札を仕込みますね♡`,
      `${target}さん、ごめんね♡ 今ラウンドも逃げ道は少なめです♡`,
      shootThePigEnabled(room) ? '月もババも赤く染めて、逆転コンボまで味わいます♡' : 'マストフォローは祝福です♡ さあ開幕♡'
    ]);
    if(type==='endgame') return sample([
      `残り${p.hand.length}枚♡ そろそろ誰かの袋を重くして上がります♡`,
      `${target}さん、終盤ほど甘い罠が効くんですよ♡`,
      '出口は見えました♡ でも後ろのデスロードは閉じません♡'
    ]);
    if(type==='playLeadHigh') return sample([
      `${target}さん、ごめんね♡ ${cardTextShort}で下家のデスロード開通♡`,
      'マストフォローは祝福です♡ さあ、逃げ道を塞ぎます♡',
      'ウホッウホッ！高火力で殴ります♡'
    ]);
    if(type==='playLeadLow') return sample([
      `まずは小さな不幸を${target}さん方面に仕込みます♡`,
      'この一歩が下家のデスロードになります♡',
      '人の不幸は蜜の味…まだ前菜です♡'
    ]);
    if(type==='followWin') return sample([
      `${target}さんの勝ち筋、横からいただきます♡ ${cardTextShort}です♡`,
      'マストフォローは祝福です♡ 祝福という名の強制です♡',
      'そこ、逃げ道ありませんよ♡ ウホッ♡'
    ]);
    if(type==='followLow') return sample([
      'ここは低く耐えて、次の誰かを地獄へ送ります♡',
      '最弱回避です♡ 人の不幸を待つ時間も甘い♡',
      'ウホッ、しゃがんでから殴るタイプです♡'
    ]);
    if(type==='offSuit') return sample([
      `${target}さん、ごめんね♡ フォロー不能なので自由に呪いを置きます♡`,
      '下家のデスロード、舗装しておきますね♡',
      'ウホッウホッ、別スートで嫌がらせです♡'
    ]);
    if(type==='pickWin') return sample([
      `${target}さんの候補、裏向きでも赤く光って見えますね♡ 勘で選びます♡`,
      `${target}さん、ごめんね♡ 設定どおりにピックします♡`,
      'ウホッ…中身は見えないのに、失点の気配だけします♡'
    ]);
    if(type==='pickWatch') return sample([
      `${ctx.picker || ctx.winner || 'ピッカー'}さん、そのピックを見届けます♡`,
      '人の不幸は蜜の味…開封の儀です♡',
      '赤背景のゴリラも見守っています。ウホッ♡'
    ]);
    if(type==='targetSelect') return sample([
      `${target}さん用の候補、嫌な感じにします♡`,
      '危険札を混ぜたい…混ぜたいですね♡',
      '下家のデスロード候補、厳選します♡'
    ]);
    if(type==='resultJoker') return cpuStrategyLineFor(room, pid, 'babaReveal', {target:p.name, drawn:ctx.drawn}) || sample([`出ました♡ ${drawnText || '危険札'}、最高の赤信号です♡`]);
    if(type==='resultPair') return cpuStrategyLineFor(room, pid, 'pairClean', {target:p.name, drawn:ctx.drawn}) || sample(['浄化ですか…でもデスロードはまだ続きます♡']);
    if(type==='roundEnd') return sample([
      `第${round}ラウンド、誰かの不幸で締まりましたね♡`,
      '終了です♡ 次のデスロードを準備しましょう♡',
      'マストフォローは祝福でした♡'
    ]);
    return sample(['マストフォローは祝福です♡','人の不幸は蜜の味♡','ウホッウホッ♡']);
  }

  if(ch.key==='wakumodoki'){
    if(type==='roundStart') return sample([
      round === (room.totalRounds || 3) ? '最終ラウンド！全部出し切るぞぉ〜✊🏻' : `第${round}ラウンド！ここからもっと盛り上げるぞぉ〜✊🏻`,
      `${target}さん見てて！最初の一手からドラマ作る！`,
      shootThePigEnabled(room) ? 'ババもマッドも、逆転の材料にしてやるぞぉ〜✊🏻' : 'あたしゃ、魔神だよ…開幕から全開！'
    ]);
    if(type==='endgame') return sample([
      `あと${p.hand.length}枚！ゴールまで一気にいけるぞぉ〜✊🏻`,
      '終盤こそ大胆に！ここが今日の見せ場！',
      `${target}さん、最後まで一緒に盛り上がろう！私は先に上がるけど！`
    ]);
    if(type==='playLeadHigh') return sample([
      `やるぞぉ〜✊🏻 ${cardTextShort}で主役を取りに行く！`,
      `${target}さん、見てて！ここはドーンといく！`,
      'あたしゃ、魔神だよ…この一手で空気を変える！'
    ]);
    if(type==='playLeadLow') return sample([
      'やるぞぉ〜✊🏻 これは未来への布石！',
      'この低さも私なら活かせる！できるぞぉ〜✊🏻',
      '赤帽子の直感、信じます！'
    ]);
    if(type==='followWin') return sample([
      `${target}さんを超えられる！私ならできるぞぉ〜✊🏻`,
      'ここで取ったら盛り上がるよね？ 取ります！',
      'あたしゃ、魔神だよ…勝ちに行く！'
    ]);
    if(type==='followLow') return sample([
      'これも計算通り！たぶん！',
      '丸メガネは見えてます。未来が！',
      'やるぞぉ〜✊🏻 低くても気持ちは高い！'
    ]);
    if(type==='offSuit') return sample([
      `${target}さん、ごめん！自由なら大胆にいくぞぉ〜✊🏻`,
      'フォロー不能？ むしろ見せ場！',
      'できるぞぉ〜✊🏻 なんとかなる！'
    ]);
    if(type==='pickWin') return sample([
      `${target}さんの候補から引くぞぉ〜✊🏻 私なら当たりを引ける！`,
      '裏向きでも乗りこなす！できるぞぉ〜✊🏻',
      'あたしゃ、魔神だよ…裏向き候補も怖くない。'
    ]);
    if(type==='pickWatch') return sample([
      'そのピック、めちゃくちゃ盛り上がる気がする！',
      `${ctx.winner || '勝者'}さん、やるぞぉ〜✊🏻 見届けるぞぉ〜✊🏻`,
      '大丈夫、たぶん全部うまくいく！'
    ]);
    if(type==='targetSelect') return sample([
      `${target}さんへの候補を選ぶぞぉ〜✊🏻 私の直感を信じて！`,
      'この中ならいける！できるぞぉ〜✊🏻',
      '魔神候補セレクション、始めます。'
    ]);
    if(type==='resultJoker') return cpuStrategyLineFor(room, pid, 'babaReveal', {target:p.name, drawn:ctx.drawn}) || sample(['えっ、でも私ならできるぞぉ〜✊🏻']);
    if(type==='resultPair') return cpuStrategyLineFor(room, pid, 'pairClean', {target:p.name, drawn:ctx.drawn}) || sample(['ペア浄化！できるぞぉ〜✊🏻']);
    if(type==='roundEnd') return sample([
      `第${round}ラウンド完了！次もやるぞぉ〜✊🏻`,
      'できるぞぉ〜✊🏻 まだまだ勝てるぞぉ〜✊🏻',
      'あたしゃ、魔神だよ…次ラウンドも任せて。'
    ]);
    return sample(['やるぞぉ〜✊🏻','できるぞぉ〜✊🏻','あたしゃ、魔神だよ…']);
  }

  if(ch.key==='rikumodoki'){
    if(type==='roundStart') return sample([
      round === (room.totalRounds || 3) ? '最終ラウンドです。累積リスクを確認し、勝ち筋へ集中します。' : `第${round}ラウンド開始。危険札と手札枚数を再点検します。`,
      `${target}さんの手番順も確認しました。計画を更新します。`,
      ['mud6','mudSuit'].includes(normalizePenaltyMode(room.penaltyMode)) ? '💧スート管理を最優先タスクに設定します。' : '進行条件を確認。締切まで堅実に処理します。'
    ]);
    if(type==='endgame') return sample([
      `残り${p.hand.length}枚。終了条件までの工程を確認しました。`,
      '終盤です。高リスク札を残さず、最小コストで完了します。',
      `${target}さんの残枚数も確認。ここからは一手の影響が大きいです。`
    ]);
    if(type==='playLeadHigh') return sample([
      `進捗上、${cardTextShort}で主導権を取ります。`,
      'リスクはありますが、ここは取得が妥当です。',
      `${target}さんの動きも踏まえ、前倒しで処理します。`
    ]);
    if(type==='playLeadLow') return sample([
      'まずは安全に進めます。進捗確認から入ります。',
      '低コストで様子を見ます。締切厳守です。',
      '計画通り、無理のない着手です。'
    ]);
    if(type==='followWin') return sample([
      `${target}さんを上回れます。実行します。`,
      'ここは取得が妥当です。議事録に残します。',
      '計画を前倒しします。'
    ]);
    if(type==='followLow') return sample([
      '最弱回避を優先します。',
      'ここは堅実に処理します。無理はしません。',
      '締切を守るため、低リスクで進めます。'
    ]);
    if(type==='offSuit') return sample([
      'フォロー不能です。想定外ですが処理します。',
      `${target}さん方面へ、別スートで対応します。`,
      '予定変更です。落ち着いて進めます。'
    ]);
    if(type==='pickWin') return sample([
      `${target}さんの裏向き候補から1枚選びます。ピック工程に入ります。`,
      '中身は見えません。確率で処理します。締切厳守です。',
      'ピック担当になりました。進捗を止めません。'
    ]);
    if(type==='pickWatch') return sample([
      'ピックの進捗を確認します。',
      'この工程、リスクがありますね。',
      '予定外の事故が起きないことを祈ります。'
    ]);
    if(type==='targetSelect') return sample([
      `${target}さんへの候補選定に入ります。リスク順に確認します。`,
      '対象範囲を絞ります。締切内に決めます。',
      '想定外を避けるため、候補を管理します。'
    ]);
    if(type==='resultJoker') return cpuStrategyLineFor(room, pid, 'babaReveal', {target:p.name, drawn:ctx.drawn}) || sample(['想定外です。リカバリープランを立てます。']);
    if(type==='resultPair') return cpuStrategyLineFor(room, pid, 'pairClean', {target:p.name, drawn:ctx.drawn}) || sample(['ペア処理完了。進捗良好です。']);
    if(type==='roundEnd') return sample([
      `第${round}ラウンド完了。振り返りを行いましょう。`,
      'ラウンド終了です。次工程へ進みます。',
      '締切通りです。進捗良好。'
    ]);
    return sample(['進捗確認します。','締切厳守です。','計画通りに進めましょう。']);
  }

  return null;
}


function sample(arr){ return arr[Math.floor(Math.random()*arr.length)]; }



function cpuPlayLine(room, pid, card){
  const p = room.players[pid];
  const hand = p.hand;
  const leadSuit = room.leadSuit;
  const jokerInHand = hand.some(c=>c.joker);
  const isMad = cpuIsMadPigCard(room, card);
  const shoot = cpuShootPotential(room, p);
  const shootState=shootEligibilityState(room,p);
  const mode = normalizePenaltyMode(room.penaltyMode);
  const risk = cpuCardHandRisk(room, card);
  const currentLeader = cpuCurrentTrickLeaderName(room);
  const nextName = cpuNextName(room, pid);
  const targetName = leadSuit ? currentLeader : nextName;

  if(shoot && (isMad || jokerInHand)){
    const line = cpuStrategyLineFor(room, pid, 'shootThreat', {card, target:targetName});
    if(line) return line;
  }

  if(shootState.needsBabaMove && (isMad || jokerInHand)){
    const line=cpuStrategyLineFor(room,pid,'shootNeedsBabaMove',{card,target:targetName});
    if(line) return line;
  }

  if(isMad && !shoot){
    const line = cpuStrategyLineFor(room, pid, 'dumpDanger', {card, target:targetName});
    if(line) return line;
  }

  if((mode === 'mud6' || mode === 'mudSuit') && card.suit === MUD_SUIT && !isMad){
    const line = cpuStrategyLineFor(room, pid, 'mudPenalty', {card, target:targetName});
    if(line) return line;
  }

  if(leadSuit && card.suit !== leadSuit && risk >= 10){
    const line = cpuStrategyLineFor(room, pid, 'dumpDanger', {card, target:targetName});
    if(line) return line;
  }

  if(hand.length <= 3){
    const line = cpuLineFor(room, pid, 'endgame', {card, target:targetName});
    if(line) return line;
  }

  if(!leadSuit){
    const t = card.val >= 11 ? 'playLeadHigh' : 'playLeadLow';
    return cpuLineFor(room, pid, t, {card, target:nextName}) || sample(['まずは様子見でいく。','小さく入って様子を見る。','ここは安全運転。']);
  }

  if(card.suit !== leadSuit){
    return cpuLineFor(room, pid, 'offSuit', {card, target:currentLeader}) || (jokerInHand
      ? sample(['スートがない！ババブタを隠して逃げる…','ここは別スートでかわす。ババブタだけは出せない！'])
      : sample(['そのスート持ってない！','自由に出せるならこれでいく。']));
  }

  const currentHigh = room.trick.filter(x=>x.card.suit===leadSuit).reduce((m,x)=>Math.max(m,x.card.val),0);
  if(card.val > currentHigh && card.val >= 10) return cpuLineFor(room, pid, 'followWin', {card, target:currentLeader}) || sample(['ここでそれを出す！ごちそう狙い！','勝てるなら勝つしかない！']);
  if(card.val <= 5) return cpuLineFor(room, pid, 'followLow', {card, target:currentLeader}) || sample(['低めで耐える…','これで最弱にならないといい…']);
  return cpuLineFor(room, pid, 'normal', {card, target:currentLeader}) || sample(['マストフォロー、了解。','このカードでついていく。']);
}

function cpuPlayCommentMeta(room, pid, card){
  const p = room.players[pid];
  const shoot = cpuShootPotential(room, p);
  const isMad = cpuIsMadPigCard(room, card);
  const risk = cpuCardHandRisk(room, card);
  if(shoot && (isMad || playerHasJoker(p))) return {eventKey:'shoot-threat'};
  if(isMad || risk >= 10) return {eventKey:'card-danger'};
  if((p?.hand?.length || 0) <= 3) return {eventKey:'endgame'};
  const ch = cpuCharacter(p);
  if(ch?.key === 'kamomodoki') return {eventKey:'card-play',mood:'scheme',icon:'🕸️',label:'仕掛け'};
  if(ch?.key === 'wakumodoki') return {eventKey:'card-play',mood:'hype',intensity:'strong',icon:'✊🏻',label:'大胆な一手'};
  if(ch?.key === 'rikumodoki') return {eventKey:'card-play',mood:'analysis',icon:'📋',label:'計画手'};
  return {eventKey:'card-play'};
}





function cpuPickRoleLine(room, pid, pp, stage='picker'){
  const roles=resolvedPickRoles(room,pp);
  const player=room.players?.[pid];
  const provider=room.players?.[roles.pickProviderPid];
  const picker=room.players?.[roles.pickerPid];
  const standard=normalizePickProviderRole(room?.pickProviderRole)==='winner';
  const key=cpuCharacter(player)?.key;
  if(stage==='provider'){
    const forced=normalizeForceJokerPickCandidate(room.forceJokerPickCandidate) && playerHasJoker(player) && normalizePickTargetCount(room.pickTargetCount)>0;
    if(forced){
      const rest=Math.max(0,pickCandidateLimit(room,player)-1);
      if(key==='kamomodoki') return `ババは強制候補です♡ 残り${rest}枚に毒を混ぜます♡`;
      if(key==='wakumodoki') return `ババ必須！残り${rest}枚は魔神セレクトだぞぉ〜✊🏻`;
      if(key==='rikumodoki') return `ババ必須枠を確認。残り${rest}枚をリスク順に選定します。`;
    }
    if(key==='kamomodoki') return standard ? '勝ったぶん、嫌な札を候補へ仕込みます♡' : `${picker?.name}さん向けに、甘くない候補を整えます♡`;
    if(key==='wakumodoki') return standard ? '勝った！そして私の袋から派手に渡すぞぉ〜✊🏻' : '最弱でも候補選びは魔神セレクト！';
    if(key==='rikumodoki') return standard ? '勝者が提供者です。不要札を候補へ移す工程を開始します。' : '最弱者が提供者です。候補カードを整理します。';
    return `${provider?.name || '提供者'} が候補を選びます。`;
  }
  if(key==='kamomodoki') return standard ? `最弱でしたが、${provider?.name}さんの袋から一枚いただきます♡` : `${provider?.name}さんの候補から一枚いただきます♡`;
  if(key==='wakumodoki') return standard ? '最弱だったけど、勝者の袋から1枚もらえる！' : '勝ったので、最弱者の袋から1枚引くぞぉ〜✊🏻';
  if(key==='rikumodoki') return standard ? '最弱者がピッカーです。裏向き候補から公平に選択します。' : '勝者がピッカーです。裏向き候補からランダムに選択します。';
  return `${picker?.name || 'ピッカー'} が裏向き候補から1枚選びます。`;
}

function cpuPickLine(room, winnerPidOrPendingPick, weakestPid){
  const pp = winnerPidOrPendingPick && typeof winnerPidOrPendingPick==='object'
    ? winnerPidOrPendingPick
    : {trickWinnerPid:winnerPidOrPendingPick,trickWeakestPid:weakestPid};
  const roles=resolvedPickRoles(room,pp);
  const wp=room.players[roles.trickWinnerPid], lp=room.players[roles.trickWeakestPid];
  const picker=room.players[roles.pickerPid];
  if(picker?.cpu) return cpuPickRoleLine(room,roles.pickerPid,pp,'picker');
  const cpu = room.players.find((p,i)=>p.cpu && i!==roles.pickerPid);
  if(cpu){
    const idx = room.players.indexOf(cpu);
    const line = cpuLineFor(room, idx, 'pickWatch', {winner:wp?.name,target:picker?.name, weakest:lp?.name, provider:room.players[roles.pickProviderPid]?.name, picker:picker?.name}) || sample(['このピック、空気が重い…','ババブタの気配がする…']);
    say(room, idx, line, {eventKey:'watch'});
  }
  return null;
}





function resultLine(drawn, paired, room=null, pid=null){
  if(room && pid != null){
    const p = room.players[pid];
    if(drawn.joker) return cpuLineFor(room, pid, 'resultJoker', {drawn, paired, target:p?.name}) || sample(['危険札を引きました。これは痛い展開です。','最悪の1枚です。空気が変わりました。']);
    if(paired) return cpuLineFor(room, pid, 'resultPair', {drawn, paired, target:p?.name}) || sample(['おそろいペア！これはうまい。','ナイス浄化。手札が軽くなりました。']);
  }
  if(drawn.joker) return sample(['危険札を引きました。これは痛い展開です。','最悪の1枚です。空気が変わりました。','完全に事故です。']);
  if(paired) return sample(['おそろいペア！これはうまい。','ナイス浄化。手札が軽くなりました。','そのペアは気持ちいい展開です。']);
  if(drawn.val >= 11) return sample(['強いカードを拾いました。これは効きそうです。','高いカード、後半で存在感が出そうです。']);
  return sample(['まずまずの1枚です。','とりあえず手札に入れておきます。','危険札ではないだけ助かりました。']);
}

function announceCpuRoundStart(room){
  const cpuPids = (room.players || []).map((p,i)=>p?.cpu ? i : -1).filter(i=>i >= 0);
  if(!cpuPids.length) return;
  const pid = room.players[room.current]?.cpu
    ? room.current
    : cpuPids[((room.round || 1) - 1) % cpuPids.length];
  const line = cpuLineFor(room, pid, 'roundStart', {target:cpuSafeName(room, room.current)});
  if(line) say(room, pid, line, {eventKey:'round-start'});
}



function publicState(room, viewerId){
  ensureHumanIdentities(room);
  if(!Array.isArray(room.spectators)) room.spectators=[];
  const viewer=participantById(room,viewerId);
  const participantRole=viewer?.participantRole === 'spectator' ? 'spectator' : 'player';
  const isSpectator=participantRole === 'spectator';
  const viewerIndex = room.players.findIndex(p=>p.id===viewerId);
  return {
    code: room.code,
    hostId: room.hostId,
    you: viewerId,
    yourIndex: viewerIndex,
    participantRole,
    isSpectator,
    maxSpectators:MAX_SPECTATORS_PER_ROOM,
    phase: room.phase,
    disconnectedActionGraceMs: DISCONNECTED_ACTION_GRACE_MS,
    round: room.round,
    totalRounds: room.totalRounds || 3,
    madPigEnabled: room.madPigEnabled !== false,
    jokerPenalty: room.jokerPenalty ?? 20,
    jokerPenaltyTiming: normalizeJokerPenaltyTiming(room.jokerPenaltyTiming),
    shootThePigEnabled: shootThePigEnabled(room),
    shootThePigLimit: shootThePigLimit(room),
    forceJokerPickCandidate:normalizeForceJokerPickCandidate(room.forceJokerPickCandidate),
    shootRequiresBabaMoved:normalizeShootRequiresBabaMoved(room.shootRequiresBabaMoved),
    babaMovedThisRound:!!room.babaMovedThisRound,
    babaMoveCountThisRound:Number(room.babaMoveCountThisRound || 0),
    babaMoveEvent:room.babaMoveEvent && room.babaMoveEvent.expiresAt>Date.now() ? room.babaMoveEvent : null,
    // 旧クライアント互換。無制限時は null、1回制限時だけ1を返す。
    shootThePigPerPlayerLimit: shootThePigLimit(room) === 'once' ? 1 : null,
    shootPigEvent: room.shootPigEvent && room.shootPigEvent.expiresAt > Date.now() ? room.shootPigEvent : null,
    madPigEvent: room.madPigEvent && room.madPigEvent.expiresAt > Date.now() ? room.madPigEvent : null,
    pairCleanEvent: room.pairCleanEvent && room.pairCleanEvent.expiresAt > Date.now() ? room.pairCleanEvent : null,
    cardPlayEvent: room.cardPlayEvent || null,
    trickCollectEvent: room.trickCollectEvent || null,
    spotlightEvent: room.spotlightEvent && room.spotlightEvent.expiresAt > Date.now() ? room.spotlightEvent : null,
    initialPairDiscardEnabled: room.initialPairDiscardEnabled === true,
    passThreeEnabled: room.passThreeEnabled === true,
    roundDealMode: normalizeRoundDealMode(room.roundDealMode),
    penaltyMode: normalizePenaltyMode(room.penaltyMode),
    pickTargetCount: normalizePickTargetCount(room.pickTargetCount),
    feastPointPerCard: normalizeFeastPointPerCard(room.feastPointPerCard),
    pickProviderRole: normalizePickProviderRole(room.pickProviderRole),
    passDone: room.passDone || [],
    passTargetPid: viewerIndex >= 0 ? passTargetPid(viewerIndex) : null,
    passSourcePid: viewerIndex >= 0 ? passSourcePid(viewerIndex) : null,
    passableCardIds: viewerIndex >= 0 && room.phase === 'passing' ? passableCardIds(room.players[viewerIndex]) : [],
    initialPairDone: room.initialPairDone || [],
    initialPairCandidateIds: viewerIndex >= 0 && room.phase === 'initialPair' ? initialPairCandidateIds(room.players[viewerIndex]) : [],
    roundStart: room.roundStart && room.roundStart.expiresAt > Date.now() ? room.roundStart : null,
    roundEndSummary: room.roundEndSummary || null,
    roundEndAutoContinueAt: room.phase === 'roundEnd' && room.roundEndSummary
      ? Number(room.roundEndSummary.createdAt || Date.now()) + ROUND_END_AUTO_CONTINUE_MS
      : null,
    roundEndAutoContinueInMs: room.phase === 'roundEnd' && room.roundEndSummary
      ? Math.max(0, Number(room.roundEndSummary.createdAt || Date.now()) + ROUND_END_AUTO_CONTINUE_MS - Date.now())
      : null,
    roundEndDeferred: room.roundEndDeferred || null,
    lead: room.lead,
    current: room.current,
    leadSuit: room.leadSuit,
    message: room.message,
    removedCard: room.removedCard ? (room.phase==='finished' ? room.removedCard : null) : null,
    trick: room.trick,
    pendingPick: room.pendingPick ? (()=>{
      const roles=resolvedPickRoles(room, room.pendingPick);
      const provider=room.players[roles.pickProviderPid];
      return {
      // 旧クライアント互換。winnerPid/weakestPidはトリック上の役割のまま意味を変えない。
      winnerPid: roles.trickWinnerPid,
      weakestPid: roles.trickWeakestPid,
      trickWinnerPid: roles.trickWinnerPid,
      trickWeakestPid: roles.trickWeakestPid,
      pickProviderPid: roles.pickProviderPid,
      pickerPid: roles.pickerPid,
      readyAt: room.pendingPick.readyAt,
      // クライアントのPC時計差に依存しないため、サーバー基準の状態も送る。
      ready: Date.now() >= room.pendingPick.readyAt,
      readyInMs: Math.max(0, room.pendingPick.readyAt - Date.now()),
      targetCount: room.pendingPick.targetCount || pickCandidateLimit(room, provider),
      targetSelectionRequired: room.pendingPick.targetSelectionRequired === true,
      targetSelectionDone: room.pendingPick.targetSelectionDone !== false,
      mandatoryCandidateCount:Array.isArray(room.pendingPick.mandatoryCandidateIds) ? room.pendingPick.mandatoryCandidateIds.length : 0,
      mandatoryCandidateIds:(viewerIndex===roles.pickProviderPid && room.pendingPick.targetSelectionRequired && !room.pendingPick.targetSelectionDone)
        ? (room.pendingPick.mandatoryCandidateIds || []).slice()
        : [],
      forcedJokerCandidate:room.pendingPick.forcedJokerCandidate===true,
      targetCandidateCount: (room.pendingPick.targetSelectionRequired && room.pendingPick.targetSelectionDone === false)
        ? Math.min(room.pendingPick.targetCount || 0, provider?.hand?.length || 0)
        : (pickCandidateCards(room, room.pendingPick).length || pickCandidateLimit(room, provider)),
      targetSelectableCardIds: (viewerIndex === roles.pickProviderPid && room.pendingPick.targetSelectionRequired && !room.pendingPick.targetSelectionDone) ? provider.hand.map(c=>c.id) : [],
      result: room.pendingPick.result || null,
      pairChoice: room.pendingPick.pairChoice ? {
        drawn: room.pendingPick.pairChoice.drawn,
        candidates: viewerIndex === roles.pickerPid ? room.pendingPick.pairChoice.candidates : null,
        candidateCount: room.pendingPick.pairChoice.candidates.length
      } : null
    };})() : null,
    players: room.players.map((p,i)=>({
      id:p.id, name:p.name, seat:i, cpu: !!p.cpu, cpuKey: cpuCharacter(p)?.key || null, cpuStyle:cpuCharacter(p)?.style || null, cpuTitle:cpuCharacter(p)?.title || null, avatar: p.cpu ? cpuAvatar(p) : (p.avatar || '🐷'), avatarImage: p.cpu ? (cpuCharacter(p)?.imagePath || null) : null, connected:!!(p.cpu || (p.ws && p.ws.readyState===WebSocket.OPEN)), disconnectedAt:p.cpu ? null : (p.disconnectedAt || null), disconnectedForMs:!p.cpu && p.disconnectedAt ? Math.max(0,Date.now()-p.disconnectedAt) : 0,
      handCount:p.hand.length,
      // プレイヤー接続へ他人の非公開手札を送らない。全手札は観戦接続だけに公開する。
      hand: isSpectator || p.id===viewerId ? p.hand : null,
      scorePileCount:p.scorePile.length,
      scorePileScore:feastPileScore(room,p),
      // pairs 配列はカード2枚単位。UIにはカード枚数ではなく成立した組数を返す。
      pairsCount:Math.floor(p.pairs.length/2),
      shootUsed:playerHasUsedShootThePig(p),
      shootActivationCount:playerShootActivationCount(p),
      shootLimitReached:playerShootLimitReached(room,p),
      out:p.out || false,
      final:p.final || null,
      matchStats:room.phase==='finished' ? publicMatchStats(p.matchStats) : null,
      playEvaluation:room.phase==='finished' ? (p.playEvaluation || []) : null,
      lastComment: p.lastComment && p.lastComment.expiresAt > Date.now() ? p.lastComment : null,
    })),
    spectators: room.spectators.map(s=>({
      id:s.id,name:s.name,avatar:s.avatar || '👁',participantRole:'spectator',
      connected:isOpenWs(s.ws),disconnectedAt:s.disconnectedAt || null,
      isHost:s.id===room.hostId
    })),
    spectatorCount:room.spectators.length,
    // クライアント側の判定ズレを防ぐため、出せるカードはサーバーで確定して送る。
    playableCardIds: viewerIndex >= 0 ? [...playableIds(room, viewerIndex)] : [],
    isYourTurn: viewerIndex >= 0 && room.current === viewerIndex && room.phase === 'playing' && !room.pendingPick && !room.trickReview,
    commentary: (room.commentary || []).filter(x=>x.expiresAt > Date.now()).sort((a,b)=>{
      const now=Date.now();
      const aProtected=Number(a.minimumVisibleUntil || 0)>now?1:0;
      const bProtected=Number(b.minimumVisibleUntil || 0)>now?1:0;
      return bProtected-aProtected || Number(b.priority || 1)-Number(a.priority || 1) || Number(b.createdAt || 0)-Number(a.createdAt || 0);
    }).slice(0,4),
    lastTrick: room.lastTrick && room.lastTrick.expiresAt > Date.now() ? room.lastTrick : null,
    trickReview: room.trickReview && room.trickReview.until > Date.now() ? room.trickReview : null,
    log: room.log,
  };
}
function send(ws, type, payload){
  if(!ws || ws.readyState!==WebSocket.OPEN) return;
  try { ws.send(JSON.stringify({type, ...payload})); }
  catch(e){ console.error('send failed', e); }
}
function broadcast(room){
  if(!room || !room.players) return;
  for(const p of room.players){
    if(p.ws && p.ws.readyState===WebSocket.OPEN){
      send(p.ws,'state',{state: publicState(room,p.id)});
    }
  }
  let spectatorStateTemplate=null;
  for(const spectator of (room.spectators || [])){
    if(!isOpenWs(spectator.ws)) continue;
    if(!spectatorStateTemplate) spectatorStateTemplate=publicState(room,spectator.id);
    const spectatorState=spectatorStateTemplate.you===spectator.id?spectatorStateTemplate:{...spectatorStateTemplate,you:spectator.id};
    send(spectator.ws,'state',{state:spectatorState});
  }
  scheduleCpu(room);
}

function normalizeRoundCount(n){
  const x = Number(n);
  if(!Number.isInteger(x)) return 3;
  return Math.max(1, Math.min(6, x));
}



function normalizePenaltyMode(v){
  if(v === 'faceValue') return 'faceValue';
  if(v === 'mud6' || v === 'spade6') return 'mud6';
  if(v === 'mudSuit' || v === 'spadeSuit') return 'mudSuit';
  if(v === 'flat3') return 'flat3';
  return 'mud6';
}



function handPenaltyForRoom(room, player){
  const mode = normalizePenaltyMode(room.penaltyMode);
  const useMadPig = room.madPigEnabled !== false;
  let total = 0;
  for(const c of player.hand || []){
    if(!c || c.joker) continue;
    const isMad = c.suit===MUD_SUIT && c.rank==='11';

    // 数字分失点モードかつマッド・ピッグONの場合、泥11は通常の11点ではなく40点として扱う。
    if(mode === 'faceValue' && useMadPig && isMad){
      total += 40;
    } else if(mode === 'faceValue'){
      total += Number(c.val || c.rank || 0);

    // 数字分以外では、マッド・ピッグON時の泥11は通常の残り手札失点と重複させず、
    // madPigPenaltyForRoom() の固有失点-13だけを適用する。
    } else if(useMadPig && isMad){
      continue;

    // 標準モード：リンゴ・トウモロコシ・キャベツは3点、通常の泥は6点。
    } else if(mode === 'mud6'){
      total += c.suit === MUD_SUIT ? 6 : 3;

    // 泥-3/他-1モードでは、通常カードは1点、泥スートだけ3点。
    } else if(mode === 'mudSuit'){
      total += c.suit === MUD_SUIT ? 3 : 1;

    } else {
      total += 3;
    }
  }
  return total;
}



function madPigPenaltyForRoom(room, player){
  const useMadPig = room.madPigEnabled !== false;
  if(!useMadPig) return 0;
  const mode = normalizePenaltyMode(room.penaltyMode);
  const cards = [...(player.hand || []), ...(player.scorePile || [])];
  const madPigs = cards.filter(c=>c && !c.joker && c.suit===MUD_SUIT && c.rank==='11');

  if(mode === 'faceValue'){
    // 手札にあるマッド・ピッグは handPenaltyForRoom 側で40点として計算済み。
    // ごちそう山にあるマッド・ピッグは設定されたごちそう点を得たうえで、ここで40点失点。
    return madPigs.filter(c => (player.scorePile || []).some(p=>p.id===c.id)).length * 40;
  }

  // 数字分以外では、手札・ごちそう山のどちらでもマッド・ピッグ固有失点-13点。
  // 通常の残り手札失点とは重複しない。
  return madPigs.length * 13;
}


function normalizePassThreeEnabled(v){
  return v === true || v === 'true' || v === 1 || v === '1' || v === 'on';
}

function normalizeInitialPairDiscardEnabled(v){
  return v === true || v === 'true' || v === 1 || v === '1' || v === 'on';
}

function normalizeRoundDealMode(v){
  // 標準は毎ラウンド全カードを回収して配り直す。
  // carryOver は旧ルール互換：残り手札・ごちそう山・ペアを保持して13枚まで補充。
  return v === 'carryOver' ? 'carryOver' : 'reshuffle';
}
function roundDealModeLabel(room){
  return normalizeRoundDealMode(room?.roundDealMode) === 'carryOver' ? 'カード持ち越し' : '毎R全シャッフル';
}


function normalizeJokerPenalty(v){
  const n = Number(v);
  if(!Number.isFinite(n)) return 20;
  const abs = Math.abs(Math.trunc(n));
  return Math.max(0, Math.min(999, abs));
}
function normalizeJokerPenaltyTiming(v){
  return v === 'gameEnd' ? 'gameEnd' : 'perRound';
}
function jokerPenaltyTimingLabel(room){
  return normalizeJokerPenaltyTiming(room?.jokerPenaltyTiming) === 'gameEnd' ? 'ゲーム最後' : 'ラウンド毎';
}
function normalizeShootThePigEnabled(v){
  return v === true || v === 'true';
}
function normalizeForceJokerPickCandidate(v){
  return v === true || v === 'true';
}
function normalizeShootRequiresBabaMoved(v){
  return v === true || v === 'true';
}
function normalizeShootThePigLimit(v){
  // v33標準はゲーム中の発動回数に上限を設けない。
  // 旧クライアントや保存済み部屋に値がない場合も unlimited として扱う。
  return v === 'once' ? 'once' : 'unlimited';
}
function shootThePigEnabled(room){
  return room && room.madPigEnabled !== false && normalizeShootThePigEnabled(room.shootThePigEnabled);
}
function shootThePigLimit(room){
  return normalizeShootThePigLimit(room?.shootThePigLimit);
}
function shootThePigLimitLabel(room){
  return shootThePigLimit(room) === 'once' ? '1人1回まで' : '無制限';
}
function shootThePigLabel(room){
  if(room?.madPigEnabled === false) return '不可';
  if(!shootThePigEnabled(room)) return 'なし';
  const timing = normalizeJokerPenaltyTiming(room?.jokerPenaltyTiming);
  const limit = shootThePigLimitLabel(room);
  const move=normalizeShootRequiresBabaMoved(room?.shootRequiresBabaMoved)?'・ババ移動必須':'';
  return timing === 'gameEnd' ? `あり(${limit}・最終Rのみ${move})` : `あり(${limit}${move})`;
}
function rulePenaltyPointLabel(value){
  const n = Math.max(0, Math.abs(Number(value) || 0));
  return n > 0 ? `-${n}` : '0';
}
function playerHasMadPig(room, player){
  if(!room || room.madPigEnabled === false || !player) return false;
  return [...(player.hand || []), ...(player.scorePile || [])].some(c=>c && !c.joker && c.suit===MUD_SUIT && c.rank==='11');
}
function playerHasMadPigInHand(room, player){
  if(!room || room.madPigEnabled === false || !player) return false;
  return (player.hand || []).some(c=>c && !c.joker && c.suit===MUD_SUIT && c.rank==='11');
}
function playerHasJoker(player){
  return !!(player && (player.hand || []).some(c=>c && c.joker));
}
function playerShootActivationCount(player){
  return player && Array.isArray(player.shootPigActivatedRounds) ? player.shootPigActivatedRounds.length : 0;
}
function playerHasUsedShootThePig(player){
  return playerShootActivationCount(player) > 0;
}
function playerShootLimitReached(room, player){
  return shootThePigLimit(room) === 'once' && playerShootActivationCount(player) >= 1;
}
function shootEligibilityState(room, player){
  const enabled=shootThePigEnabled(room);
  const hasJoker=playerHasJoker(player);
  const hasMad=playerHasMadPigInHand(room,player);
  const limitReached=playerShootLimitReached(room,player);
  const movementRequired=normalizeShootRequiresBabaMoved(room?.shootRequiresBabaMoved);
  const babaMoved=!!room?.babaMovedThisRound;
  const needsBabaMove=enabled && movementRequired && hasJoker && hasMad && !babaMoved;
  const eligibleNow=!!(enabled && player && !limitReached && hasJoker && hasMad && (!movementRequired || babaMoved));
  return {enabled,hasJoker,hasMad,limitReached,movementRequired,babaMoved,needsBabaMove,eligibleNow,nearShoot:enabled && !limitReached && (hasJoker || hasMad)};
}
function playerCanShootThePig(room, player){
  return shootEligibilityState(room,player).eligibleNow;
}
function shouldCheckShootThePigThisRound(room){
  if(!shootThePigEnabled(room)) return false;
  const timing = normalizeJokerPenaltyTiming(room.jokerPenaltyTiming);
  if(timing === 'gameEnd') return (room.round || 1) >= (room.totalRounds || 3);
  return true;
}


function adjustHandPenaltyForShootThePig(room, player, basePenalty, active=false){
  // シュート・ザ・ピッグ発動時、手札内マッド・ピッグを手札失点側で処理しているモードだけ戻す。
  // 数字分失点：handPenaltyForRoom() 側で40点として数えるため、その分を0に戻す。
  // 数字分以外：マッドON時の泥11は最初から通常手札失点に含めず、マッド失点側で処理するため戻し不要。
  if(!active) return basePenalty;
  if(normalizePenaltyMode(room.penaltyMode) !== 'faceValue') return basePenalty;
  const madPigHand = (player.hand || []).filter(c=>c && !c.joker && c.suit===MUD_SUIT && c.rank==='11').length;
  return Math.max(0, basePenalty - madPigHand * 40);
}

function cpuShootActivatedLine(room, pid, shooterPid){
  const ch=cpuCharacter(room.players[pid]);
  const shooter=room.players[shooterPid]?.name || '発動者';
  const self=pid===shooterPid;
  if(ch?.key==='kamomodoki') return self
    ? sample(['月まで赤く染まりました♡ シュート・ザ・ピッグ、命中です♡','危険札ふたつで全員へプレゼント♡ 人の不幸は蜜の味です♡'])
    : sample([`${shooter}さん、月を撃ちましたね…♡ これは笑えない-10点です♡`,'シュート直撃♡ こんな不幸まで蜜の味とは言ってません♡']);
  if(ch?.key==='wakumodoki') return self
    ? sample(['決まったー！シュート・ザ・ピッグ！できたぞぉ〜✊🏻','ババもマッドも逆転弾！月まで届いたぞぉ〜✊🏻'])
    : sample([`${shooter}さん、本当に撃った！うわー、でも最高に盛り上がってる！`,'-10点！？痛い！でもこの逆転、すごいぞぉ〜✊🏻']);
  if(ch?.key==='rikumodoki') return self
    ? sample(['シュート条件成立。危険札を逆転資産へ転換しました。','発動を確認。自身の危険札失点0、他プレイヤーへ-10点です。'])
    : sample([`${shooter}さんのシュート発動を確認。損失-10点、計画を再構築します。`,'想定外の一斉損失です。最終スコアへの影響を再計算します。']);
  return self ? 'シュート・ザ・ピッグ発動！' : `${shooter} がシュートを発動しました！`;
}



function applyShootThePigForRound(room){
  if(!room || !shouldCheckShootThePigThisRound(room)) return null;
  const roundKey = String(room.round || 1);
  room.shootPigRoundResults = room.shootPigRoundResults || {};
  if(Object.prototype.hasOwnProperty.call(room.shootPigRoundResults, roundKey)){
    return room.shootPigRoundResults[roundKey];
  }

  // 基本条件は「ババブタとマッド・ピッグの両方が手札にある」こと。
  // 移動条件ONでは、さらに今ラウンド中の実移動が必要。共通判定は
  // shootEligibilityState() に集約し、CPUと結果計算で別条件を持たせない。
  // 回数制限は部屋設定（標準:無制限 / 任意:1人1回）に従う。
  // ごちそう山のマッド・ピッグは発動条件に含めない。
  const shooterPid = room.players.findIndex(p=>playerCanShootThePig(room, p));
  if(shooterPid < 0){
    room.shootBlockedByUnmovedBabaResults=room.shootBlockedByUnmovedBabaResults || {};
    const blockedPid=room.players.findIndex(p=>{
      const state=shootEligibilityState(room,p);
      return state.needsBabaMove && !state.limitReached;
    });
    if(blockedPid>=0){
      const blocked={
        round:room.round || 1,pid:blockedPid,
        name:room.players[blockedPid]?.name || '',
        reason:'babaNotMoved',babaMovedThisRound:false
      };
      room.shootBlockedByUnmovedBabaResults[roundKey]=blocked;
      matchStatsFor(room.players[blockedPid]).shootBlockedByUnmovedBabaCount++;
      log(room, `🌕 シュート条件未成立：${blocked.name} はババブタ＋マッドを持っていますが、このラウンドでババブタが移動していません。`);
    }
    room.shootPigRoundResults[roundKey] = null;
    return null;
  }

  const timing = normalizeJokerPenaltyTiming(room.jokerPenaltyTiming);
  const isFinalRound = (room.round || 1) >= (room.totalRounds || 3);
  const result = {
    round: room.round || 1,
    shooterPid,
    shooterName: room.players[shooterPid]?.name || '',
    penaltyToOthers: 10,
    timing,
    isFinalRound,
    limitMode: shootThePigLimit(room),
    perPlayerLimit: shootThePigLimit(room) === 'once' ? 1 : null,
    activationCount: playerShootActivationCount(room.players[shooterPid]) + 1,
  };

  for(const [i,p] of room.players.entries()){
    p.shootPigPenaltyBank = p.shootPigPenaltyBank || 0;
    p.shootPigActivatedRounds = p.shootPigActivatedRounds || [];
    if(i === shooterPid){
      matchStatsFor(p).shootCount++;
      if(!p.shootPigActivatedRounds.includes(result.round)) p.shootPigActivatedRounds.push(result.round);
      // 失点免除は「発動した当該ラウンド」にだけ適用する。
      // 過去ラウンドの発動を永続フラグにすると、後のラウンドで条件未成立でも
      // マッド失点が0になるため、判定は各ラウンドのshootPigResultから導出する。
    } else {
      p.shootPigPenaltyBank += result.penaltyToOthers;
    }
  }

  room.shootPigRoundResults[roundKey] = result;
  room.shootBlockedByUnmovedBabaResults=room.shootBlockedByUnmovedBabaResults || {};
  room.shootBlockedByUnmovedBabaResults[roundKey]=null;
  room.shootPigEvent = {
    ...result,
    id:`shoot-${result.round}-${result.shooterPid}-${Date.now()}`,
    expiresAt:Date.now()+9000
  };
  const limitText = result.limitMode === 'once' ? '1人1回制限の権利を使用' : `無制限設定で通算${result.activationCount}回目`;
  log(room, `🐷🌕 シュート・ザ・ピッグ発動！ ${result.shooterName} は手札のババブタ＋マッドで${limitText}。このラウンドのババブタ/マッド・ピッグ失点は0、他の全員に-10点。`);
  const speakerPid=room.players[shooterPid]?.cpu
    ? shooterPid
    : room.players.findIndex((p,i)=>p.cpu && i!==shooterPid);
  if(speakerPid>=0) say(room,speakerPid,cpuShootActivatedLine(room,speakerPid,shooterPid),{eventKey:'shoot',durationMs:14500});
  return result;
}



function normalizeMadPigEnabled(v){
  if(v === false || v === 'false' || v === 0 || v === '0' || v === 'off') return false;
  return true;
}


function roomByWs(ws){ return rooms.get(ws.roomCode); }

function isOpenWs(ws){
  return ws && ws.readyState === WebSocket.OPEN;
}

// ロビーまたは最終結果で部屋主が離脱したままだと、残った参加者が
// ゲーム開始・再戦を行えず停止する。操作可能な人間へ安全に権限を移す。
function ensureLobbyHost(room){
  if(!room || !['lobby','finished'].includes(room.phase) || !Array.isArray(room.players)) return false;
  const currentHost = participantById(room,room.hostId);
  if(currentHost && isOpenWs(currentHost.ws)) return false;

  // 切断中の人やCPUへ権限を渡さない。誰も接続していない間は現状を保持し、
  // 次の復帰時に reconnectRoom() から再評価する。
  const nextHost = humanParticipants(room).find(p=>isOpenWs(p.ws));
  if(!nextHost || nextHost.id === room.hostId) return false;
  room.hostId = nextHost.id;
  const action = room.phase === 'finished'
    ? '同じメンバー・同じルールで再戦できます。'
    : 'CPUの追加・削除とゲーム開始ができます。';
  room.message = `${nextHost.name} が新しい部屋主になりました。${action}`;
  log(room, `👑 部屋主を ${nextHost.name} へ引き継ぎました。`);
  return true;
}

function cancelRoomCleanup(room){
  if(!room) return;
  room.emptySince = null;
  if(room.cleanupTimer){
    clearTimeout(room.cleanupTimer);
    room.cleanupTimer = null;
  }
}

function scheduleRoomCleanup(room){
  if(!room || room.cleanupTimer) return;
  room.emptySince = Date.now();
  const emptySince = room.emptySince;
  room.cleanupTimer = setTimeout(()=>{
    room.cleanupTimer = null;
    const current = rooms.get(room.code);
    if(!current || current !== room) return;
    // 観戦者だけが残った部屋も期限切れにする。ゲーム席の人間接続がある時だけ維持する。
    const stillEmpty = connectedHumanPlayers(room).length===0;
    if(stillEmpty && room.emptySince === emptySince){
      clearAllProgressTimers(room);
      room.spotlightEvent=null;
      room.pendingSpotlightPlans=null;
      rooms.delete(room.code);
    }
  }, ROOM_EMPTY_TTL_MS);
  room.cleanupTimer.unref?.();
}

function reconcilePassiveRoomCleanup(room){
  if(!room) return;
  if(connectedHumanPlayers(room).length){
    cancelRoomCleanup(room);
    return;
  }
  // 観戦者の参加・復帰だけで既存TTLを延長しない。CPUだけで進行中の試合は
  // startGame() が解除したまま完走させ、終了後に通常の空室TTLを開始する。
  if(room.cleanupTimer) return;
  if(['lobby','finished'].includes(room.phase)) scheduleRoomCleanup(room);
}

function findReconnectCandidate(room, playerId, name, resumeToken){
  if(!room) return null;
  const clean = cleanName(name);
  // 最優先：保存されたplayerId + 端末専用トークンで同じ席へ復帰。
  const participants=humanParticipants(room);
  let idx = participants.findIndex(p=>p.id === playerId);
  if(idx >= 0){
    const player=participants[idx];
    // 旧形式の席にはトークンなし復帰を許可し、新形式では一致を必須にする。
    if(!player.resumeToken || resumeTokenMatches(player.resumeToken, resumeToken)){
      return {player, idx, participantRole:normalizeParticipantRole(player.participantRole), reason:player.resumeToken ? 'token' : 'legacy-id'};
    }
    return null;
  }

  // 旧形式だけは同名かつ切断中の席へフォールバックする。
  idx = participants.findIndex(p=>!p.resumeToken && p.name === clean && !isOpenWs(p.ws));
  if(idx >= 0) return {player:participants[idx], idx, participantRole:normalizeParticipantRole(participants[idx].participantRole), reason:'name'};

  return null;
}

function reconnectRoom(ws, c, playerId, name, resumeToken){
  c = String(c||'').toUpperCase().trim();
  const room = rooms.get(c);
  if(!room) return send(ws,'errorMsg',{message:'復帰する部屋が見つかりません。'});
  const found = findReconnectCandidate(room, playerId, name, resumeToken);
  if(!found) return send(ws,'errorMsg',{message:'復帰できる席が見つかりません。この席を使っていた端末の復帰情報（部屋コード・プレイヤーID・復帰トークン）が必要です。'});

  const {player, idx} = found;
  if(player.ws && player.ws !== ws && isOpenWs(player.ws)){
    try { player.ws.close(4000, 'reconnected elsewhere'); } catch(e){}
  }
  player.ws = ws;
  player.disconnectedAt = null;
  if(normalizeParticipantRole(player.participantRole)==='player') cancelRoomCleanup(room);
  else reconcilePassiveRoomCleanup(room);
  ws.roomCode = c;
  ws.playerId = player.id;
  ws.participantId = player.id;
  ws.participantRole = normalizeParticipantRole(player.participantRole);
  // ロビーの旧部屋主が切断中なら、今まさに復帰した操作可能な参加者へ権限を移す。
  ensureLobbyHost(room);
  log(room, `${player.name} が再接続しました。`);
  send(ws,'reconnected',{code:c, playerId:player.id, participantId:player.id, participantRole:ws.participantRole, name:player.name, avatar:player.avatar || null, resumeToken:player.resumeToken || null});
  broadcast(room);
}



function normalizePickTargetCount(v){
  const n = Number(v);
  if(!Number.isFinite(n) || n <= 0) return 0; // 0 = 絞らない
  return Math.max(1, Math.min(13, Math.floor(n)));
}

function normalizeFeastPointPerCard(v){
  const n = Number(v);
  if(!Number.isInteger(n) || n < 0 || n > 10) return 1;
  return n;
}

function normalizePickProviderRole(v){
  return v === 'weakest' ? 'weakest' : 'winner';
}

function feastPileScore(room, player){
  return (player?.scorePile?.length || 0) * normalizeFeastPointPerCard(room?.feastPointPerCard);
}

function resolvedPickRoles(room, ppOrWinnerPid, maybeWeakestPid){
  const pp = ppOrWinnerPid && typeof ppOrWinnerPid === 'object' ? ppOrWinnerPid : null;
  const trickWinnerPid = pp
    ? Number(pp.trickWinnerPid ?? pp.winnerPid)
    : Number(ppOrWinnerPid);
  const trickWeakestPid = pp
    ? Number(pp.trickWeakestPid ?? pp.weakestPid)
    : Number(maybeWeakestPid);
  const role = normalizePickProviderRole(room?.pickProviderRole);
  const derivedProviderPid = role === 'winner' ? trickWinnerPid : trickWeakestPid;
  const derivedPickerPid = role === 'winner' ? trickWeakestPid : trickWinnerPid;
  return {
    trickWinnerPid,
    trickWeakestPid,
    pickProviderPid:Number(pp?.pickProviderPid ?? derivedProviderPid),
    pickerPid:Number(pp?.pickerPid ?? derivedPickerPid)
  };
}

function pickTargetLabel(room){
  const n = normalizePickTargetCount(room.pickTargetCount);
  return n > 0 ? `候補${n}枚` : '絞らない';
}

function pickCandidateLimit(room, providerPlayer){
  const n = normalizePickTargetCount(room.pickTargetCount);
  const handCount = providerPlayer && Array.isArray(providerPlayer.hand) ? providerPlayer.hand.length : 0;
  return n > 0 ? Math.min(n, handCount) : handCount;
}

function forcedJokerCandidateIds(room, providerPlayer){
  if(!normalizeForceJokerPickCandidate(room?.forceJokerPickCandidate)) return [];
  // 「絞らない」は元々全手札が候補なので、強制枠としては扱わない。
  if(normalizePickTargetCount(room?.pickTargetCount)===0) return [];
  const joker=(providerPlayer?.hand || []).find(card=>card?.joker);
  return joker ? [String(joker.id)] : [];
}

function mergeMandatoryPickTargetIds(room, providerPlayer, proposedIds, count){
  const handIds=new Set((providerPlayer?.hand || []).map(card=>String(card.id)));
  const needed=Math.min(Math.max(0,Number(count)||0),handIds.size);
  if(needed<=0) return [];
  const mandatory=forcedJokerCandidateIds(room,providerPlayer).filter(id=>handIds.has(id)).slice(0,needed);
  const merged=[...mandatory];
  for(const id of (proposedIds || []).map(String)){
    if(merged.length>=needed) break;
    if(handIds.has(id) && !merged.includes(id)) merged.push(id);
  }
  return merged;
}

function forcedJokerRuleChangesCandidates(room, providerPlayer, targetCount){
  return forcedJokerCandidateIds(room,providerPlayer).length>0
    && Number(targetCount)>0
    && Number(targetCount)<Number(providerPlayer?.hand?.length || 0);
}


function shuffleIds(ids){
  return shuffle((ids || []).map(String).slice());
}
function ensurePickOrder(room, pp){
  if(!room || !pp) return [];
  const {pickProviderPid} = resolvedPickRoles(room, pp);
  const provider = room.players[pickProviderPid];
  if(!provider || !Array.isArray(provider.hand)) return [];

  const sourceIds = Array.isArray(pp.targetCandidateIds) && pp.targetCandidateIds.length
    ? pp.targetCandidateIds.map(String)
    : provider.hand.map(c=>c.id);
  const live = new Set(provider.hand.map(c=>c.id));
  const validCurrent = Array.isArray(pp.pickOrderIds)
    && pp.pickOrderIds.length === sourceIds.length
    && pp.pickOrderIds.every(id=>sourceIds.includes(id) && live.has(id));
  if(!validCurrent){
    pp.pickOrderIds = shuffleIds(sourceIds.filter(id=>live.has(id)));
  }
  return pp.pickOrderIds;
}

function cpuUnwantedValue(room, player, card){
  if(!card) return -999999;
  const mode = normalizePenaltyMode(room.penaltyMode);
  const shoot = cpuShootPotential(room, player);
  const mad = cpuIsMadPigCard(room, card);

  // 現在のルール上シュート可能な時だけ、ババブタとマッド・ピッグを温存する。
  // ババ必須候補は後段の共通マージが必ず優先し、CPU戦略では解除できない。
  if(shoot && card.joker) return -250000;
  if(shoot && mad) return -180000;

  if(card.joker) return 1000000;
  if(mad) return mode === 'faceValue' ? 900000 : 720000;

  let value = cpuCardHandRisk(room, card) * 120;

  // 数字分失点では高数字ほど危険。泥傾斜モードでは泥を強く嫌う。
  if(mode === 'faceValue') value += Number(card.val || 0) * 42;
  if(mode === 'mud6' && card.suit === MUD_SUIT) value += 300;
  if(mode === 'mudSuit' && card.suit === MUD_SUIT) value += 180;

  // 同じ数字のペアがあるカードは後で浄化できる可能性があるため、候補優先度を下げる。
  const sameRank = (player?.hand || []).filter(c=>!c.joker && c.rank===card.rank).length;
  if(sameRank >= 2) value -= 140;

  // 終盤は高札を残す価値が下がる。
  if((player?.hand || []).length <= 4) value += Number(card.val || 0) * 12;

  // 低いカードはトリックで逃げやすい。
  if(Number(card.val || 0) <= 3) value -= 70;
  return value;
}



function pickCandidateCards(room, pp){
  if(!room || !pp) return [];
  const {pickProviderPid} = resolvedPickRoles(room, pp);
  const provider = room.players[pickProviderPid];
  if(!provider || !Array.isArray(provider.hand)) return [];
  const orderIds = ensurePickOrder(room, pp);
  if(orderIds.length){
    return orderIds.map(id=>provider.hand.find(c=>c && c.id===id)).filter(Boolean);
  }
  return shuffle(provider.hand.slice());
}


function pickRiskValue(room, card){
  if(!card) return -999;
  if(card.joker) return 10000;
  if(room.madPigEnabled !== false && card.suit===MUD_SUIT && card.rank==='11'){
    return normalizePenaltyMode(room.penaltyMode)==='faceValue' ? 4000 : 1300;
  }
  return Number(card.val || 0);
}


function chooseCpuPickTargetIds(room, providerPid, count){
  const p = room.players[providerPid];
  if(!p || !Array.isArray(p.hand)) return [];
  const need = Math.max(0, count);
  const mandatory=forcedJokerCandidateIds(room,p);
  const mandatorySet=new Set(mandatory);
  const strategic=p.hand.slice()
    .filter(card=>!mandatorySet.has(String(card.id)))
    .map(c=>({card:c, value:cpuUnwantedValue(room, p, c), tie:Math.random()}))
    .sort((a,b)=>b.value-a.value || a.tie-b.tie)
    .slice(0, Math.max(0,need-mandatory.length))
    .map(x=>x.card.id);
  return mergeMandatoryPickTargetIds(room,p,strategic,need);
}


function autoResolveCpuPickTargets(room, pp){
  if(!room || !pp || !pp.targetSelectionRequired || pp.targetSelectionDone) return;
  const roles = resolvedPickRoles(room, pp);
  const provider = room.players[roles.pickProviderPid];
  const picker = room.players[roles.pickerPid];
  if(!provider || !provider.cpu) return;
  const token=pp.token || `pick-${pp.createdAt || Date.now()}-${roles.trickWinnerPid}-${roles.trickWeakestPid}`;
  scheduleRoomTask(room, `cpu-target-${token}`, GAME_TIMING.cpuTargetSelect, ()=>{
    if(room.phase !== 'playing') return;
    if(room.pendingPick !== pp || pp.result || pp.targetSelectionDone) return;
    const ids = chooseCpuPickTargetIds(room, roles.pickProviderPid, pp.targetCount);
    say(room, roles.pickProviderPid, cpuPickRoleLine(room, roles.pickProviderPid, pp, 'provider') || cpuStrategyLineFor(room, roles.pickProviderPid, 'targetSelectSmart', {target:picker?.name}) || '候補を選びます。', {eventKey:'target-select'});
    submitPickTargets(room, provider.id, ids, true);
  });
}


function roomPenaltyLabel(room){
  const mode = normalizePenaltyMode(room.penaltyMode);
  if(mode === 'faceValue') return '数字分失点';
  if(mode === 'mud6') return '💧-6/他-3';
  if(mode === 'mudSuit') return '💧-3/他-1';
  return '1枚-3点';
}

function roomMadPigLabel(room){
  if(room.madPigEnabled === false) return 'なし';
  return normalizePenaltyMode(room.penaltyMode)==='faceValue' ? '-40' : '-13';
}

function roomPickProviderLabel(room){
  return normalizePickProviderRole(room?.pickProviderRole) === 'winner'
    ? '勝者から最弱者へ'
    : '最弱者から勝者へ';
}


function roomOptionSummary(room){
  const babaOptions=[];
  if(normalizeForceJokerPickCandidate(room.forceJokerPickCandidate)) babaOptions.push('ババ必須候補');
  if(normalizeShootRequiresBabaMoved(room.shootRequiresBabaMoved)) babaOptions.push('シュート移動条件');
  return `全${room.totalRounds || 3}R / 配り直し:${roundDealModeLabel(room)} / ごちそう:1枚${normalizeFeastPointPerCard(room.feastPointPerCard)}点 / 失点:${roomPenaltyLabel(room)} / ババ:${rulePenaltyPointLabel(room.jokerPenalty ?? 20)}(${jokerPenaltyTimingLabel(room)}) / マッド:${roomMadPigLabel(room)} / シュート:${shootThePigLabel(room)} / ピック:${roomPickProviderLabel(room)}・${pickTargetLabel(room)}${babaOptions.length?` / ババ移動:${babaOptions.join('＋')}`:''} / 3枚パス:${room.passThreeEnabled ? 'あり' : 'なし'} / 開始ペア:${room.initialPairDiscardEnabled ? 'あり' : 'なし'}`;
}



function createRoom(ws, name, totalRounds=3, madPigEnabled=true, jokerPenalty=-20, initialPairDiscardEnabled=false, passThreeEnabled=false, penaltyMode='mud6', pickTargetCount=2, jokerPenaltyTiming='perRound', shootThePigEnabled=true, roundDealMode='reshuffle', shootThePigLimit='unlimited', feastPointPerCard=1, pickProviderRole='winner', participantRole='player', forceJokerPickCandidate=false, shootRequiresBabaMoved=false){
  const c = code();
  const role=normalizeParticipantRole(participantRole);
  const normalizedMadPigEnabled=normalizeMadPigEnabled(madPigEnabled);
  const normalizedShootEnabled=normalizedMadPigEnabled && normalizeShootThePigEnabled(shootThePigEnabled);
  const normalizedMoveRequirement=normalizedShootEnabled && normalizeShootRequiresBabaMoved(shootRequiresBabaMoved);
  const room = {code:c, hostId:null, players:[], spectators:[], phase:'lobby', round:1, totalRounds: normalizeRoundCount(totalRounds), roundDealMode:normalizeRoundDealMode(roundDealMode), feastPointPerCard:normalizeFeastPointPerCard(feastPointPerCard), pickProviderRole:normalizePickProviderRole(pickProviderRole), forceJokerPickCandidate:normalizeForceJokerPickCandidate(forceJokerPickCandidate), shootRequiresBabaMoved:normalizedMoveRequirement, babaMovedThisRound:false, babaMoveCountThisRound:0, babaMoveHistory:[], babaMoveEvent:null, madPigEnabled:normalizedMadPigEnabled, jokerPenalty: normalizeJokerPenalty(jokerPenalty), jokerPenaltyTiming: normalizeJokerPenaltyTiming(jokerPenaltyTiming), shootThePigEnabled:normalizedShootEnabled, shootThePigLimit:normalizeShootThePigLimit(shootThePigLimit), initialPairDiscardEnabled: normalizeInitialPairDiscardEnabled(initialPairDiscardEnabled), passThreeEnabled: normalizePassThreeEnabled(passThreeEnabled), penaltyMode: normalizePenaltyMode(penaltyMode), pickTargetCount: normalizePickTargetCount(pickTargetCount), initialPairDone:[], passDone:[], passSelections:{}, lead:0, current:0, leadSuit:null, trick:[], stock:[], log:[], message:'4人そろったら開始できます。人が足りない場合はCPUを追加できます。', pendingPick:null, commentary:[], lastTrick:null, cardPlayEvent:null, trickCollectEvent:null, shootPigEvent:null, madPigEvent:null, pairCleanEvent:null, spotlightEvent:null, pendingSpotlightPlans:null, spotlightHistory:[], spotlightRoundCounts:{}, lastSpotlightSpeakerPid:null, transientTimers:new Map(), emptySince:null, cleanupTimer:null, closed:false};
  const participant=createHumanParticipant(room,name,ws,role);
  room.hostId=participant.id;
  if(role==='spectator') room.spectators.push(participant); else room.players.push(participant);
  rooms.set(c, room); ws.roomCode=c; ws.playerId=participant.id; ws.participantId=participant.id; ws.participantRole=role;
  log(room, `${participant.name} が${role==='spectator'?'観戦者として':''}部屋を作りました。${roomOptionSummary(room)}`);
  send(ws,'created',{code:c, playerId:participant.id, participantId:participant.id, participantRole:role, name:participant.name, avatar:participant.avatar, resumeToken:participant.resumeToken});
  if(role==='spectator') scheduleRoomCleanup(room);
  broadcast(room);
}
function joinRoom(ws, c, name, playerId=null, resumeToken=null, participantRole='player'){
  c = String(c||'').toUpperCase().trim(); const room = rooms.get(c);
  if(!room) return send(ws,'errorMsg',{message:'部屋が見つかりません。'});
  const existing = findReconnectCandidate(room, playerId, name, resumeToken);
  if(existing) return reconnectRoom(ws, c, existing.player.id, existing.player.name, resumeToken);
  const role=normalizeParticipantRole(participantRole);
  if(role==='player' && room.phase !== 'lobby'){
    return send(ws,'errorMsg',{message:'この部屋は開始済みです。切断復帰には、この席を使っていた端末のプレイヤーIDと復帰トークンが必要です。'});
  }
  if(role==='player' && room.players.length >= 4) {
    return send(ws,'playerSeatsFull',{message:'プレイヤーは4人そろっています。観戦者として参加できます。',canSpectate:true,code:c});
  }
  if(role==='spectator' && (room.spectators || []).length >= MAX_SPECTATORS_PER_ROOM){
    return send(ws,'errorMsg',{message:`観戦者は最大${MAX_SPECTATORS_PER_ROOM}人です。`});
  }
  if(!Array.isArray(room.spectators)) room.spectators=[];
  const participant=createHumanParticipant(room,name,ws,role);
  if(role==='spectator') room.spectators.push(participant); else room.players.push(participant);
  reconcilePassiveRoomCleanup(room);
  ws.roomCode=c; ws.playerId=participant.id; ws.participantId=participant.id; ws.participantRole=role;
  log(room, `${participant.name} が${role==='spectator'?'観戦者として':''}参加しました。`);
  ensureLobbyHost(room);
  send(ws,'joined',{code:c, playerId:participant.id, participantId:participant.id, participantRole:role, name:participant.name, avatar:participant.avatar, resumeToken:participant.resumeToken}); broadcast(room);
}

function changeParticipantRole(room, participantId, nextRole, requesterWs=null){
  if(room && !Array.isArray(room.spectators)) room.spectators=[];
  if(!room || room.phase!=='lobby'){
    if(requesterWs) send(requesterWs,'errorMsg',{message:'参加方法を変更できるのはゲーム開始前だけです。'});
    return false;
  }
  const role=normalizeParticipantRole(nextRole);
  const participant=participantById(room,participantId);
  if(!participant || (requesterWs && participant.ws!==requesterWs)) return false;
  const current=normalizeParticipantRole(participant.participantRole);
  if(current===role) return true;
  if(role==='player' && room.players.length>=4){
    send(participant.ws,'playerSeatsFull',{message:'プレイヤー席は満員です。空きができるまで観戦できます。',canSpectate:true,code:room.code});
    return false;
  }
  if(role==='spectator' && room.spectators.length>=MAX_SPECTATORS_PER_ROOM){
    send(participant.ws,'errorMsg',{message:`観戦者は最大${MAX_SPECTATORS_PER_ROOM}人です。`});
    return false;
  }
  if(current==='player'){
    const index=room.players.indexOf(participant);
    if(index>=0) room.players.splice(index,1);
    participant.participantRole='spectator';
    delete participant.hand;delete participant.scorePile;delete participant.pairs;delete participant.final;delete participant.matchStats;
    room.spectators.push(participant);
  }else{
    const index=room.spectators.indexOf(participant);
    if(index>=0) room.spectators.splice(index,1);
    participant.participantRole='player';
    Object.assign(participant,{hand:[],scorePile:[],pairs:[],completedRoundCardScoreBank:0,jokerPenaltyBank:0,shootPigPenaltyBank:0,shootPigActivatedRounds:[],out:false,matchStats:null});
    room.players.push(participant);
  }
  participant.ws.participantRole=role;
  if(connectedHumanPlayers(room).length) cancelRoomCleanup(room); else scheduleRoomCleanup(room);
  room.message=`${participant.name} が${role==='spectator'?'観戦':'プレイ'}参加へ切り替えました。`;
  log(room,`👁 ${room.message}`);
  broadcast(room);
  return true;
}


function addCpu(room, requesterId){
  if(room.hostId !== requesterId) return;
  if(room.phase !== 'lobby') return;
  if(room.players.length >= 4) { room.message='この部屋は満員です。'; broadcast(room); return; }
  const used = new Set(room.players.filter(p=>p.cpu).map(p=>p.cpuCharacter?.key || cpuCharacterByName(p.name)?.key));
  const ch = CPU_CHARACTERS.find(c=>!used.has(c.key)) || {key:`cpu-${uid()}`, name:`CPU${room.players.length}`, avatar:'🐷'};
  const player = {id:`CPU-${uid()}`, name:ch.name, ws:null, cpu:true, participantRole:'player', disconnectedAt:null, cpuCharacter:ch, hand:[], scorePile:[], pairs:[], completedRoundCardScoreBank:0, jokerPenaltyBank:0, shootPigPenaltyBank:0, shootPigActivatedRounds:[], out:false,matchStats:null};
  room.players.push(player);
  log(room, `${player.name} を追加しました。`);
  say(room, room.players.length-1, ch.catchphrase || 'よろしくお願いします。', {eventKey:'greeting'});
  room.message='CPUを追加しました。4人そろったら開始できます。';
  broadcast(room);
}

function removeCpu(room, requesterId){
  if(room.hostId !== requesterId) return;
  if(room.phase !== 'lobby') return;
  const i = room.players.map(p=>p.cpu).lastIndexOf(true);
  if(i<0) { room.message='削除できるCPUがいません。'; broadcast(room); return; }
  const [p] = room.players.splice(i,1);
  log(room, `${p.name} を外しました。`);
  room.message='CPUを外しました。';
  broadcast(room);
}

function clearRoom(room, requesterId, requesterWs=null){
  if(!room || room.closed || rooms.get(room.code)!==room) return false;
  const requester=participantById(room,requesterId);
  if(requesterWs && requester?.ws!==requesterWs){
    send(requesterWs,'errorMsg',{message:'この接続は既に無効です。現在の画面から操作してください。'});
    return false;
  }
  if(!requester || room.hostId!==requesterId){
    send(requester?.ws,'errorMsg',{message:'部屋をクリアできるのはホストだけです。'});
    return false;
  }
  if(room.phase!=='lobby'){
    send(requester.ws,'errorMsg',{message:'部屋をクリアできるのはゲーム開始前だけです。'});
    return false;
  }

  room.closed=true;
  clearAllProgressTimers(room);
  cancelRoomCleanup(room);
  room.spotlightEvent=null;
  room.pendingSpotlightPlans=null;
  room.pendingPick=null;
  room.trickReview=null;
  rooms.delete(room.code);

  const sockets=[];
  for(const participant of humanParticipants(room)){
    participant.resumeToken=null;
    if(!participant.ws) continue;
    sockets.push({ws:participant.ws, playerId:participant.id});
  }
  for(const entry of sockets){
    send(entry.ws,'roomClosed',{reason:'hostCleared',code:room.code});
    if(entry.ws.roomCode===room.code) entry.ws.roomCode=null;
    if(entry.ws.playerId===entry.playerId) entry.ws.playerId=null;
    if(entry.ws.participantId===entry.playerId) entry.ws.participantId=null;
    entry.ws.participantRole=null;
  }
  for(const participant of humanParticipants(room)) participant.ws=null;
  return true;
}


function clearPickFinishTimer(room){
  if(room.pickFinishTimer){
    clearTimeout(room.pickFinishTimer);
    room.pickFinishTimer = null;
  }
  if(room.pickFinishFailSafeTimer){
    clearTimeout(room.pickFinishFailSafeTimer);
    room.pickFinishFailSafeTimer = null;
  }
}
function clearReviewTimer(room){
  if(room.reviewTimer){
    clearTimeout(room.reviewTimer);
    room.reviewTimer = null;
  }
  if(room.reviewFailSafeTimer){
    clearTimeout(room.reviewFailSafeTimer);
    room.reviewFailSafeTimer = null;
  }
  if(room.reviewWatchTimer){
    clearInterval(room.reviewWatchTimer);
    room.reviewWatchTimer = null;
  }
}
function clearAllProgressTimers(room){
  if(!room) return;
  clearReviewTimer(room);
  clearPickFinishTimer(room);
  if(room.cpuTimer){ clearTimeout(room.cpuTimer); room.cpuTimer=null; }
  if(room.cpuPickTimer){ clearTimeout(room.cpuPickTimer); room.cpuPickTimer=null; }
  if(room.cpuPickFailSafeTimer){ clearTimeout(room.cpuPickFailSafeTimer); room.cpuPickFailSafeTimer=null; }
  if(room.recoverTimer){ clearTimeout(room.recoverTimer); room.recoverTimer=null; }
  clearTransientRoomTasks(room);
}
function ensurePickFinish(room, pp, winnerPid, delay=2600){
  clearPickFinishTimer(room);
  const token = pp && pp.token ? pp.token : `${Date.now()}-${Math.random()}`;
  if(pp) pp.token = token;

  room.pickFinishTimer = setTimeout(()=>{
    room.pickFinishTimer = null;
    if(room.phase !== 'playing') return;
    if(!room.pendingPick || room.pendingPick.token !== token) return;
    finishAfterPick(room, winnerPid);
  }, delay);
  room.pickFinishTimer.unref?.();

  // 結果表示後に何らかのタイマー不発・状態ズレがあっても止まらないための保険。
  room.pickFinishFailSafeTimer = setTimeout(()=>{
    if(room.phase !== 'playing') return;
    if(!room.pendingPick || room.pendingPick.token !== token) return;
    log(room, '⚠️ ピック結果後の進行が遅延したため、自動復旧しました。');
    finishAfterPick(room, winnerPid);
  }, delay + GAME_TIMING.failSafeExtra);
  room.pickFinishFailSafeTimer.unref?.();
}
function ensureReviewToPick(room, reviewToken, winnerPid, weakestPid){
  // レビュー→ピック遷移は、この関数で必ず予約する。
  // 既存タイマーが残っていても一旦消し、reviewTokenで現在のレビューだけを進める。
  clearReviewTimer(room);

  const delay = Math.max(0, reviewToken - Date.now());
  room.reviewTimer = setTimeout(()=>{
    room.reviewTimer = null;
    advanceReviewToPick(room, reviewToken, winnerPid, weakestPid);
  }, delay);
  room.reviewTimer.unref?.();

  // 保険1：通常タイマーが実行されなかった場合でも進める。
  room.reviewFailSafeTimer = setTimeout(()=>{
    if(room.phase !== 'playing') return;
    if(!room.trickReview || room.trickReview.until !== reviewToken) return;
    log(room, '⚠️ トリック結果確認からピックへの遷移が遅延したため、自動復旧しました。');
    advanceReviewToPick(room, reviewToken, winnerPid, weakestPid);
  }, delay + 3500);
  room.reviewFailSafeTimer.unref?.();

  // 保険2：Renderなどでタイマーが遅延しても、短い監視でレビュー期限切れを拾う。
  if(room.reviewWatchTimer) clearInterval(room.reviewWatchTimer);
  room.reviewWatchTimer = setInterval(()=>{
    if(room.phase !== 'playing' || !room.trickReview || room.trickReview.until !== reviewToken){
      clearInterval(room.reviewWatchTimer); room.reviewWatchTimer=null; return;
    }
    if(Date.now() >= reviewToken){
      clearInterval(room.reviewWatchTimer); room.reviewWatchTimer=null;
      advanceReviewToPick(room, reviewToken, winnerPid, weakestPid);
    }
  }, 500);
  room.reviewWatchTimer.unref?.();
}


function advanceReviewToPick(room, reviewToken, winnerPid, weakestPid){
  if(room.phase !== 'playing') return;

  // 現在のレビューと違う古いタイマーなら無視。
  if(!room.trickReview || room.trickReview.until !== reviewToken) return;

  const wp = room.players[winnerPid];
  const lp = room.players[weakestPid];
  if(!wp || !lp){
    log(room, '⚠️ ピック遷移対象のプレイヤーが見つからないため、進行を復旧しました。');
    room.trickReview = null;
    room.trick = [];
    room.leadSuit = null;
    room.current = room.lead ?? 0;
    broadcast(room);
    return;
  }

  clearReviewTimer(room);
  room.trickReview = null;

  if(winnerPid===weakestPid){
    log(room, '⚠️ 勝者と最弱者が同一の異常状態を検知したため、ピックを行わず進行します。');
    finishAfterPick(room,winnerPid);
    return;
  }

  if(endCandidatePid(room) >= 0){
    room.pendingPick = null;
    room.spotlightEvent = null;
    room.pendingSpotlightPlans = null;
    checkRoundEnd(room);
    broadcast(room);
    return;
  }

  const roles=resolvedPickRoles(room,winnerPid,weakestPid);
  const provider=room.players[roles.pickProviderPid];
  const picker=room.players[roles.pickerPid];

  if(provider?.hand.length > 0){
    matchStatsFor(provider).pickProviderCount++;
    matchStatsFor(picker).pickerCount++;
    const targetCount = pickCandidateLimit(room, provider);
    const mandatoryCandidateIds=forcedJokerCandidateIds(room,provider);
    const narrowedCandidates=normalizePickTargetCount(room.pickTargetCount)>0 && targetCount<provider.hand.length;
    // 必須ババだけで候補が確定する1枚設定では、意味のない人間入力を要求しない。
    const targetSelectionRequired=narrowedCandidates && targetCount>mandatoryCandidateIds.length;
    const autoCandidateIds=narrowedCandidates && !targetSelectionRequired
      ? mergeMandatoryPickTargetIds(room,provider,[],targetCount)
      : null;
    const forcedJokerCandidate=forcedJokerRuleChangesCandidates(room,provider,targetCount);
    const readyAt = Date.now() + (targetSelectionRequired ? 999999999 : GAME_TIMING.pickPrepare);
    room.lastPickTargetRebroadcastAt = 0;
    room.lastPairChoiceRebroadcastAt = 0;
    room.pendingPick = {
      trickWinnerPid:winnerPid,
      trickWeakestPid:weakestPid,
      pickProviderPid:roles.pickProviderPid,
      pickerPid:roles.pickerPid,
      // 旧クライアント互換。意味は従来どおりトリックの勝者・最弱者。
      winnerPid,
      weakestPid,
      readyAt,
      createdAt: Date.now(),
      result:null,
      token:`pick-${Date.now()}-${Math.random()}`,
      targetCount,
      mandatoryCandidateIds,
      forcedJokerCandidate,
      targetSelectionRequired,
      targetSelectionDone: !targetSelectionRequired,
      targetCandidateIds: targetSelectionRequired ? [] : autoCandidateIds,
      pickOrderIds: targetSelectionRequired ? [] : shuffleIds(autoCandidateIds || provider.hand.map(c=>c.id))
    };

    if(forcedJokerCandidate){
      matchStatsFor(provider).babaForcedCandidateCount++;
      log(room, `🃏 強制候補ルール：${provider.name} のババブタをピック候補へ固定しました。`);
    }

    if(targetSelectionRequired){
      room.message = `🐽 カードを取られる ${provider.name} が、候補を${targetCount}枚に絞ります。`;
      log(room, `🎯 ピック候補選択：提供者 ${provider.name} が ${targetCount}枚を選び、${picker.name} が1枚引きます。`);
      autoResolveCpuPickTargets(room, room.pendingPick);
      broadcast(room);
    } else {
      room.message = forcedJokerCandidate && targetCount===1
        ? `🃏 ルールによりババブタ1枚が自動で候補になりました。${picker.name} が受け取ります。`
        : `🐽 ババ抜きピック！ ${picker.name} が ${provider.name} の袋から1枚選びます。`;
      const line = cpuPickLine(room, room.pendingPick); if(line && picker.cpu) say(room, roles.pickerPid, line, {eventKey:'pick'});
      ensureCpuPick(room);
      broadcast(room);
      // readyAtを過ぎた状態を全員に再送する。キー付き予約で重複タイマーを防ぐ。
      const pickToken=room.pendingPick.token;
      if(forcedJokerCandidate && targetCount===1){
        scheduleRoomTask(room,`forced-baba-pick-${pickToken}`,GAME_TIMING.pickPrepare+80,()=>{
          if(room.phase==='playing' && room.pendingPick?.token===pickToken && !room.pendingPick.result){
            doPick(room,picker.id,0);
          }
        });
      }
      scheduleRoomTask(room, `pick-ready-${pickToken}-1`, GAME_TIMING.pickPrepare+50, ()=>{
        if(room.phase==='playing' && room.pendingPick?.token===pickToken) broadcast(room);
      });
      scheduleRoomTask(room, `pick-ready-${pickToken}-2`, GAME_TIMING.pickPrepare+450, ()=>{
        if(room.phase==='playing' && room.pendingPick?.token===pickToken) broadcast(room);
      });
    }
  } else {
    // ピックなしでラウンド終了へ向かう場合も、古い中央セリフを結果画面へ残さない。
    room.spotlightEvent = null;
    room.pendingSpotlightPlans = null;
    finishAfterPick(room, winnerPid);
  }
}



function isPlayerConnectedForProgress(p){
  return !!(p && (p.cpu || (p.ws && p.ws.readyState === WebSocket.OPEN)));
}
function disconnectedPickTargetFallbackIds(room, pp){
  const {pickProviderPid}=resolvedPickRoles(room,pp);
  const provider = room?.players?.[pickProviderPid];
  if(!provider || !Array.isArray(provider.hand)) return [];
  const need = Math.min(Number(pp?.targetCount || 0), provider.hand.length);
  if(need <= 0) return [];
  // 切断復旧用。CPUの戦略で人間の手札を勝手に最適化しないよう、ランダム候補にする。
  return mergeMandatoryPickTargetIds(room,provider,shuffleIds(provider.hand.map(c=>c.id)),need);
}

function ensureRoomProgress(room){
  if(!room) return;
  // 結果モーダルを誰も閉じない、または確認役が切断した場合でも卓を止めない。
  // 45秒は内容確認と通常の再接続に十分な猶予を持たせたフェイルセーフ。
  if(room.phase === 'roundEnd'){
    const createdAt = Number(room.roundEndSummary?.createdAt || Date.now());
    if(Date.now() >= createdAt + ROUND_END_AUTO_CONTINUE_MS){
      log(room, `⏭️ 結果確認が${Math.round(ROUND_END_AUTO_CONTINUE_MS/1000)}秒を超えたため、次のラウンドへ自動で進みます。`);
      beginNextRound(room);
    }
    return;
  }
  // 開始時ペア捨てフェイズの進行確認。CPU処理と全員完了判定だけ行う。
  if(room.phase === 'passing'){
    // 3枚パスフェイズの進行確認。CPU処理と全員完了判定だけ行う。
    maybeFinishPassPhase(room);
    return;
  }
  if(room.phase === 'initialPair'){
    maybeFinishInitialPairPhase(room);
    return;
  }
  if(room.phase !== 'playing') return;
  if(!room.players || room.players.length !== 4) return;

  // 手札0枚は進行不能なので終了候補。
  // ババブタ1枚だけは「そのプレイヤーの手番開始時」にだけ終了候補。
  // そのため、カードを出した直後にババブタ1枚だけになってもピックまでは進める。
  if(!room.pendingPick && !room.trickReview){
    const emptyPid = room.players.findIndex(isEmptyHand);
    if(emptyPid >= 0){
      if(activeTrickInProgress(room)){
        rememberEndAfterTrick(room, emptyPid);
        broadcast(room);
      } else {
        log(room, '🏁 手札0枚を検知したため、ラウンド終了処理へ進みます。');
        checkRoundEnd(room, emptyPid);
        broadcast(room);
        return;
      }
    }

    if(Number.isInteger(room.current) && isJokerOnlyHand(room.players[room.current])){
      log(room, '🏁 手番開始時にババブタ1枚だけだったため、ラウンド終了処理へ進みます。');
      checkRoundEnd(room, room.current);
      broadcast(room);
      return;
    }
  }

  // 4枚出揃っているのにレビューにもピックにも進んでいない場合は、トリック解決をやり直す。
  if(!room.pendingPick && !room.trickReview && room.trick && room.trick.length===4){
    log(room, '⚠️ トリック解決待ちで停止を検知したため、自動復旧しました。');
    resolveTrick(room);
    broadcast(room);
    return;
  }

  // トリックが5枚以上など不正状態になった場合も、resolveTrick側で余分な札を
  // 持ち主へ返してから先頭4枚を解決する。ここでsliceすると余分なカードが消える。
  if(!room.pendingPick && !room.trickReview && room.trick && room.trick.length>4){
    log(room, '⚠️ 場のカード枚数が不正だったため、余分なカードを返して復旧します。');
    resolveTrick(room);
    broadcast(room);
    return;
  }

  // 通常進行中なのにcurrentがnullで、レビュー・ピック待ちでもない場合は復旧。
  if(room.current == null && !room.pendingPick && !room.trickReview){
    if(room.trick && room.trick.length>0 && room.trick.length<4){
      const lastPid = room.trick[room.trick.length-1].pid;
      room.current = (lastPid + 1) % room.players.length;
      log(room, '⚠️ 手番表示が停止したため、次プレイヤーへ自動復旧しました。');
      broadcast(room);
      return;
    }
    if(!room.trick || room.trick.length===0){
      room.current = Number.isInteger(room.lead) ? room.lead : 0;
      log(room, '⚠️ 手番が未設定だったため、リードプレイヤーへ自動復旧しました。');
      broadcast(room);
      return;
    }
  }

  // currentが範囲外の場合は補正。
  if(room.current != null && (!Number.isInteger(room.current) || room.current < 0 || room.current >= room.players.length)){
    room.current = ((Number(room.current)||0) % room.players.length + room.players.length) % room.players.length;
    log(room, '⚠️ 手番番号が不正だったため、自動補正しました。');
    broadcast(room);
    return;
  }

  // 現在プレイヤーに出せるカードがない場合、終了条件なら終了。そうでなければ状態再送。
  if(!room.pendingPick && !room.trickReview && room.current != null){
    const ids = playableIds(room, room.current);
    if(ids.size === 0){
      if(safeFinishBecauseNoPlayable(room, room.current)) return;
      const now = Date.now();
      if(!room.lastNoPlayableRebroadcastAt || now - room.lastNoPlayableRebroadcastAt > 2500){
        room.lastNoPlayableRebroadcastAt = now;
        log(room, '⚠️ 出せるカードがない状態を検知したため、状態を再送しました。');
        broadcast(room);
        return;
      }
    }
  }

  // ピック候補選択中は最弱プレイヤーの選択待ち。CPUなら自動解決し、人間なら状態を再送する。
  // ただし候補選択者が切断したままだとゲームが止まるため、一定時間後にランダム候補で復旧する。
  if(room.pendingPick && room.pendingPick.targetSelectionRequired && !room.pendingPick.targetSelectionDone && !room.pendingPick.result){
    const pp = room.pendingPick;
    pp.createdAt = pp.createdAt || Date.now();
    autoResolveCpuPickTargets(room, pp);
    const roles=resolvedPickRoles(room,pp);
    const provider = room.players[roles.pickProviderPid];
    const now = Date.now();
    if(provider && !provider.cpu && !isPlayerConnectedForProgress(provider) && now - pp.createdAt > 12000){
      const ids = disconnectedPickTargetFallbackIds(room, pp);
      if(ids.length){
        log(room, `⚠️ ${provider.name} が切断中のため、ピック候補をランダムに選んで進行を復旧しました。`);
        submitPickTargets(room, provider.id, ids, true);
        return;
      }
    }
    if(!room.lastPickTargetRebroadcastAt || now - room.lastPickTargetRebroadcastAt > 4000){
      room.lastPickTargetRebroadcastAt = now;
      log(room, 'ピック候補選択待ちです。カードを取られる提供者は候補カードを選んでください。');
      broadcast(room);
      return;
    }
  }

  // ペア選択中は人間の選択待ちとして状態を再送する。
  // ただし選択者が切断したままだとゲームが止まるため、一定時間後にスキップ扱いで復旧する。
  if(room.pendingPick && room.pendingPick.pairChoice && !room.pendingPick.result){
    const pp = room.pendingPick;
    pp.pairChoiceAt = pp.pairChoiceAt || Date.now();
    const {pickerPid}=resolvedPickRoles(room,pp);
    const picker = room.players[pickerPid];
    const now = Date.now();
    if(picker && !picker.cpu && !isPlayerConnectedForProgress(picker) && now - pp.pairChoiceAt > 15000){
      log(room, `⚠️ ${picker.name} が切断中のため、ペア選択をスキップ扱いにして進行を復旧しました。`);
      completePickWithoutPair(room, pp, pp.pairChoice.drawn);
      return;
    }
    if(!room.lastPairChoiceRebroadcastAt || now - room.lastPairChoiceRebroadcastAt > 4000){
      room.lastPairChoiceRebroadcastAt = now;
      log(room, 'ペア選択待ちです。ペアにするカードを選ぶか、スキップしてください。');
      broadcast(room);
      return;
    }
  }

  // ピック結果が出ているのにpendingPickが残り続けている場合は進める。
  // 結果の種類に応じた演出時間を確保する。監視側も同じ関数を使い、
  // ババブタ・マッド・ペア演出の途中で進行を切らない。
  if(room.pendingPick && room.pendingPick.result){
    const age = Date.now() - (room.pendingPick.resultAt || Date.now());
    const expectedDelay = pickResultDisplayMs(room, room.pendingPick.result);
    const recoverAfter = expectedDelay + 1500;
    if(age > recoverAfter){
      log(room, '⚠️ ピック結果表示後に停止を検知したため、自動復旧しました。');
      finishAfterPick(room, resolvedPickRoles(room,room.pendingPick).trickWinnerPid);
      return;
    }
  }

  // 人間の通常手番でUI側が取りこぼした場合に備えて、出せるカードがある状態を定期再送する。
  if(!room.pendingPick && !room.trickReview && room.current != null && !room.players[room.current]?.cpu){
    const ids = playableIds(room, room.current);
    if(ids.size > 0){
      const now = Date.now();
      const currentPlayer = room.players[room.current];
      if(!isPlayerConnectedForProgress(currentPlayer)){
        currentPlayer.disconnectedAt = currentPlayer.disconnectedAt || now;
        if(now - currentPlayer.disconnectedAt >= DISCONNECTED_ACTION_GRACE_MS){
          const fallbackId = shuffle([...ids])[0];
          log(room, `⚠️ ${currentPlayer.name} が切断したままのため、合法手からランダムに1枚出して進行を復旧しました。`);
          playCard(room, currentPlayer.id, fallbackId);
          return;
        }
      }
      if(!room.lastHumanTurnRebroadcastAt || now - room.lastHumanTurnRebroadcastAt > 2500){
        room.lastHumanTurnRebroadcastAt = now;
        broadcast(room);
        return;
      }
    }
  }

  // CPU通常手番でタイマーが外れた場合は再予約。
  if(!room.pendingPick && !room.trickReview && isCpuTurn(room) && !room.cpuTimer){
    scheduleCpu(room);
    return;
  }

  // CPUピック待ちで止まっている場合は再予約。
  if(room.pendingPick && !room.pendingPick.result && room.players[resolvedPickRoles(room,room.pendingPick).pickerPid]?.cpu){
    ensureCpuPick(room);
    return;
  }

  // 人間のピック待ちでreadyAtを過ぎても画面が確認中のままにならないよう、状態を再送する。
  // 勝者が切断したままだとゲームが止まるため、一定時間後にランダム位置を選んで復旧する。
  if(room.pendingPick && !room.pendingPick.result && !room.pendingPick.pairChoice && !room.players[resolvedPickRoles(room,room.pendingPick).pickerPid]?.cpu){
    const pp = room.pendingPick;
    const roles=resolvedPickRoles(room,pp);
    const picker = room.players[roles.pickerPid];
    const now = Date.now();
    if(now >= pp.readyAt && picker && !isPlayerConnectedForProgress(picker) && now >= pp.readyAt + 12000){
      const candidates = pickCandidateCards(room, pp);
      const idx = candidates.length ? Math.floor(Math.random() * candidates.length) : 0;
      log(room, `⚠️ ${picker.name} が切断中のため、ランダムに1枚ピックして進行を復旧しました。`);
      doPick(room, picker.id, idx);
      return;
    }
    if(now >= pp.readyAt && !pp.readyBroadcasted){
      pp.readyBroadcasted = true;
      broadcast(room);
      return;
    }
    // クリック待ちが長すぎる場合はゲーム停止ではなく、再送だけする。
    if(now >= pp.readyAt + 12000){
      pp.readyBroadcasted = false;
      broadcast(room);
      return;
    }
  }

  // レビュー画面で止まっている/タイマーが外れている場合は復旧。
  if(room.trickReview){
    if(room.trickReview.until <= Date.now()){
      advanceReviewToPick(room, room.trickReview.until, room.trickReview.winnerPid, room.trickReview.weakestPid);
      return;
    }
    if(!room.reviewTimer && !room.reviewWatchTimer){
      log(room, '⚠️ トリック確認タイマーが外れていたため、再予約しました。');
      ensureReviewToPick(room, room.trickReview.until, room.trickReview.winnerPid, room.trickReview.weakestPid);
      return;
    }
  }
}

function clearCpuPickTimer(room){
  if(room.cpuPickTimer){
    clearTimeout(room.cpuPickTimer);
    room.cpuPickTimer = null;
  }
}

function ensureCpuPick(room){
  const pp = room.pendingPick;
  if(!pp || pp.result) return;
  if(pp.targetSelectionRequired && !pp.targetSelectionDone) return;
  const roles=resolvedPickRoles(room,pp);
  const picker = room.players[roles.pickerPid];
  const provider = room.players[roles.pickProviderPid];
  const candidates = pickCandidateCards(room, pp);
  if(!picker || !picker.cpu || !provider || !candidates.length) return;
  if(room.cpuPickTimer) return;

  // CPUがピック担当になったら、broadcast依存ではなく専用タイマーで必ず進行させる。
  const delay = Math.max(500, pp.readyAt - Date.now() + 450);
  const token = pp.readyAt;
  room.cpuPickTimer = setTimeout(()=>{
    room.cpuPickTimer = null;
    if(room.phase !== 'playing') return;
    if(!room.pendingPick || room.pendingPick.result) return;
    if(room.pendingPick.readyAt !== token) return;
    if(room.pendingPick.targetSelectionRequired && !room.pendingPick.targetSelectionDone) return;
    const currentRoles=resolvedPickRoles(room,room.pendingPick);
    const currentPicker = room.players[currentRoles.pickerPid];
    const currentCandidates = pickCandidateCards(room, room.pendingPick);
    if(!currentPicker || !currentPicker.cpu || !currentCandidates.length) return;
    doPick(room, currentPicker.id, chooseCpuPickIndex(room, room.pendingPick, currentCandidates));
  }, delay);
  room.cpuPickTimer.unref?.();

  // 念のためのフェイルセーフ。何らかの理由で上のタイマーが外れても、数秒後に自動復旧。
  if(room.cpuPickFailSafeTimer) clearTimeout(room.cpuPickFailSafeTimer);
  room.cpuPickFailSafeTimer = setTimeout(()=>{
    if(room.phase !== 'playing') return;
    if(!room.pendingPick || room.pendingPick.result) return;
    if(room.pendingPick.targetSelectionRequired && !room.pendingPick.targetSelectionDone) return;
    const currentRoles=resolvedPickRoles(room,room.pendingPick);
    const currentPicker = room.players[currentRoles.pickerPid];
    const currentCandidates = pickCandidateCards(room, room.pendingPick);
    if(!currentPicker || !currentPicker.cpu || !currentCandidates.length) return;
    log(room, '⚠️ CPUピックが遅延したため、自動復旧しました。');
    doPick(room, currentPicker.id, chooseCpuPickIndex(room, room.pendingPick, currentCandidates));
  }, Math.max(3500, delay + 3500));
  room.cpuPickFailSafeTimer.unref?.();
}


function isCpuTurn(room){ return room.phase==='playing' && room.current!=null && room.players[room.current]?.cpu && !room.pendingPick; }


function chooseCpuCard(room, pid){
  const allowed = [...playableIds(room, pid)];
  const player = room.players[pid];
  const hand = player.hand;
  const cards = allowed.map(id=>hand.find(c=>c.id===id)).filter(Boolean);
  if(!cards.length) return null;

  // 追加ルール込みの評価関数でカードを選ぶ。
  // かももどき=攻撃、ワクもどき=大胆、リクもどき=リスク管理。
  const scored = cards
    .map(card=>({card, score:cpuCardPlayScore(room, pid, card)}))
    .sort((a,b)=>b.score-a.score || a.card.val-b.card.val);

  return scored[0].card;
}



function scheduleCpu(room){
  if(room.cpuTimer) return;
  if(room.phase !== 'playing') return;
  if(room.trickReview && room.trickReview.until > Date.now()) return;
  const pp = room.pendingPick;
  if(pp && !pp.result){
    if(pp.targetSelectionRequired && !pp.targetSelectionDone){
      autoResolveCpuPickTargets(room, pp);
      return;
    }
    if(room.players[resolvedPickRoles(room,pp).pickerPid]?.cpu){
      ensureCpuPick(room);
      return;
    }
  }
  if(isCpuTurn(room)){
    room.cpuTimer = setTimeout(()=>{ room.cpuTimer=null; doCpuPlay(room); }, GAME_TIMING.cpuPlay);
    room.cpuTimer.unref?.();
  }
}

function doCpuPlay(room){
  if(!isCpuTurn(room)) return;
  const pid = room.current;
  const card = chooseCpuCard(room, pid);
  if(card){
    say(room, pid, cpuPlayLine(room, pid, card), cpuPlayCommentMeta(room, pid, card));
    playCard(room, room.players[pid].id, card.id);
  } else {
    if(!safeFinishBecauseNoPlayable(room, pid)){
      log(room, `⚠️ ${room.players[pid].name} が出せるカードを持っていないため、状態を再送しました。`);
      broadcast(room);
    }
  }
}

function doCpuPick(room){
  const pp = room.pendingPick;
  const roles=resolvedPickRoles(room,pp);
  if(!pp || pp.result || pp.pairChoice || !room.players[roles.pickerPid]?.cpu) return;
  if(pp.targetSelectionRequired && !pp.targetSelectionDone) return;
  const candidates = pickCandidateCards(room, pp);
  if(!candidates.length) return;
  doPick(room, room.players[roles.pickerPid].id, Math.floor(Math.random() * candidates.length));
}




function initializeMatch(room, {rematch=false}={}){
  clearAllProgressTimers(room);
  room.phase='playing';
  room.round=1;
  room.lead=Math.floor(Math.random()*4);
  room.current=room.lead;
  room.trick=[];
  room.leadSuit=null;
  room.pendingPick=null;
  room.trickReview=null;
  room.spotlightEvent=null;
  room.pendingSpotlightPlans=null;
  room.spotlightHistory=[];
  room.spotlightRoundCounts={};
  room.lastSpotlightSpeakerPid=null;
  room.stock=[];
  room.roundEndSummary=null;
  room.finalRoundSummary=null;
  room.roundEndOutPid=null;
  room.roundEndDeferred=null;
  room.initialPairDone=[];
  room.passDone=[];
  room.passSelections={};
  room.roundStart=null;
  room.shootPigRoundResults={};
  room.shootBlockedByUnmovedBabaResults={};
  room.shootPigEvent=null;
  room.madPigEvent=null;
  room.pairCleanEvent=null;
  room.cardPlayEvent=null;
  room.trickCollectEvent=null;
  room.babaMovedThisRound=false;
  room.babaMoveCountThisRound=0;
  room.babaMoveHistory=[];
  room.babaMoveEvent=null;
  room.lastHumanTurnRebroadcastAt=0;
  room.lastNoPlayableRebroadcastAt=0;
  for(const p of room.players){
    p.hand=[];p.scorePile=[];p.pairs=[];p.completedRoundCardScoreBank=0;p.jokerPenaltyBank=0;p.shootPigPenaltyBank=0;
    p.shootPigActivatedRounds=[];p.out=false;p.final=null;p.matchStats=newMatchStats();p.playEvaluation=[];
  }
  dealInitial(room);
  log(room, `${rematch?'同じメンバーで再戦！':'収穫祭スタート！'}${roomOptionSummary(room)}。通常カードを1枚抜き、全員13枚で開始します。`);

  if(room.passThreeEnabled){
    room.phase='passing';room.setupPhaseStartedAt=Date.now();room.current=null;
    room.message='3枚パス：ババブタ以外から3枚選んでください。';
    log(room, '3枚パスあり。各プレイヤーは次の手番の人へ通常カードを3枚渡します。ババブタは渡せません。');
    autoResolveCpuPasses(room);maybeFinishPassPhase(room);return true;
  }
  if(room.initialPairDiscardEnabled){
    room.phase='initialPair';room.setupPhaseStartedAt=Date.now();room.current=null;
    room.message='開始時ペア捨て：ペアを捨てるかスキップしてください。';
    log(room, '開始時ペア捨てあり。各プレイヤーは任意で手札の同じ数字ペアを捨てられます。');
    autoResolveCpuInitialPairs(room);maybeFinishInitialPairPhase(room);return true;
  }
  beginPlayingAfterSetup(room);
  return true;
}

function startGame(room, requesterId){
  if(!room || room.hostId !== requesterId) return false;
  // 開始メッセージの連打・遅延到着で、進行中のゲームを再配札しない。
  if(room.phase !== 'lobby') return false;
  if(room.players.length !== 4){
    room.message='4人そろうと開始できます。足りない席はCPUを追加してください。';broadcast(room);return false;
  }
  cancelRoomCleanup(room);
  return initializeMatch(room,{rematch:false});
}

function rematchGame(room, requesterId){
  if(!room || room.hostId !== requesterId || room.phase !== 'finished') return false;
  if(room.players.length !== 4){room.message='再戦には4人必要です。';broadcast(room);return false;}
  const missing=room.players.filter(p=>!p.cpu && !isPlayerConnectedForProgress(p));
  if(missing.length){room.message=`${missing.map(p=>p.name).join('・')} の再接続後に再戦できます。`;broadcast(room);return false;}
  cancelRoomCleanup(room);
  return initializeMatch(room,{rematch:true});
}


function dealInitial(room){
  let deck = makeDeck();
  const normals = deck.map((c,i)=>c.joker?-1:i).filter(i=>i>=0);
  const idx = normals[Math.floor(Math.random()*normals.length)];
  room.removedCard = deck.splice(idx,1)[0];
  shuffle(deck);
  for(let i=0;i<13;i++) for(let p=0;p<4;p++) room.players[p].hand.push(deck.pop());
  room.stock = deck;
  room.players.forEach(p=>sortHand(p.hand));
  log(room, `均一配札のため ${cardText(room.removedCard)} を箱に戻しました。`);
}


function passTargetPid(pid){
  return (Number(pid) + 1) % 4;
}

function passSourcePid(pid){
  return (Number(pid) + 3) % 4;
}

function passableCardIds(player){
  return (player.hand || []).filter(c=>c && !c.joker).map(c=>c.id);
}

function autoResolveCpuPasses(room){
  if(!room || room.phase !== 'passing') return;
  for(let i=0;i<room.players.length;i++){
    const p = room.players[i];
    if(!p.cpu) continue;
    if((room.passDone || []).includes(i)) continue;
    const chosen = (p.hand || []).filter(c=>c && !c.joker).slice(0,3).map(c=>c.id);
    submitPassThree(room, p.id, chosen, true);
  }
}

function allPassDone(room){
  return room.players.every((p,i)=>p.cpu || (room.passDone || []).includes(i));
}

function finishPassThreePhase(room){
  if(!room || room.phase !== 'passing') return;
  const transfers = [];
  for(let i=0;i<room.players.length;i++){
    const p = room.players[i];
    const rawIds = (room.passSelections && room.passSelections[i]) || [];
    const uniqueIds = [...new Set(rawIds.map(String))];
    let ids = uniqueIds.filter(id=>{
      const card=(p.hand || []).find(c=>c && String(c.id)===id);
      return !!card && !card.joker;
    });

    // 二重送信や古い画面からの送信で、同じIDが重複したり既に存在しないIDが
    // 混ざっても splice(-1) で別カードを抜かない。合法な3枚へ安全に補正する。
    if(ids.length !== 3){
      ids = passableCardIds(p).slice(0,3);
      if(ids.length !== 3){
        room.message = `${p.name} のパス可能なカードが3枚未満のため、3枚パスを安全に中断しました。`;
        log(room, `⚠️ ${p.name} の3枚パス選択を復旧できませんでした。`);
        broadcast(room);
        return;
      }
      room.passSelections[i]=ids;
      log(room, `⚠️ ${p.name} の3枚パス選択に重複または不正IDがあったため、合法な3枚へ自動補正しました。`);
    }
    transfers.push({from:i, to:passTargetPid(i), ids:[...ids]});
  }

  // 先に全員の手札から抜く。これで同時パス扱いになる。
  const moved = transfers.map(t=>{
    const fromP = room.players[t.from];
    const cards = [];
    for(const id of t.ids){
      const idx = fromP.hand.findIndex(c=>c && String(c.id)===String(id));
      if(idx < 0) continue;
      const [card] = fromP.hand.splice(idx,1);
      if(card) cards.push(card);
    }
    return {...t, cards};
  });

  if(moved.some(t=>t.cards.length!==3)){
    // ここへ到達するのは同時処理中に状態が壊れた場合だけ。抜いた札を戻して停止を防ぐ。
    for(const t of moved){
      room.players[t.from].hand.push(...t.cards);
      sortHand(room.players[t.from].hand);
    }
    room.message='3枚パス中に手札が更新されたため、選択をやり直してください。';
    room.passDone=[];
    room.passSelections={};
    log(room,'⚠️ 3枚パス中の手札更新を検知し、抜いたカードを元へ戻しました。');
    broadcast(room);
    return;
  }

  // 次の手番の人へ渡す。
  for(const t of moved){
    room.players[t.to].hand.push(...t.cards);
  }
  room.players.forEach(p=>sortHand(p.hand));
  room.passSelections = {};
  room.passDone = [];
  assertUniqueActiveCards(room, '3枚パス完了後');

  log(room, '🔁 全員が次の手番の人へ3枚パスしました！ 手札がぐるっと動きました！');

  if(room.initialPairDiscardEnabled){
    room.phase='initialPair';
    room.setupPhaseStartedAt=Date.now();
    room.current=null;
    room.message='3枚パス完了。開始時ペア捨てへ進みます。';
    log(room, '開始時ペア捨てあり。各プレイヤーは任意で手札の同じ数字ペアを捨てられます。');
    autoResolveCpuInitialPairs(room);
    maybeFinishInitialPairPhase(room);
    return;
  }

  beginPlayingAfterSetup(room);
}

function maybeFinishPassPhase(room){
  if(!room || room.phase !== 'passing') return;
  autoResolveCpuPasses(room);
  if(Date.now() - Number(room.setupPhaseStartedAt || Date.now()) > 30000){
    for(let i=0;i<room.players.length;i++){
      const p=room.players[i];
      if(p.cpu || (room.passDone || []).includes(i)) continue;
      const ids=shuffle(passableCardIds(p).slice()).slice(0,3);
      if(ids.length===3){
        const cause=isPlayerConnectedForProgress(p) ? '操作がなかった' : '切断中だった';
        log(room, `⚠️ ${p.name} は30秒間${cause}ため、3枚パスをランダム選択して進行を復旧しました。`);
        submitPassThree(room, p.id, ids, true);
      }
    }
  }
  if(allPassDone(room)) finishPassThreePhase(room);
  else broadcast(room);
}

function submitPassThree(room, playerId, cardIds, silent=false){
  if(!room || room.phase !== 'passing') return;
  const pid = room.players.findIndex(p=>p.id === playerId);
  if(pid < 0) return;
  if((room.passDone || []).includes(pid)) return;

  const ids = Array.isArray(cardIds) ? cardIds.map(String) : [];
  const unique = [...new Set(ids)];
  if(unique.length !== 3){
    if(!silent){ room.message='パスするカードを3枚選んでください。'; broadcast(room); }
    return;
  }

  const p = room.players[pid];
  const allowed = new Set(passableCardIds(p));
  for(const id of unique){
    if(!allowed.has(id)){
      if(!silent){ room.message='ババブタは渡せません。通常カードから3枚選んでください。'; broadcast(room); }
      return;
    }
  }

  if(!room.passSelections) room.passSelections = {};
  if(!room.passDone) room.passDone = [];
  room.passSelections[pid] = unique;
  room.passDone.push(pid);
  if(!silent){
    room.message = `${p.name} が3枚パスするカードを選びました。`;
    log(room, `🔁 ${p.name} が3枚パスを確定しました。`);
  }
  maybeFinishPassPhase(room);
}

function beginPlayingAfterSetup(room){
  if(!room) return;
  room.phase='playing';
  room.setupPhaseStartedAt=null;
  room.current=room.lead;
  room.roundStart = {round:1, text:`第1ラウンド開始！全${room.totalRounds || 3}ラウンド。3枚パス${room.passThreeEnabled ? 'あり' : 'なし'}。開始時ペア捨て${room.initialPairDiscardEnabled ? 'あり' : 'なし'}。`, expiresAt:Date.now()+6500};
  room.message=`第1ラウンド開始。${room.players[room.current].name} からリード。`;
  log(room, '🎬 第1ラウンドを開始します。勝負スタート！');
  announceCpuRoundStart(room);
  if(checkRoundEnd(room)) { broadcast(room); return; }
  broadcast(room);
}


function hasInitialPairCandidate(player){
  const counts = new Map();
  for(const c of player.hand || []){
    if(!c || c.joker) continue;
    counts.set(c.rank, (counts.get(c.rank)||0)+1);
    if(counts.get(c.rank) >= 2) return true;
  }
  return false;
}

function initialPairCandidatesFor(player, cardId){
  const card = (player.hand || []).find(c=>c && c.id === cardId);
  if(!card || card.joker) return [];
  return player.hand.filter(c=>c && !c.joker && c.rank === card.rank && c.id !== card.id);
}

function initialPairCandidateIds(player){
  const ids = new Set();
  const byRank = new Map();
  for(const c of player.hand || []){
    if(!c || c.joker) continue;
    if(!byRank.has(c.rank)) byRank.set(c.rank, []);
    byRank.get(c.rank).push(c);
  }
  for(const group of byRank.values()){
    if(group.length >= 2) group.forEach(c=>ids.add(c.id));
  }
  return [...ids];
}

function markInitialPairDone(room, pid){
  if(!room.initialPairDone) room.initialPairDone = [];
  if(!room.initialPairDone.includes(pid)) room.initialPairDone.push(pid);
}

function allInitialPairDone(room){
  return room.players.every((p,i)=>p.cpu || (room.initialPairDone || []).includes(i) || !hasInitialPairCandidate(p));
}

function autoResolveCpuInitialPairs(room){
  if(!room || room.phase !== 'initialPair') return;
  for(let i=0;i<room.players.length;i++){
    const p = room.players[i];
    if(!p.cpu) continue;
    // CPUは進行停止防止のため、開始時ペアを可能な限り自動で捨てる。
    let safety = 30;
    while(hasInitialPairCandidate(p) && safety-- > 0){
      const ids = initialPairCandidateIds(p);
      const first = p.hand.find(c=>ids.includes(c.id));
      const second = first ? initialPairCandidatesFor(p, first.id)[0] : null;
      if(!first || !second) break;
      discardInitialPair(room, p.id, first.id, second.id, true);
    }
    markInitialPairDone(room, i);
  }
}


function beginPlayingAfterInitialPairs(room){
  if(!room || room.phase !== 'initialPair') return;
  beginPlayingAfterSetup(room);
}


function maybeFinishInitialPairPhase(room){
  if(!room || room.phase !== 'initialPair') return;
  autoResolveCpuInitialPairs(room);
  if(Date.now() - Number(room.setupPhaseStartedAt || Date.now()) > 30000){
    for(let i=0;i<room.players.length;i++){
      const p=room.players[i];
      if(p.cpu || (room.initialPairDone || []).includes(i) || !hasInitialPairCandidate(p)) continue;
      markInitialPairDone(room, i);
      const cause=isPlayerConnectedForProgress(p) ? '操作がなかった' : '切断中だった';
      log(room, `⚠️ ${p.name} は30秒間${cause}ため、開始時ペア捨てをスキップして進行を復旧しました。`);
    }
  }
  if(allInitialPairDone(room)) beginPlayingAfterInitialPairs(room);
  else broadcast(room);
}

function discardInitialPair(room, playerId, cardAId, cardBId, silent=false){
  if(!room || room.phase !== 'initialPair') return;
  const pid = room.players.findIndex(p=>p.id === playerId);
  if(pid < 0) return;
  if((room.initialPairDone || []).includes(pid)) return;

  const p = room.players[pid];
  const ia = p.hand.findIndex(c=>c && c.id === cardAId);
  const ib = p.hand.findIndex(c=>c && c.id === cardBId);
  if(ia < 0 || ib < 0 || ia === ib){
    if(!silent){ room.message='ペアにするカードを選べませんでした。'; broadcast(room); }
    return;
  }
  const a = p.hand[ia], b = p.hand[ib];
  if(a.joker || b.joker || a.rank !== b.rank){
    if(!silent){ room.message='同じ数字の通常カードだけペアで捨てられます。'; broadcast(room); }
    return;
  }

  const hi = Math.max(ia, ib), lo = Math.min(ia, ib);
  const c1 = p.hand.splice(hi,1)[0];
  const c2 = p.hand.splice(lo,1)[0];
  const stats=matchStatsFor(p);
  stats.pairCleans++;
  stats.pairDangerCards+=[c1,c2].filter(card=>isMadPig(card) || Number(card?.val || 0)>=11).length;
  p.pairs.push(c1, c2);
  sortHand(p.hand);
  // 開始時ペアはランクだけが従来から公開情報。スートを追加で漏らさないため、
  // 演出イベントにはカード実体を含めず同じ数字の2枚として見せる。
  registerPairCleanEvent(room, pid, [c1,c2], 'initial', false);
  assertUniqueActiveCards(room, '開始時ペア捨て後');

  if(!silent){
    room.message = `${p.name} が開始時ペアとして ${a.rank} を捨てました。`;
    log(room, `🧹 ${room.message}`);
  }
  if(!hasInitialPairCandidate(p)) markInitialPairDone(room, pid);
  // CPUの連続ペア処理中は親ループへ戻す。ここから再帰すると、
  // ペアが多い配札で maybeFinishInitialPairPhase が深く入れ子になる。
  if(!silent) maybeFinishInitialPairPhase(room);
}

function skipInitialPairs(room, playerId){
  if(!room || room.phase !== 'initialPair') return;
  const pid = room.players.findIndex(p=>p.id === playerId);
  if(pid < 0) return;
  markInitialPairDone(room, pid);
  room.message = `${room.players[pid].name} は開始時ペア捨てをスキップしました。`;
  log(room, `⏭️ ${room.message}`);
  maybeFinishInitialPairPhase(room);
}


function playableIds(room, pid){
  pid = Number(pid);
  const p = room.players[pid]; if(!p) return new Set();
  if(room.phase !== 'playing' || room.pendingPick || room.trickReview) return new Set();
  if(Number(room.current) !== pid) return new Set();

  // ババブタは場に出せない。通常カードがない場合は出せるカードなし。
  const nonJoker = p.hand.filter(c=>c && !c.joker);
  if(!nonJoker.length) return new Set();

  // リードスート未設定＝トリック先頭。通常カードなら何でも出せる。
  if(!room.leadSuit) return new Set(nonJoker.map(c=>c.id));

  // マストフォロー。
  const follow = p.hand.filter(c=>c && !c.joker && c.suit===room.leadSuit);
  return new Set((follow.length ? follow : nonJoker).map(c=>c.id));
}
function playCard(room, playerId, cardId){
  const pid = room.players.findIndex(p=>p.id===playerId);
  const allowed = playableIds(room, pid);
  if(!allowed.has(cardId)) { room.message='そのカードは出せません。マストフォロー、またはババブタ不可を確認！'; broadcast(room); return; }
  const p = room.players[pid];
  const idx = p.hand.findIndex(c=>c && c.id===cardId);
  if(idx < 0){
    room.message='そのカードは手札に見つかりません。画面を更新します。';
    log(room, `⚠️ ${p.name} が存在しないカードを出そうとしたため、状態を再送しました。`);
    broadcast(room);
    return;
  }
  const card = p.hand.splice(idx,1)[0];
  const stats=matchStatsFor(p);
  if(room.leadSuit && card.suit!==room.leadSuit && !p.hand.some(c=>c && !c.joker && c.suit===room.leadSuit)) stats.voidCount++;
  room.lastHumanTurnRebroadcastAt = 0;
  if(!room.leadSuit) room.leadSuit = card.suit;
  room.trick.push({pid, card, order:room.trick.length});
  room.cardPlayEvent={
    eventId:`play-${room.round || 1}-${pid}-${uid()}`,pid,card,order:room.trick.length-1,
    createdAt:Date.now()
  };
  assertUniqueActiveCards(room, 'カードプレイ後');
  room.message = `${p.name} が ${cardText(card)} を出しました。`;
  log(room, room.message);
  // ババブタ1枚だけになった場合は即終了候補にしない。次にその人の手番が来るまではピックまで進める。
  if(isEmptyHand(p) && room.trick.length < 4) rememberEndAfterTrick(room, pid);
  if(room.trick.length===4) resolveTrick(room); else room.current=(pid+1)%4;
  broadcast(room);
}

function validTrickEntry(room, entry){
  return !!entry
    && Number.isInteger(entry.pid)
    && entry.pid >= 0
    && entry.pid < (room?.players?.length || 0)
    && !!entry.card
    && !entry.card.joker
    && suits.includes(entry.card.suit)
    && Number.isFinite(Number(entry.card.val));
}

function restoreTrickCardsToOwners(room, entries){
  if(!room || !Array.isArray(entries)) return 0;
  const active=collectActiveFaceKeys(room);
  let restored=0;
  for(const entry of entries){
    if(!entry?.card || !Number.isInteger(entry.pid)) continue;
    const owner=room.players?.[entry.pid];
    if(!owner || !Array.isArray(owner.hand)) continue;
    const key=cardFaceKey(entry.card);
    if(key==='NULL' || active.has(key)) continue;
    owner.hand.push(entry.card);
    active.add(key);
    restored++;
  }
  room.players?.forEach(p=>sortHand(p.hand));
  return restored;
}

function cancelCorruptTrick(room, entries, reason){
  room.trick=[];
  const restored=restoreTrickCardsToOwners(room, entries);
  room.leadSuit=null;
  room.current=Number.isInteger(room.lead) && room.players?.[room.lead] ? room.lead : 0;
  room.trickReview=null;
  room.pendingPick=null;
  room.message='場札の状態を安全に復旧し、リードからやり直します。';
  log(room, `⚠️ ${reason}。有効な場札${restored}枚を持ち主へ戻し、トリックをやり直します。`);
}

function judgeWeakestCard(room, leadSuit, trickEntries=null){
  const valid=(Array.isArray(trickEntries) ? trickEntries : room?.trick || [])
    .filter(x=>validTrickEntry(room,x));
  if(!valid.length || !suits.includes(leadSuit)) return null;

  // 非リードスートが1枚でもあれば、その中の最小値。同値は後出しが最弱。
  // 全員フォローなら場全体の最小値。同値処理は防御分岐として維持する。
  const offSuit = valid.filter(x=>x.card.suit !== leadSuit);
  const candidates = offSuit.length ? offSuit : valid;

  return candidates.slice().sort((a,b)=>{
    const av=Number(a.card.val), bv=Number(b.card.val);
    if(av !== bv) return av - bv;
    return Number(b.order ?? 0) - Number(a.order ?? 0);
  })[0] || null;
}

function resolveTrick(room){
  if(!room.trick || room.trick.length < 4){
    log(room, '⚠️ トリック解決に必要な4枚が揃っていないため、処理を中断しました。');
    return false;
  }

  // 5枚目以降は消さず、必ず持ち主へ戻す。
  if(room.trick.length > 4){
    const extras=room.trick.splice(4);
    const restored=restoreTrickCardsToOwners(room, extras);
    log(room, `⚠️ 場に余分な${extras.length}枚があったため、${restored}枚を持ち主の手札へ戻して先頭4枚で復旧しました。`);
  }

  const core=room.trick.slice(0,4);
  const valid=core.filter(x=>validTrickEntry(room,x));
  const distinctPids=new Set(valid.map(x=>x.pid));
  const distinctCards=new Set(valid.map(x=>cardFaceKey(x.card)));
  if(valid.length!==4 || distinctPids.size!==4 || distinctCards.size!==4){
    cancelCorruptTrick(room, core, '場札に無効カード・同一プレイヤーの重複・カード重複を検知しました');
    broadcast(room);
    return false;
  }

  // 実際に最初に置かれたカードを正とする。保存中のleadSuitが有効文字列でも
  // 場札と食い違う場合は、そのまま使うと勝者が誤るため復元する。
  const leadEntry=core.slice().sort((a,b)=>Number(a.order ?? 0)-Number(b.order ?? 0))[0] || core[0];
  const leadSuit=leadEntry.card.suit;
  if(room.leadSuit !== leadSuit){
    log(room, `⚠️ リードスート情報を場の先頭カード（${suitName(leadSuit)}）から復元しました。`);
  }
  room.leadSuit=leadSuit;

  const winner=core
    .filter(x=>x.card.suit===leadSuit)
    .sort((a,b)=>Number(b.card.val)-Number(a.card.val))[0] || null;
  const weakest=judgeWeakestCard(room, leadSuit, core);
  if(!winner || !weakest || !room.players[winner.pid] || !room.players[weakest.pid]){
    cancelCorruptTrick(room, core, '勝者または最弱を確定できませんでした');
    broadcast(room);
    return false;
  }

  const wp = room.players[winner.pid], lp = room.players[weakest.pid];
  const winnerStats=matchStatsFor(wp), weakestStats=matchStatsFor(lp);
  winnerStats.trickWins++;
  weakestStats.weakestCount++;
  winnerStats.feastCardsWon+=core.length;
  winnerStats.feastPointsWon+=core.length*normalizeFeastPointPerCard(room.feastPointPerCard);
  if(room.players.reduce((sum,p)=>sum+(p.hand?.length || 0),0)<=20) winnerStats.endgameTrickWins++;
  if(Number(winner.card.val)>=11) winnerStats.highCardWins++;
  if(Number(winner.card.val)<=6) winnerStats.efficientLowWins++;

  // トリックの最終盤面を見せるため、ここではまだピック画面に遷移しない。
  const reviewUntil = Date.now() + GAME_TIMING.trickReview;
  room.current = null;
  room.trickReview = {winnerPid:winner.pid, weakestPid:weakest.pid, until:reviewUntil};
  room.lastTrick = {
    winnerPid:winner.pid,
    weakestPid:weakest.pid,
    winnerName:wp.name,
    weakestName:lp.name,
    winnerCard:cardText(winner.card),
    weakestCard:cardText(weakest.card),
    feastCardCount:core.length,
    feastPointPerCard:normalizeFeastPointPerCard(room.feastPointPerCard),
    feastScore:core.length * normalizeFeastPointPerCard(room.feastPointPerCard),
    eventId:`feast-${room.round || 1}-${winner.pid}-${uid()}`,
    expiresAt:reviewUntil + 3000
  };
  room.trickCollectEvent={
    eventId:room.lastTrick.eventId,winnerPid:winner.pid,weakestPid:weakest.pid,
    cards:core.map(entry=>entry.card),feastCardCount:core.length,
    feastScore:core.length*normalizeFeastPointPerCard(room.feastPointPerCard),createdAt:Date.now()
  };

  const prospectivePick={trickWinnerPid:winner.pid,trickWeakestPid:weakest.pid};
  const prospectiveRoles=resolvedPickRoles(room,prospectivePick);
  if(wp.cpu) say(room, winner.pid, prospectiveRoles.pickProviderPid===winner.pid
    ? cpuPickRoleLine(room,winner.pid,prospectivePick,'provider')
    : cpuPickRoleLine(room,winner.pid,prospectivePick,'picker'), {eventKey:'trick-win'});
  if(lp.cpu && lp.hand.length>0) say(room, weakest.pid, prospectiveRoles.pickProviderPid===weakest.pid
    ? cpuPickRoleLine(room,weakest.pid,prospectivePick,'provider')
    : cpuPickRoleLine(room,weakest.pid,prospectivePick,'picker'), {eventKey:'trick-weak'});
  const watcher = room.players.find((p,i)=>p.cpu && i!==winner.pid && i!==weakest.pid);
  if(watcher && cpuCommentChance(room, cpuPersonalityWeights(watcher).talk)){
    const wi = room.players.indexOf(watcher);
    const line = cpuStrategyLineFor(room, wi, 'watchDrama', {winner:wp.name, weakest:lp.name, target:lp.name});
    if(line) say(room, wi, line, {eventKey:'watch'});
  }
  wp.scorePile.push(...core.map(x=>x.card));
  const capturedMadPig = room.madPigEnabled !== false ? core.map(x=>x.card).find(isMadPig) : null;
  if(capturedMadPig) registerMadPigEvent(room, winner.pid, capturedMadPig, 'trick');
  room.pendingSpotlightPlans = spotlightPlansAfterTrick(room, winner.pid, weakest.pid, winner.card, weakest.card, {capturedMadPig:!!capturedMadPig});
  const feastScore=core.length * normalizeFeastPointPerCard(room.feastPointPerCard);
  log(room, `👑 ${wp.name} が勝利。🍽️ ごちそう${core.length}枚を獲得（＋${feastScore}点）。`);
  log(room, `💀 最弱は ${lp.name}（${cardText(weakest.card)}）。`);
  room.message = `トリック終了！ 👑勝者は ${wp.name}、💀最弱は ${lp.name}。🍽️ ${core.length}枚で＋${feastScore}点。約3秒後にピックへ進みます。`;

  const reviewToken = reviewUntil;
  ensureReviewToPick(room, reviewToken, winner.pid, weakest.pid);
  return true;
}


function findPairCandidates(player, drawn){
  if(!player || !drawn || drawn.joker) return [];
  return (player.hand || []).filter(c=>c && !c.joker && c.rank === drawn.rank && c.id !== drawn.id);
}

function completePickWithoutPair(room, pp, drawn){
  const roles=resolvedPickRoles(room,pp);
  const picker = room.players[roles.pickerPid];
  const babaMoveNote=drawn.joker && normalizeShootRequiresBabaMoved(room.shootRequiresBabaMoved)
    ? ' 🌕このラウンドのシュート移動条件クリア！'
    : '';
  const text = drawn.joker
    ? `${picker.name} はババブタを引いた！${babaMoveNote}`
    : `${picker.name} は ${cardText(drawn)} を手札に加えた。`;
  pp.pairChoice = null;
  pp.result = {eventId:`pick-${room.round || 1}-${roles.pickerPid}-${uid()}`, drawn, paired:false, skipped:true, text, pickerPid:roles.pickerPid, pickProviderPid:roles.pickProviderPid, babaMoved:!!drawn.joker, babaMoveRequirementCleared:!!(drawn.joker && normalizeShootRequiresBabaMoved(room.shootRequiresBabaMoved))};
  pp.resultAt = Date.now();
  if(room.madPigEnabled !== false && isMadPig(drawn)) registerMadPigEvent(room, roles.pickerPid, drawn, 'pick');
  log(room, `🐽 ${text}`);
  if(picker.cpu) say(room, roles.pickerPid, resultLine(drawn, false, room, roles.pickerPid), {eventKey:drawn.joker?'baba':'pick',intensity:drawn.joker?'critical':'medium'});
  else if(drawn.joker){
    const cpu = room.players.find((p,i)=>p.cpu && i!==roles.pickerPid);
    if(cpu){ const ci=room.players.indexOf(cpu); say(room, ci, cpuStrategyLineFor(room, ci, 'babaReveal', {target:picker.name, drawn}) || resultLine(drawn, false, room, ci), {eventKey:'baba'}); }
  }
  room.message = text;
  const spotlightTiming = spotlightTimingAfterPick(room, drawn, false);
  triggerSpotlight(room, [...(room.pendingSpotlightPlans || []), ...spotlightPlansAfterPick(room, pp, drawn, false)], {source:'pick', ...spotlightTiming});
  room.pendingSpotlightPlans = null;
  broadcast(room);
  ensurePickFinish(room, pp, roles.trickWinnerPid, pickResultDisplayMs(room, pp.result));
}

function completePickWithPair(room, pp, drawn, pairCard){
  const roles=resolvedPickRoles(room,pp);
  const picker = room.players[roles.pickerPid];
  const drawnIdx = picker.hand.findIndex(c=>c && c.id===drawn.id);
  const pairIdx = picker.hand.findIndex(c=>c && c.id===pairCard.id);
  if(drawnIdx < 0 || pairIdx < 0 || drawnIdx === pairIdx) return false;

  const first = picker.hand.splice(Math.max(drawnIdx, pairIdx),1)[0];
  const second = picker.hand.splice(Math.min(drawnIdx, pairIdx),1)[0];
  const pairedCards = [first, second];
  const stats=matchStatsFor(picker);
  stats.pairCleans++;
  stats.pairDangerCards+=pairedCards.filter(card=>isMadPig(card) || Number(card?.val || 0)>=11).length;
  picker.pairs.push(...pairedCards);
  sortHand(picker.hand);

  const text = `${picker.name} は ${drawn.rank} のおそろいペアを選んで浄化！`;
  pp.pairChoice = null;
  pp.result = {eventId:`pick-${room.round || 1}-${roles.pickerPid}-${uid()}`, drawn, paired:true, skipped:false, pairCard, text, pickerPid:roles.pickerPid, pickProviderPid:roles.pickProviderPid};
  pp.resultAt = Date.now();
  registerPairCleanEvent(room, roles.pickerPid, pairedCards, 'pick', true);
  log(room, `🐽 ${text}`);
  if(picker.cpu) say(room, roles.pickerPid, resultLine(drawn, true, room, roles.pickerPid), {eventKey:'pair'});
  else {
    const cpu = room.players.find((p,i)=>p.cpu && i!==roles.pickerPid);
    if(cpu){ const ci=room.players.indexOf(cpu); say(room, ci, resultLine(drawn, true, room, ci), {eventKey:'pair'}); }
  }
  room.message = text;
  const spotlightTiming = spotlightTimingAfterPick(room, drawn, true);
  triggerSpotlight(room, [...(room.pendingSpotlightPlans || []), ...spotlightPlansAfterPick(room, pp, drawn, true)], {source:'pick', ...spotlightTiming});
  room.pendingSpotlightPlans = null;
  assertUniqueActiveCards(room, 'ペア選択後');
  broadcast(room);
  ensurePickFinish(room, pp, roles.trickWinnerPid, pickResultDisplayMs(room, pp.result));
  return true;
}

function resolvePairChoice(room, playerId, selectedCardId, skip=false){
  const pp = room.pendingPick;
  if(!pp || pp.result || !pp.pairChoice) return;
  const chooserPid = room.players.findIndex(p=>p.id===playerId);
  const roles=resolvedPickRoles(room,pp);
  if(chooserPid !== roles.pickerPid) return;

  const picker = room.players[roles.pickerPid];
  const drawn = pp.pairChoice.drawn;
  if(!picker || !drawn) return;

  if(skip){
    completePickWithoutPair(room, pp, drawn);
    return;
  }

  const pairCard = pp.pairChoice.candidates.find(c=>c && c.id === selectedCardId);
  if(!pairCard){
    room.message='ペアにするカードを選べませんでした。もう一度選んでください。';
    broadcast(room);
    return;
  }
  if(pairCard.rank !== drawn.rank || pairCard.joker){
    room.message='同じ数字の通常カードだけペアにできます。';
    broadcast(room);
    return;
  }
  completePickWithPair(room, pp, drawn, pairCard);
}



function submitPickTargets(room, playerId, cardIds, silent=false){
  const pp = room.pendingPick;
  if(!pp || pp.result || pp.pairChoice) return false;
  if(!pp.targetSelectionRequired || pp.targetSelectionDone) return false;

  const requesterPid = room.players.findIndex(p=>p.id===playerId);
  const roles=resolvedPickRoles(room,pp);
  if(requesterPid !== roles.pickProviderPid) return false;

  const provider = room.players[roles.pickProviderPid];
  const picker = room.players[roles.pickerPid];
  if(!provider || !picker) return false;

  const ids = Array.isArray(cardIds) ? [...new Set(cardIds.map(String))] : [];
  const needed = Math.min(pp.targetCount || 0, provider.hand.length);

  if(ids.length !== needed){
    room.message = `ピック候補を${needed}枚選んでください。`;
    broadcast(room);
    return false;
  }

  const handIds = new Set(provider.hand.map(c=>c.id));
  if(!ids.every(id=>handIds.has(id))){
    room.message = 'ピック候補にできないカードが含まれています。';
    broadcast(room);
    return false;
  }

  const mandatory=forcedJokerCandidateIds(room,provider);
  if(mandatory.some(id=>!ids.includes(id))){
    room.message='ババブタはルールにより必須候補です。候補から外せません。';
    log(room, `⚠️ ${provider.name} から必須ババ候補を除外する送信を拒否しました。`);
    broadcast(room);
    return false;
  }

  pp.targetCandidateIds = shuffleIds(ids);
  pp.pickOrderIds = pp.targetCandidateIds.slice();
  pp.targetSelectionDone = true;
  pp.readyAt = Date.now() + GAME_TIMING.pickTargetConfirm;
  room.message = `${provider.name} がピック候補を${ids.length}枚に絞りました。${picker.name} が選びます。`;
  log(room, `🎯 提供者 ${provider.name} がピック候補を${ids.length}枚に絞りました。`);
  if(!silent && provider.cpu) say(room, roles.pickProviderPid, cpuPickRoleLine(room,roles.pickProviderPid,pp,'provider'), {eventKey:'target-select'});
  const line = cpuPickLine(room, pp); if(line && picker.cpu) say(room, roles.pickerPid, line, {eventKey:'pick'});
  ensureCpuPick(room);
  broadcast(room);
  const pickToken=pp.token;
  scheduleRoomTask(room, `target-ready-${pickToken}-1`, GAME_TIMING.pickTargetConfirm+50, ()=>{
    if(room.phase==='playing' && room.pendingPick?.token===pickToken) broadcast(room);
  });
  scheduleRoomTask(room, `target-ready-${pickToken}-2`, GAME_TIMING.pickTargetConfirm+400, ()=>{
    if(room.phase==='playing' && room.pendingPick?.token===pickToken) broadcast(room);
  });
  return true;
}


function doPick(room, playerId, targetIndex){
  const pp = room.pendingPick; if(!pp || pp.result || pp.pairChoice) return;
  const chooserPid = room.players.findIndex(p=>p.id===playerId);
  const roles=resolvedPickRoles(room,pp);
  if(chooserPid !== roles.pickerPid) return;
  if(pp.targetSelectionRequired && !pp.targetSelectionDone) return;
  if(Date.now() < pp.readyAt){
    const remaining=Math.max(1,Math.ceil((pp.readyAt-Date.now())/1000));
    room.message=`ピック準備中です。あと${remaining}秒お待ちください。`;
    broadcast(room);
    return;
  }
  const picker = room.players[roles.pickerPid], provider = room.players[roles.pickProviderPid];
  if(!picker || !provider){
    log(room, '⚠️ ピック対象のプレイヤー情報が不正だったため、ピックを終了します。');
    finishAfterPick(room, roles.trickWinnerPid);
    return;
  }
  if(provider.hand.length<=0){
    log(room, '⚠️ カード提供者の手札が空だったため、ピックなしで進行します。');
    finishAfterPick(room, roles.trickWinnerPid);
    return;
  }

  const candidates = pickCandidateCards(room, pp);
  if(!candidates.length){
    log(room, '⚠️ ピック候補が空だったため、全手札から復旧してピックします。');
    pp.targetCandidateIds = null;
  }
  const actualCandidates = pickCandidateCards(room, pp);
  if(!actualCandidates.length){
    finishAfterPick(room, roles.trickWinnerPid);
    return;
  }

  if(targetIndex < 0 || targetIndex >= actualCandidates.length || Number.isNaN(targetIndex)) targetIndex = Math.floor(Math.random()*actualCandidates.length);
  const chosen = actualCandidates[targetIndex];
  const handIndex = provider.hand.findIndex(c=>c && c.id === chosen.id);
  if(handIndex < 0){
    log(room, '⚠️ ピック候補カードが手札に見つからないため、ピックなしで進行します。');
    finishAfterPick(room, roles.trickWinnerPid);
    return;
  }
  const drawn = provider.hand.splice(handIndex,1)[0];
  if(!drawn){
    log(room, '⚠️ ピックカード取得に失敗したため、ピックなしで進行します。');
    finishAfterPick(room, roles.trickWinnerPid);
    return;
  }

  // まず引いたカードを手札に加える。その後、同じ数字のカードがあればペアにするかスキップするかを選ぶ。
  const providerStats=matchStatsFor(provider), pickerStats=matchStatsFor(picker);
  const summary=matchCardSummary(room,drawn);
  providerStats.transferredCards.push(summary);
  pickerStats.receivedCards.push(summary);
  if(drawn.joker){
    providerStats.babaTransferred++;pickerStats.babaReceived++;
    if(pp.forcedJokerCandidate){
      providerStats.babaForcedTransferCount++;
    }
    // 候補入りだけでは数えない。provider→pickerへ所有権が移ったこの瞬間だけ記録する。
    if(roles.pickProviderPid!==roles.pickerPid){
      room.babaMovedThisRound=true;
      room.babaMoveCountThisRound=Number(room.babaMoveCountThisRound||0)+1;
      room.babaMoveHistory=Array.isArray(room.babaMoveHistory)?room.babaMoveHistory:[];
      const moveEvent={
        eventId:`baba-move-${room.round || 1}-${room.babaMoveCountThisRound}-${uid()}`,
        round:room.round || 1,count:room.babaMoveCountThisRound,
        providerPid:roles.pickProviderPid,pickerPid:roles.pickerPid,
        forced:!!pp.forcedJokerCandidate,expiresAt:Date.now()+5200
      };
      room.babaMoveHistory.push(moveEvent);
      room.babaMoveHistory=room.babaMoveHistory.slice(-24);
      room.babaMoveEvent=moveEvent;
      log(room, `🃏 ババブタが ${provider.name} → ${picker.name} へ移動（今ラウンド${room.babaMoveCountThisRound}回目）。${normalizeShootRequiresBabaMoved(room.shootRequiresBabaMoved)?'シュート移動条件クリア。':''}`);
    }
  }
  if(summary.mad){ providerStats.madTransferred++;pickerStats.madReceived++; }
  picker.hand.push(drawn);
  sortHand(picker.hand); sortHand(provider.hand);
  assertUniqueActiveCards(room, 'ピック直後');

  const candidatesForPair = findPairCandidates(picker, drawn);

  if(!drawn.joker && candidatesForPair.length){
    pp.pairChoice = {drawn, candidates:candidatesForPair};
    pp.pairChoiceAt = Date.now();
    pp.resultAt = null;
    const text = `${picker.name} は ${cardText(drawn)} を引いた。ペアにするカードを選べます。`;
    log(room, `🐽 ${text}`);
    room.message = text;

    // CPUは停止しないよう、同じ数字があれば先頭候補で自動ペア浄化する。
    if(picker.cpu){
      const pairToken=pp.token || `pair-${pp.createdAt || Date.now()}-${roles.pickerPid}`;
      scheduleRoomTask(room, `cpu-pair-${pairToken}`, GAME_TIMING.cpuPairChoice, ()=>{
        if(room.phase === 'playing' && room.pendingPick === pp && pp.pairChoice && !pp.result){
          completePickWithPair(room, pp, drawn, chooseCpuPairCardForDiscard(room, picker, drawn, candidatesForPair) || candidatesForPair[0]);
        }
      });
    }

    broadcast(room);
    return;
  }

  completePickWithoutPair(room, pp, drawn);
}


function finishAfterPick(room, winnerPid){
  clearReviewTimer(room);
  clearPickFinishTimer(room);
  clearCpuPickTimer(room);
  const fallbackPlans=Array.isArray(room.pendingSpotlightPlans) ? room.pendingSpotlightPlans.slice() : [];
  room.pendingSpotlightPlans=null;
  if(room.cpuPickFailSafeTimer){ clearTimeout(room.cpuPickFailSafeTimer); room.cpuPickFailSafeTimer=null; }
  if(!room.pendingPick && !room.trick.length) return;
  room.pendingPick=null;
  room.lastPickTargetRebroadcastAt=0;
  room.lastPairChoiceRebroadcastAt=0;
  // ピック結果用の専用演出はここで完了済み。次トリックへの再接続時に
  // 古いペア／マッド演出を再生しないよう、公開状態から取り除く。
  room.pairCleanEvent=null;
  room.madPigEvent=null;
  if(checkRoundEnd(room)){ room.spotlightEvent=null; broadcast(room); return; }
  if(!room.spotlightEvent && fallbackPlans.length){
    triggerSpotlight(room,fallbackPlans,{source:'trick',durationMs:SPOTLIGHT_DISPLAY_MS});
  }
  room.trick=[];room.leadSuit=null;
  if(!Number.isInteger(winnerPid) || winnerPid<0 || winnerPid>=room.players.length) winnerPid=room.lead ?? 0;
  room.lead=winnerPid;room.current=winnerPid;
  if(checkRoundEnd(room,winnerPid)){room.spotlightEvent=null;broadcast(room);return;}
  room.message=`${room.players[winnerPid].name} が次のリードです。`;
  broadcast(room);
}







function makeRoundSnapshot(room, reasonPid, reasonText){
  const useMadPig = room.madPigEnabled !== false;
  const jokerPenaltyValue = room.jokerPenalty ?? 20;
  const jokerPenaltyTiming = normalizeJokerPenaltyTiming(room.jokerPenaltyTiming);
  const shootPigResult = applyShootThePigForRound(room);
  const shootBlockedByUnmovedBaba=room.shootBlockedByUnmovedBabaResults?.[String(room.round || 1)] || null;
  const penaltyMode = normalizePenaltyMode(room.penaltyMode);
  const rows = room.players.map((p,i)=>{
    const pileCardCount = p.scorePile.length;
    const pileScore = feastPileScore(room,p);
    const normalHand = p.hand.filter(c=>c && !c.joker).length;
    const hasJoker = playerHasJoker(p);
    const hasMadPigForShoot = playerHasMadPigInHand(room, p);
    const madPigHand = useMadPig ? p.hand.filter(c=>c && !c.joker && c.suit===MUD_SUIT && c.rank==='11').length : 0;
    const madPigPile = useMadPig ? p.scorePile.filter(c=>c && !c.joker && c.suit===MUD_SUIT && c.rank==='11').length : 0;
    const madPig = madPigHand + madPigPile;
    const shootThePig = !!(shootPigResult && shootPigResult.shooterPid === i);
    const shootPigMadPigWaived = shootThePig;

    const roundJokerPenalty = (jokerPenaltyTiming === 'perRound' && hasJoker && !shootThePig) ? jokerPenaltyValue : 0;
    const pendingFinalJokerPenalty = (jokerPenaltyTiming === 'gameEnd' && hasJoker && !shootThePig) ? jokerPenaltyValue : 0;
    if(roundJokerPenalty){
      p.jokerPenaltyBank = (p.jokerPenaltyBank || 0) + roundJokerPenalty;
    }
    const jokerPenaltyTotal = jokerPenaltyTiming === 'perRound' ? (p.jokerPenaltyBank || 0) : 0;
    const jokerPenalty = jokerPenaltyTiming === 'perRound' ? roundJokerPenalty : 0;
    const rawMadPigPenalty = madPigPenaltyForRoom(room, p);
    const madPigPenalty = shootPigMadPigWaived ? 0 : rawMadPigPenalty;
    const rawHandPenalty = handPenaltyForRoom(room, p);
    const handPenalty = adjustHandPenaltyForShootThePig(room, p, rawHandPenalty, shootPigMadPigWaived);
    const shootPigPenalty = p.shootPigPenaltyBank || 0;
    const completedRoundCardScore = Number(p.completedRoundCardScoreBank || 0);
    const currentRoundCardScore = pileScore - handPenalty - madPigPenalty;
    const total = completedRoundCardScore + currentRoundCardScore - jokerPenaltyTotal - shootPigPenalty;
    return {
      pid:i,
      name:p.name,
      avatar:p.cpu ? cpuAvatar(p) : p.avatar,
      handCount:p.hand.length,
      normalHand,
      hasJoker,
      hasMadPigForShoot,
      pile:pileCardCount,
      pileCardCount,
      pairs:Math.floor(p.pairs.length/2),
      madPig,
      madPigHand,
      madPigPile,
      pileScore,
      handPenalty,
      rawHandPenalty,
      madPigPenalty,
      rawMadPigPenalty,
      jokerPenalty,
      jokerPenaltyTotal,
      pendingFinalJokerPenalty,
      shootThePig,
      shootUsed:playerHasUsedShootThePig(p),
      shootActivationCount:playerShootActivationCount(p),
      shootLimitReached:playerShootLimitReached(room,p),
      shootPigMadPigWaived,
      shootPigPenalty,
      shootPigPenaltyTotal: shootPigPenalty,
      completedRoundCardScore,
      currentRoundCardScore,
      total
    };
  });
  return {
    round: room.round,
    reasonPid,
    reasonName: room.players[reasonPid]?.name || '',
    reasonText,
    madPigEnabled: useMadPig,
    shootThePigEnabled: shootThePigEnabled(room),
    shootThePigLimit: shootThePigLimit(room),
    shootRequiresBabaMoved:normalizeShootRequiresBabaMoved(room.shootRequiresBabaMoved),
    babaMovedThisRound:!!room.babaMovedThisRound,
    babaMoveCountThisRound:Number(room.babaMoveCountThisRound || 0),
    shootPigResult,
    shootBlockedByUnmovedBaba,
    jokerPenaltyValue,
    jokerPenaltyTiming,
    penaltyMode,
    feastPointPerCard:normalizeFeastPointPerCard(room.feastPointPerCard),
    roundDealMode:normalizeRoundDealMode(room.roundDealMode),
    rows,
    createdAt: Date.now()
  };
}

function recordRoundStats(room,snapshot){
  for(const row of snapshot?.rows || []){
    const player=room.players?.[row.pid];
    if(!player) continue;
    const stats=matchStatsFor(player);
    stats.remainingHandCount=Number(row.handCount || 0);
    stats.remainingHandPenalty=Number(row.handPenalty || 0)+Number(row.madPigPenalty || 0)+Number(row.jokerPenalty || 0);
    const roundRecord={round:Number(snapshot.round || room.round || 1),score:Number(row.total || 0),feastCards:Number(row.pileCardCount || 0),feastPoints:Number(row.pileScore || 0),handPenalty:Number(row.handPenalty || 0)};
    const existing=stats.roundScores.findIndex(item=>item.round===roundRecord.round);
    if(existing>=0) stats.roundScores[existing]=roundRecord; else stats.roundScores.push(roundRecord);
  }
}







function beginNextRound(room){
  if(!room || room.phase !== 'roundEnd') return;
  clearAllProgressTimers(room);

  const outPid = Number.isInteger(room.roundEndOutPid) ? room.roundEndOutPid : 0;
  const nextRound = Math.min((room.round || 1) + 1, room.totalRounds || 3);
  const dealMode = normalizeRoundDealMode(room.roundDealMode);
  const previousSummary = room.roundEndSummary;

  // 全シャッフル方式では、終了したラウンドのカード由来得点だけを確定して銀行へ移す。
  // ババブタとシュートの累計失点は既存の専用Bankで管理するため、二重加算しない。
  if(dealMode === 'reshuffle' && previousSummary?.rows){
    for(const row of previousSummary.rows){
      const player=room.players[row.pid];
      if(player){
        const cardScore = Number.isFinite(Number(row.currentRoundCardScore))
          ? Number(row.currentRoundCardScore)
          : Number(row.pileScore ?? row.pile ?? 0) - Number(row.handPenalty || 0) - Number(row.madPigPenalty || 0);
        player.completedRoundCardScoreBank = Number(player.completedRoundCardScoreBank || 0) + cardScore;
      }
    }
  }

  room.round = nextRound;
  room.phase = 'playing';
  room.trick = [];
  room.leadSuit = null;
  room.pendingPick = null;
  room.trickReview = null;
  room.spotlightEvent = null;
  room.pendingSpotlightPlans = null;
  room.spotlightRoundCounts = {};
  room.roundEndSummary = null;
  room.roundEndOutPid = null;
  room.roundEndDeferred = null;
  room.shootPigEvent = null;
  room.madPigEvent = null;
  room.pairCleanEvent = null;
  room.lead = outPid;
  room.current = outPid;
  room.lastHumanTurnRebroadcastAt = 0;
  room.lastNoPlayableRebroadcastAt = 0;
  // 持ち越し／全シャッフルに関係なく、「動いたババ」はラウンド単位で判定する。
  room.babaMovedThisRound=false;
  room.babaMoveCountThisRound=0;
  room.babaMoveEvent=null;

  let transitionText='';
  let detailText='';
  if(dealMode === 'reshuffle'){
    // 手札・ごちそう山・浄化済みカードをすべて回収し、53枚から通常カード1枚を除いて再配札。
    for(const p of room.players){
      p.hand=[];
      p.scorePile=[];
      p.pairs=[];
      p.out=false;
    }
    room.stock=[];
    room.removedCard=null;
    dealInitial(room);
    transitionText='全カードを回収してシャッフルし、全員へ13枚ずつ配り直しました。';
    detailText='全員13枚の新しい手札';
    assertUniqueActiveCards(room, `第${nextRound}ラウンド全シャッフル後`);
  } else {
    let refill = buildUniqueNormalRefillDeck(room);
    const drawRefill = () => {
      while(room.stock.length){
        const c = room.stock.pop();
        if(c && !collectActiveFaceKeys(room).has(cardFaceKey(c))) return c;
      }
      if(!refill.length) refill = buildUniqueNormalRefillDeck(room);
      return refill.pop();
    };

    const refillRows = [];
    for(const p of room.players){
      const before = p.hand.length;
      let added = 0;
      while(p.hand.length < 13){
        const card = drawRefill();
        if(card && !collectActiveFaceKeys(room).has(cardFaceKey(card))){
          p.hand.push(card);
          added++;
        } else break;
      }
      sortHand(p.hand);
      refillRows.push(`${p.name}:${before}→${p.hand.length}${added ? `(+${added})` : ''}`);
    }
    assertUniqueActiveCards(room, `第${nextRound}ラウンド補充後`);
    const allFull = room.players.every(p=>p.hand.length === 13);
    transitionText = allFull
      ? '残り手札・ごちそう山・ペアを持ち越し、全員の手札を13枚まで補充しました。'
      : '持ち越し後に補充しましたが、一部の手札が13枚未満です。';
    detailText=`補充結果：${refillRows.join(' / ')}`;
  }

  room.roundStart = {
    round:nextRound,
    text:`第${nextRound}ラウンド開始！${transitionText}`,
    expiresAt:Date.now()+6500
  };
  room.message=`第${nextRound}ラウンド開始。${transitionText} ${room.players[room.current].name} からリード。`;
  log(room, `${room.message} ${detailText}`);
  announceCpuRoundStart(room);
  broadcast(room);
}


function beginRound2(room){
  beginNextRound(room);
}



function activeTrickInProgress(room){
  // 4枚出揃った直後や、異常に5枚以上となった復旧待ちも「トリック処理中」。
  // ここで手札0を即終了させると、場札を得点へ移す前にラウンドが終わりカードが失われる。
  return !!(room && room.phase === 'playing' && !room.pendingPick && !room.trickReview && room.trick && room.trick.length > 0);
}


function endCandidatePid(room){
  if(!room || !room.players) return -1;

  // 同じトリックで複数人の手札が0枚になった場合は、実際に最初に0枚になった
  // プレイヤーを終了理由・次ラウンドのリードとして維持する。
  const deferred = room.roundEndDeferred;
  if(deferred && deferred.round === room.round && Number.isInteger(deferred.pid) && isEmptyHand(room.players[deferred.pid])){
    return deferred.pid;
  }

  // 手札0枚は進行不能なので、どのタイミングでも終了候補。
  const emptyPid = room.players.findIndex(isEmptyHand);
  if(emptyPid >= 0) return emptyPid;

  // ババブタ1枚だけは「そのプレイヤーの手番開始時」にだけ終了候補にする。
  // カードを出した直後にババブタ1枚だけになっても、トリック終了後のピックまでは行う。
  if(room.phase === 'playing' && !room.pendingPick && !room.trickReview && Number.isInteger(room.current)){
    const p = room.players[room.current];
    if(isJokerOnlyHand(p)) return room.current;
  }

  return -1;
}



function rememberEndAfterTrick(room, pid){
  if(!room || pid < 0) return false;
  const current = room.roundEndDeferred;
  // 同じラウンドで既に終了候補が記録されている場合は、後から空になった席で
  // 上書きしない。終了理由と次ラウンドのリードが座席順へ化けるのを防ぐ。
  if(current && current.round === room.round) return true;
  room.roundEndDeferred = {pid, round:room.round, trickCount:room.trick ? room.trick.length : 0, createdAt:Date.now()};
  const p = room.players[pid];
  const onlyJoker = isJokerOnlyHand(p);
  room.message = onlyJoker
    ? `${p.name} はババブタ1枚だけです。次に手番が来たらラウンド終了します。`
    : `${p.name} の手札がなくなりました。このトリック終了後にラウンド終了します。`;
  log(room, `🏁 ${room.message}`);
  return true;
}


function canCheckRoundEndNow(room){
  return !!(room && room.phase === 'playing' && !activeTrickInProgress(room));
}


function checkRoundEnd(room, preferredPid=null){
  let outPid = -1;
  if(Number.isInteger(preferredPid) && preferredPid >= 0 && preferredPid < room.players.length && isRoundEndHand(room.players[preferredPid])){
    outPid = preferredPid;
  } else {
    outPid = endCandidatePid(room);
  }
  if(outPid<0) return false;

  const out = room.players[outPid];
  const onlyJoker = isJokerOnlyHand(out);
  clearAllProgressTimers(room);
  // ラウンド結果・最終結果へ、直前トリックの中央セリフを持ち越さない。
  room.spotlightEvent = null;
  room.pendingSpotlightPlans = null;
  room.pendingPick = null;
  room.trickReview = null;
  room.trick = [];
  room.leadSuit = null;
  room.lastTrick = null;
  room.pairCleanEvent = null;
  room.madPigEvent = null;

  const reasonText = onlyJoker
    ? `${out.name} の手番開始時、袋にババブタ1枚だけが残っていました。`
    : `${out.name} の手札がなくなりました。`;

  const snapshot = makeRoundSnapshot(room, outPid, reasonText);
  recordRoundStats(room,snapshot);
  room.roundEndOutPid = outPid;
  room.roundEndDeferred = null;

  if((room.round || 1) < (room.totalRounds || 3)){
    room.roundEndSummary = snapshot;
    room.phase='roundEnd';
    room.current=null;
    room.message=`第${room.round}ラウンド終了！結果を確認してOKを押すと第${room.round+1}ラウンドへ進みます。`;
    const cpuSpeaker = room.players.find((p,i)=>p.cpu);
    if(cpuSpeaker){ const ci=room.players.indexOf(cpuSpeaker); say(room, ci, cpuLineFor(room, ci, 'roundEnd', {}) || 'ラウンド終了です。', {eventKey:'round-end'}); }
    log(room, room.message);
  } else {
    room.finalRoundSummary = snapshot;
    room.roundEndSummary = null;
    room.phase='finished';
    room.current=null;
    room.message = onlyJoker
      ? `${out.name} の手番開始時、袋にババブタ1枚だけが残っていました！ゲーム終了。`
      : `${out.name} が上がり！ゲーム終了。`;
    if(out.cpu) say(room, outPid, onlyJoker ? sample(['ババブタだけ残った…終わった…','袋の中がババブタだけ！？']) : sample(['上がり！ごちそう山を数える！','決着！点数計算だ！']), {eventKey:onlyJoker?'baba':'finish'});
    log(room, room.message);
    score(room);
    // 旧ホストが切断中でも、接続中の参加者が結果画面から再戦できるようにする。
    ensureLobbyHost(room);
    if(connectedHumanPlayers(room).length===0) scheduleRoomCleanup(room);
  }
  return true;
}









function score(room){
  const useMadPig = room.madPigEnabled !== false;
  const jokerPenaltyValue = room.jokerPenalty ?? 20;
  const jokerPenaltyTiming = normalizeJokerPenaltyTiming(room.jokerPenaltyTiming);
  const penaltyMode = normalizePenaltyMode(room.penaltyMode);
  const finalRoundShootResult = room.shootPigRoundResults?.[String(room.round || room.totalRounds || 1)] || null;
  const finalShootBlocked=room.shootBlockedByUnmovedBabaResults?.[String(room.round || room.totalRounds || 1)] || null;
  for(const [playerIndex,p] of room.players.entries()){
    const pileCardCount = p.scorePile.length;
    const pileScore = feastPileScore(room,p);
    const normalHand = p.hand.filter(c=>c && !c.joker).length;
    const madPigHand = useMadPig ? p.hand.filter(c=>c && !c.joker && c.suit===MUD_SUIT && c.rank==='11').length : 0;
    const madPigPile = useMadPig ? p.scorePile.filter(c=>c && !c.joker && c.suit===MUD_SUIT && c.rank==='11').length : 0;
    const madPig = madPigHand + madPigPile;
    const joker = playerHasJoker(p) ? 1 : 0;
    const finalShootWaiver = !!(finalRoundShootResult && finalRoundShootResult.shooterPid === playerIndex);
    const rawHandPenalty = handPenaltyForRoom(room, p);
    const handPenalty = adjustHandPenaltyForShootThePig(room, p, rawHandPenalty, finalShootWaiver);
    const rawMadPigPenalty = madPigPenaltyForRoom(room, p);
    const madPigPenalty = finalShootWaiver ? 0 : rawMadPigPenalty;
    const jokerPenaltyFromRounds = jokerPenaltyTiming === 'perRound' ? (p.jokerPenaltyBank || 0) : 0;
    const jokerPenaltyAtGameEnd = (jokerPenaltyTiming === 'gameEnd' && joker && !finalShootWaiver) ? joker*jokerPenaltyValue : 0;
    const jokerPenalty = jokerPenaltyFromRounds + jokerPenaltyAtGameEnd;
    const shootPigPenalty = p.shootPigPenaltyBank || 0;
    const completedRoundCardScore = Number(p.completedRoundCardScoreBank || 0);
    const currentRoundCardScore = pileScore - handPenalty - madPigPenalty;
    const total = completedRoundCardScore + currentRoundCardScore - jokerPenalty - shootPigPenalty;
    p.final = {pile:pileCardCount, pileCardCount, pileScore, feastPointPerCard:normalizeFeastPointPerCard(room.feastPointPerCard), normalHand, handPenalty, rawHandPenalty, madPig, madPigHand, madPigPile, madPigPenalty, rawMadPigPenalty, completedRoundCardScore, currentRoundCardScore, joker, jokerPenaltyValue, jokerPenaltyTiming, jokerPenaltyFromRounds, jokerPenaltyAtGameEnd, jokerPenalty, shootPigPenalty, shootPigMadPigWaived:finalShootWaiver, shootPigGameEndJokerWaived:finalShootWaiver && jokerPenaltyTiming === 'gameEnd', shootPigActivatedRounds:p.shootPigActivatedRounds || [], shootActivationCount:playerShootActivationCount(p), shootLimitMode:shootThePigLimit(room), shootRequiresBabaMoved:normalizeShootRequiresBabaMoved(room.shootRequiresBabaMoved), babaMovedThisRound:!!room.babaMovedThisRound, babaMoveCountThisRound:Number(room.babaMoveCountThisRound||0), shootBlockedByUnmovedBaba:finalShootBlocked?.pid===playerIndex, penaltyMode, roundDealMode:normalizeRoundDealMode(room.roundDealMode), total};
    const stats=matchStatsFor(p);
    stats.remainingHandCount=p.hand.length;
    stats.remainingHandPenalty=handPenalty+madPigPenalty+jokerPenaltyAtGameEnd;
    stats.finalScore=total;
  }
  for(const p of room.players) p.playEvaluation=generatePlayEvaluation(room,p);
}







function clientMessageByteLength(raw){
  if(Buffer.isBuffer(raw)) return raw.length;
  if(ArrayBuffer.isView(raw)) return raw.byteLength;
  if(raw instanceof ArrayBuffer) return raw.byteLength;
  return Buffer.byteLength(String(raw || ''),'utf8');
}
function clientActionSignature(msg){
  if(!msg || msg.type === 'ping') return '';
  const type=String(msg.type || '');
  if(!DEDUPED_CLIENT_ACTION_TYPES.has(type)) return '';
  const stable={type};
  for(const key of ['cardId','index','skip','cardAId','cardBId']) if(msg[key] !== undefined) stable[key]=msg[key];
  if(Array.isArray(msg.cardIds)) stable.cardIds=msg.cardIds.map(String);
  return JSON.stringify(stable);
}
function isDuplicateClientAction(ws,msg,now=Date.now()){
  const signature=clientActionSignature(msg);
  if(!signature) return false;
  const duplicate=ws.lastActionSignature===signature && now-Number(ws.lastActionAt||0)<DUPLICATE_ACTION_WINDOW_MS;
  ws.lastActionSignature=signature;
  ws.lastActionAt=now;
  return duplicate;
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.missedHeartbeats = 0;
  ws.on('pong', ()=>{ ws.isAlive = true; ws.missedHeartbeats = 0; });
  ws.on('message', (raw) => {
    ws.isAlive = true;
    ws.missedHeartbeats = 0;
    if(clientMessageByteLength(raw) > MAX_WS_MESSAGE_BYTES){
      try{ ws.close(1009,'message too large'); }catch(e){}
      return;
    }
    let msg; try { msg=JSON.parse(raw); } catch(e){ return send(ws,'errorMsg',{message:'受信データを読み取れませんでした。'}); }
    if(!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    if(isDuplicateClientAction(ws,msg)) return;
    try{
      if(msg.type==='ping') return send(ws,'pong',{at:Date.now(), echo:msg.at || null});
      if((msg.type==='create' || msg.type==='join' || msg.type==='reconnect') && roomByWs(ws)){
        return send(ws,'errorMsg',{message:'この画面はすでに部屋へ接続済みです。別の部屋へ移る場合は新しい画面で開いてください。'});
      }
      if(msg.type==='create') return createRoom(ws, msg.name, msg.rounds, msg.madPigEnabled, msg.jokerPenalty, msg.initialPairDiscardEnabled, msg.passThreeEnabled, msg.penaltyMode, msg.pickTargetCount, msg.jokerPenaltyTiming, msg.shootThePigEnabled, msg.roundDealMode, msg.shootThePigLimit, msg.feastPointPerCard, msg.pickProviderRole, msg.participantRole, msg.forceJokerPickCandidate, msg.shootRequiresBabaMoved);
      if(msg.type==='join') return joinRoom(ws, msg.code, msg.name, msg.playerId, msg.resumeToken, msg.participantRole);
      if(msg.type==='reconnect') return reconnectRoom(ws, msg.code, msg.playerId, msg.name, msg.resumeToken);
      const room = roomByWs(ws);
      if(!room){
        if(msg.type==='clearRoom') send(ws,'errorMsg',{message:'この部屋はすでに閉じられています。'});
        return;
      }
      const activeParticipant=participantForWs(room,ws);
      if(!activeParticipant){
        return send(ws,'errorMsg',{message:'この接続は別の画面へ引き継がれました。操作を続けるには再接続してください。'});
      }
      const activeRole=normalizeParticipantRole(activeParticipant.participantRole);
      if(msg.type==='changeParticipantRole') return changeParticipantRole(room,activeParticipant.id,msg.participantRole,ws);
      if(activeRole==='spectator' && GAMEPLAY_ACTION_TYPES.has(msg.type)){
        return send(ws,'errorMsg',{message:'観戦者はゲーム操作を行えません。'});
      }
      if(msg.type==='start') startGame(room, ws.playerId);
      if(msg.type==='rematch') rematchGame(room, ws.playerId);
      if(msg.type==='addCpu') addCpu(room, ws.playerId);
      if(msg.type==='removeCpu') removeCpu(room, ws.playerId);
      if(msg.type==='clearRoom') clearRoom(room, ws.playerId, ws);
      if(msg.type==='play') playCard(room, ws.playerId, msg.cardId);
      if(msg.type==='pick') doPick(room, ws.playerId, Number(msg.index));
      if(msg.type==='pickTargets') submitPickTargets(room, ws.playerId, msg.cardIds);
      if(msg.type==='pairChoice') resolvePairChoice(room, ws.playerId, msg.cardId, !!msg.skip);
      if(msg.type==='passThree') submitPassThree(room, ws.playerId, msg.cardIds);
      if(msg.type==='initialPairDiscard') discardInitialPair(room, ws.playerId, String(msg.cardAId||''), String(msg.cardBId||''));
      if(msg.type==='skipInitialPairs') skipInitialPairs(room, ws.playerId);
      if(msg.type==='continueRound') {
        if(room.phase === 'roundEnd'){
          log(room, `ラウンド結果確認OK。第${room.round+1}ラウンドへ進みます。`);
          beginNextRound(room);
        }
      }
    }catch(error){
      console.error('client message handling error', error);
      send(ws,'errorMsg',{message:'操作を処理できませんでした。状態を同期し直します。'});
      const room=roomByWs(ws);
      if(room) broadcast(room);
    }
  });
  ws.on('close', () => {
    const room = roomByWs(ws); if(!room) return;
    const p = participantById(room,ws.participantId || ws.playerId); if(p && p.ws === ws) {
      p.ws = null;
      p.disconnectedAt = Date.now();
      log(room, `${p.name}（${normalizeParticipantRole(p.participantRole)==='spectator'?'観戦':'プレイ'}）が切断しました。再接続待ちです。`);
      ensureLobbyHost(room);
      broadcast(room);
    }
    if(connectedHumanPlayers(room).length===0) scheduleRoomCleanup(room);
  });
});

server.listen(PORT, () => console.log(`【ピピトリ】ピッグ・ピック・トリック server listening on http://localhost:${PORT}`));
