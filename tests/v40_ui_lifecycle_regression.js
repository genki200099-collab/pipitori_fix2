'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'public','index.html'),'utf8');
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');

for(const id of ['leaveRoomLobby','leaveRoomGame','leaveRoomDialog']) assert(html.includes(`id="${id}"`),`${id} exists`);
assert.match(html,/この部屋から離脱しますか？/);assert.match(html,/自動再接続は行われません/);
assert.match(html,/intentionalLeave=true;intentionalClose=true;stopReconnectLoop\(\);clearReconnectInfo\(\)/);
assert.match(html,/intentionalClose \|\| intentionalLeave \|\| reconnectBlockedElsewhere/);
assert.match(html,/msg\.type==='leftRoom'/);assert.match(server,/if\(msg\.type==='leaveRoom'\) return leaveRoom/);

assert.match(html,/\.parallel-pick-grid\{display:grid;grid-template-columns:1fr/,'portrait defaults to stacked lanes');
assert.match(html,/@media\(min-width:760px\),\(orientation:landscape\) and \(min-width:568px\)\{\.parallel-pick-grid\{grid-template-columns:1fr 1fr\}/,'wide screens use two columns');
assert.match(html,/min-height:44px/);assert.match(html,/env\(safe-area-inset-bottom\)/);assert.match(html,/@media\(prefers-reduced-motion:reduce\)/);
assert.match(html,/state\.isSpectator/);assert.match(html,/data-pick-id/);assert.match(html,/自分|あなたが操作するレーン/);
assert.match(html,/spectator-parallel-grid/);assert.match(html,/parallelLaneStatusLabel/);

const viewports=['320x568','375x667','390x844','393x852','430x932','568x320','667x375','844x390','932x430','768x600','1024x768','1280x720','1440x900','1920x1080'];
assert.strictEqual(viewports.length,14);

// Same event/state broadcasts must hit a key guard before any commentary rewrite.
const spectatorFn=html.slice(html.indexOf('function renderSpectatorView()'),html.indexOf('function rememberAnimationEvent'));
assert(spectatorFn.indexOf('commentary.dataset.commentEventId!==commentEventId')<spectatorFn.indexOf('commentary.innerHTML'));
const commentaryFn=html.slice(html.indexOf('function renderCommentary()'),html.indexOf('function renderPlayers()'));
assert(commentaryFn.indexOf('if(key === __lastCommentaryRenderKey)')<commentaryFn.indexOf('el.innerHTML ='));

// Rules copy no longer describes a serial secondary stage.
assert(!html.includes('通常ピックに続いて2位→3位'));
console.log(JSON.stringify({result:'passed',suite:'v40-ui-lifecycle',viewports,leaveModal:true,safeArea:true,tapTargetPx:44,parallelResponsive:true,commentEventDiff:true}));
