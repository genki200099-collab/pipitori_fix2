'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

// 内部スートIDは mud のまま、画面上の記号はすべて絵文字へ統一する。
assert.match(server, /mud:\{id:'mud', name:'泥', icon:'💧', color:'gray'\}/);
assert.match(html, /mud:\{name:'ぬかるみ',shortName:'💧',icon:'💧',className:'mud',art:'🐷💧',colorName:'灰'\}/);
assert.match(html, /mad\?'☠️🐷💧':suit\.art/);
assert.doesNotMatch(server, /mud:\{[^\n]*icon:'泥'/);
assert.doesNotMatch(html, /shortName:'泥',icon:'泥'/);
assert.doesNotMatch(html, /☠️🐷泥|art:'🐷泥'/);
assert.match(html, /if\(state\?\.penaltyMode === 'mud6'\) return '💧-6\/他-3'/);
assert.doesNotMatch(html, />泥</);

// 旧スマホCSSより後ろに、ゲーム中だけを対象にした最終上書きがあること。
const legacyIndex = html.indexOf('iPhone縦画面・Safari専用に近い卓面最適化');
const patchIndex = html.indexOf('Mobile playability & contrast v6');
const fanPatchIndex = html.indexOf('Fan hand, selected-match rules & resilient reconnect v7');
const polishPatchIndex = html.indexOf('Full debug & product polish v8');
const cinematicPatchIndex = html.indexOf('Cinematic motion & event clarity v9');
const collisionPatchIndex = html.indexOf('Collision-free table & commentary rails v10');
assert.ok(legacyIndex >= 0 && patchIndex > legacyIndex, 'v6 patch must override legacy mobile CSS');
assert.ok(fanPatchIndex > patchIndex, 'v7 fan patch must override the former horizontal hand layout');
assert.ok(polishPatchIndex > fanPatchIndex, 'v8 product polish must follow the v7 fan layout');
assert.ok(cinematicPatchIndex > polishPatchIndex, 'v9 cinematic motion must override earlier animation rules');
assert.ok(collisionPatchIndex > cinematicPatchIndex, 'v10 collision rules must override every earlier table layout');
assert.match(html, /body\.gameplay-mode\.modern-game-ui\.ui-phone\.ui-phone-portrait #table\.modern-table\.playing-now\{/);
assert.match(html, /inset:58px 8px 103px!important/);
assert.match(html, /function fanCardStyle\(index, count\)/);
assert.match(html, /--fan-left:\$\{left\.toFixed\(3\)\}%/);
assert.match(html, /classList\.toggle\('fan-hand', fanMode\)/);
assert.match(html, /hand\.fan-hand:not\(\.selection-mode\)/);
assert.match(html, /translateY\(calc\(var\(--fan-y\) - 20px\)\)/);
assert.match(html, /同じカードをもう一度タップすると出します/);
assert.match(html, /class="card-corner"/);
assert.match(html, /aria-pressed="\$\{selectedPlay\?'true':'false'\}"/);
assert.match(html, /\.game-screen\.is-pick-mode \.table-players\{display:none!important\}/);
assert.match(html, /\.game-screen\.is-pick-mode \.commentary-layer,[\s\S]*?display:none!important/);
assert.match(html, /\.game-screen\.is-pick-mode #message\.table-message\.message,[\s\S]*?display:none!important/);
assert.match(html, /\.pick-stage\{[\s\S]*?background:linear-gradient\(145deg,#0b3439,#071f2c 58%,#171b31\)!important/);
assert.match(html, /\.commentary-layer \.speech-body\{[\s\S]*?background:transparent!important;[\s\S]*?color:#fff!important/);
assert.match(html, /\.ui-phone #table \.play-trail\{\s*display:none!important/);
assert.match(html, /gameScreen\?\.classList\.toggle\('is-review-mode', !!state\.trickReview\)/);
assert.match(html, /document\.body\.classList\.contains\('ui-phone'\) && \(state\.pendingPick \|\| state\.trickReview \|\| state\.roundStart\)/);
assert.match(html, /\.game-hud \.game-status\.status\{[\s\S]*?display:flex!important/);
assert.match(html, /modern-game-ui:not\(\.ui-phone\) \.game-round-status \.round-start\{[\s\S]*?position:absolute!important;[\s\S]*?transform:translate\(-50%,-50%\)!important/);
assert.match(html, /data-card-count="\$\{cnt\}"/);
assert.match(html, /shortSide <= 520 && longSide <= 1000/);
assert.match(html, /id="activeRuleSummary"/);
assert.match(html, /function renderSelectedRuleSummary\(\)/);
assert.match(html, /\.utility-rules>\.rule-summary\{display:none!important\}/);
assert.match(html, /id="connectionRecovery"/);
assert.match(html, /const RECONNECT_KEY='pipi_tori_reconnect_v2'/);
assert.match(html, /function startSocketHealth\(socket, generation\)/);
assert.match(html, /let socketOpenTimer=null/);
assert.match(html, /reconnectBlockedElsewhere/);
assert.match(html, /function currentActionGuide\(\)/);
assert.match(html, /class="action-guide tone-\$\{escAttr\(guide\.tone\)\}"/);
assert.match(html, /id="handViewToggle"/);
assert.match(html, /classList\.toggle\('expanded-hand', expandedMode\)/);
assert.match(html, /\.hand\.expanded-hand\{/);
assert.match(html, /grid-template-rows:46px 38px minmax\(0,1fr\) 156px!important/);
assert.match(html, /grid-template-rows:44px 36px minmax\(0,1fr\) 150px!important/);
assert.match(html, /grid-template-rows:38px 30px minmax\(0,1fr\) 108px!important/);
assert.match(html, /resumeToken:data\.resumeToken \|\| resumeToken \|\| ''/);
assert.match(server, /function newResumeToken\(\)/);
assert.match(server, /resumeTokenMatches\(player\.resumeToken, resumeToken\)/);
assert.match(server, /if\(msg\.type==='ping'\) return send\(ws,'pong'/);
assert.match(server, /pairsCount:Math\.floor\(p\.pairs\.length\/2\)/);
assert.match(server, /client\.ping\(\)/);
assert.match(server, /DISCONNECTED_ACTION_GRACE_MS/);
assert.match(server, /ROUND_END_AUTO_CONTINUE_MS/);
assert.match(server, /function scheduleRoomCleanup\(room\)/);
assert.match(html, /id="momentOverlay"/);
assert.match(html, /function renderMomentOverlay\(\)/);
assert.match(html, /renderShootPigOverlay\(\); renderBabaDrawOverlay\(\); renderMomentOverlay\(\)/);
assert.match(html, /if\(__lastMomentEventId===key\) return/);
assert.match(html, /if\(__lastBabaDrawEventId === key\) return/);
assert.match(html, /if\(__lastShootPigEventId === ev\.id\) return/);
assert.match(html, /@keyframes trickCardInBottom/);
assert.match(html, /@keyframes pairCleanseMerge/);
assert.match(html, /@keyframes madPigRise/);
assert.match(html, /@keyframes babaCardReveal/);
assert.match(html, /@keyframes shootProjectile/);
assert.match(html, /\.moment-overlay\{[^}]*pointer-events:none/);
assert.match(html, /max-height:calc\(100dvh - 10px\)/);
assert.match(html, /@media\(prefers-reduced-motion:reduce\)\{[\s\S]*?\.moment-overlay \*/);
assert.match(html, /collision-safe-layout-v10/);
assert.match(html, /grid-template-columns:var\(--comment-avatar\) minmax\(0,1fr\)!important/);
assert.match(server, /madPigEvent: room\.madPigEvent/);
assert.match(server, /pairCleanEvent: room\.pairCleanEvent/);
assert.match(server, /function pickResultDisplayMs\(room, result\)/);
assert.match(server, /eventId:`pick-/);
assert.match(html, /id="lobbyParticipants"/);
assert.match(html, /id="clearRoomDialog" class="room-clear-dialog"/);
assert.match(html, /\.lobby-participants\{display:grid/);
assert.match(html, /\.btn\{min-height:44px\}/);
assert.match(html, /pick-system-role">カードを取られる人/);
assert.match(html, /pick-system-role">カードを引く人/);

function rgb(hex){
  const value = hex.replace('#','');
  return [0,2,4].map(i=>parseInt(value.slice(i,i+2),16));
}
function luminance(hex){
  return rgb(hex).map(v=>{
    const s=v/255;
    return s<=0.04045 ? s/12.92 : ((s+0.055)/1.055)**2.4;
  }).reduce((sum,v,i)=>sum+v*[0.2126,0.7152,0.0722][i],0);
}
function contrast(a,b){
  const [high,low]=[luminance(a),luminance(b)].sort((x,y)=>y-x);
  return (high+0.05)/(low+0.05);
}

const contrastPairs = [
  ['#ffffff','#082a30','進行メッセージ'],
  ['#ffffff','#0b3137','プレイヤー枠'],
  ['#ffffff','#103f3d','ラウンドバー'],
  ['#c5e1dc','#0a2930','HUD補助文字'],
  ['#3d2430','#f5f1e7','設定チップ']
];
for(const [fg,bg,label] of contrastPairs){
  assert.ok(contrast(fg,bg)>=4.5, `${label} contrast ${contrast(fg,bg).toFixed(2)}:1`);
}

function validatePortrait(width,height){
  const small = width <= 360;
  const hud = small ? 44 : 46;
  const round = small ? 36 : 38;
  const hand = small ? 150 : 156;
  const arena = height-hud-round-hand;
  const tableTop = small ? 54 : 58;
  const tableBottom = small ? 97 : 103;
  const playerHeight = small ? 45 : 48;
  const cardWidth = small ? 56 : 60;
  const cardHeight = small ? 86 : 92;
  const slotY = small ? 26 : 30;
  const tableHeight = arena-tableTop-tableBottom;
  const center = tableHeight/2;
  const topCard = center-slotY-cardHeight/2;
  const bottomCard = center+slotY+cardHeight/2+8; // ラベル分
  assert.ok(arena>0, `${width}x${height}: arena exists`);
  assert.ok(tableTop>=playerHeight+5, `${width}x${height}: cards clear player rail`);
  assert.ok(topCard>=0 && bottomCard<=tableHeight, `${width}x${height}: trick cards fit table`);
  const stage=Math.min(width,980);
  const firstEdge=stage*.115-cardWidth/2;
  const lastEdge=stage*.885+cardWidth/2;
  const exposedCorner=stage*.77/12;
  const selectedTop=hand-cardHeight-8-16;
  assert.ok(firstEdge>=0 && lastEdge<=stage, `${width}x${height}: all thirteen fan cards fit horizontally`);
  assert.ok(exposedCorner>=20, `${width}x${height}: every rank/suit corner remains identifiable`);
  assert.ok(selectedTop>=0, `${width}x${height}: selected card lift stays inside the hand dock`);
  return {width,height,arena,tableHeight,exposedCorner:Number(exposedCorner.toFixed(2)),selectedTop};
}

function validateLandscape(width,height){
  const short=height<=360;
  const arena=height-(short?34:38)-(short?26:30)-(short?90:108);
  const tableHeight=arena-(short?36:44)-(short?34:46);
  const cardWidth=short?42:48;
  const cardHeight=short?62:72;
  const slotY=short?13:17;
  const center=tableHeight/2;
  const topCard=center-slotY-cardHeight/2;
  const bottomCard=center+slotY+cardHeight/2;
  assert.ok(topCard>=0 && bottomCard<=tableHeight, `${width}x${height}: landscape trick cards fit`);
  const stage=Math.min(width,980);
  const exposedCorner=stage*.80/12;
  const firstEdge=stage*.10-cardWidth/2;
  const lastEdge=stage*.90+cardWidth/2;
  const selectedTop=(short?90:108)-cardHeight-(short?4:8)-(short?8:12);
  assert.ok(firstEdge>=0 && lastEdge<=stage, `${width}x${height}: landscape fan fits all cards`);
  assert.ok(exposedCorner>=20, `${width}x${height}: landscape rank/suit corners stay visible`);
  assert.ok(selectedTop>=0, `${width}x${height}: landscape selection lift stays visible`);
  return {width,height,arena,tableHeight,exposedCorner:Number(exposedCorner.toFixed(2)),selectedTop};
}

const portraitResults = [
  [320,568],
  [360,640],
  [390,844],
  [393,852],
  [430,932]
].map(v=>validatePortrait(...v));
const landscapeResults = [
  [568,320],
  [667,375],
  [844,390],
  [932,430]
].map(v=>validateLandscape(...v));

console.log(JSON.stringify({
  result:'passed',
  contrast:contrastPairs.map(([fg,bg,label])=>({label,ratio:Number(contrast(fg,bg).toFixed(2))})),
  portrait:portraitResults,
  landscape:landscapeResults
}));
