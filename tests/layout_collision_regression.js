'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

const v9 = html.indexOf('Cinematic motion & event clarity v9');
const v10 = html.indexOf('Collision-free table & commentary rails v10');
const v11 = html.indexOf('Trick result clarity & resilient typography v11');
assert.ok(v10 > v9, 'v10 collision rules must be the final gameplay override');
assert.ok(v11 > v10, 'v11 result and typography rules must follow the collision-safe layout');
assert.match(html, /class="trick-board collision-safe-layout-v10 trick-result-layout-v11\$\{review\?' reviewing':''\}"/);
assert.match(html, /\.trick-board\.collision-safe-layout-v10\{[\s\S]*?grid-template-columns:repeat\(2,var\(--card-w\)\)/);
assert.match(html, /@media \(min-width:641px\)\{[\s\S]*?grid-template-columns:repeat\(4,var\(--card-w\)\)/);
assert.match(html, /ui-phone-landscape \.trick-board\.collision-safe-layout-v10\{[\s\S]*?grid-template-columns:repeat\(4,var\(--card-w\)\)/);
assert.match(html, /\.commentary-layer \.speech-face\{[\s\S]*?width:var\(--comment-avatar\)!important;[\s\S]*?overflow:hidden!important/);
assert.match(html, /\.commentary-layer \.speech-body\{[\s\S]*?grid-column:2!important;[\s\S]*?min-width:0!important;[\s\S]*?overflow:hidden!important/);
assert.match(html, /ui-phone\.ui-phone-portrait #table\.modern-table\.playing-now\{[\s\S]*?inset:58px 8px 112px!important/);
assert.match(html, /@media \(max-height:360px\) and \(orientation:landscape\)\{[\s\S]*?--card-w:42px!important;[\s\S]*?--card-h:62px!important/);
assert.match(html, /body\.gameplay-mode:not\(\.finished-mode\) \.hype-toast\{display:none!important\}/);
assert.match(html, /\.trick-board\.collision-safe-layout-v10 \.trick-card-motion\.is-new\{[\s\S]*?animation:trickCardInCompact/);
assert.match(html, /@keyframes trickCardInCompact/);
assert.match(html, /review-banner review-result-v11/);
assert.match(html, /review-outcome result-winner/);
assert.match(html, /review-outcome result-weakest/);
assert.match(html, /roleLabel=isWinner && isWeakest \? '👑勝者・💀最弱' : isWinner \? '👑 勝者' : isWeakest \? '💀 最弱'/);
assert.match(html, /\.trick-board\.trick-result-layout-v11 \.trick-slot-label\{[\s\S]*?width:var\(--card-w\)!important;[\s\S]*?text-overflow:ellipsis!important/);
assert.match(html, /\.review-outcome b\{overflow:hidden;text-overflow:ellipsis/);
assert.match(html, /@keyframes trickWinnerRevealV11/);
assert.match(html, /@keyframes trickWeakestRevealV11/);
assert.match(html, /@keyframes trickSupportFadeV11/);
assert.match(html, /\.game-screen\.is-review-mode \.commentary-layer,[\s\S]*?\.game-screen\.is-review-mode #message\.table-message\.message/);
assert.match(html, /not\(\.ui-phone\) \.game-screen\.is-review-mode \.table-players \.player\.position-bottom/);
assert.match(html, /ui-phone\.ui-phone-portrait \.table-players \.name\{font-size:10\.5px!important\}/);
assert.match(html, /ui-phone\.ui-phone-portrait \.review-banner\.review-result-v11\{[\s\S]*?grid-template-columns:1fr!important/);
assert.match(html, /ui-phone-landscape \.review-banner\.review-result-v11\{[\s\S]*?grid-template-columns:minmax\(0,1fr\) auto!important/);

function rect(x, y, width, height, label){
  return {x, y, width, height, right:x + width, bottom:y + height, label};
}

function overlaps(a, b){
  return a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y;
}

function assertSeparated(a, b, context){
  assert.ok(!overlaps(a, b), `${context}: ${a.label} overlaps ${b.label}`);
}

function assertInside(inner, outer, context){
  const epsilon = 0.01;
  assert.ok(
    inner.x + epsilon >= outer.x && inner.y + epsilon >= outer.y &&
      inner.right <= outer.right + epsilon && inner.bottom <= outer.bottom + epsilon,
    `${context}: ${inner.label} escapes ${outer.label}`
  );
}

function assertAllSeparated(items, context){
  for(let i = 0; i < items.length; i++){
    for(let j = i + 1; j < items.length; j++) assertSeparated(items[i], items[j], context);
  }
}

function portraitProfile(width, height){
  const narrow = width <= 360;
  let hud = narrow ? 44 : 46;
  let round = narrow ? 36 : 38;
  let hand = narrow ? 150 : 156;
  let cardW = narrow ? 56 : 60;
  let cardH = narrow ? 86 : 92;
  let tableX = narrow ? 6 : 8;
  let tableTop = narrow ? 52 : 58;
  let tableBottom = narrow ? 102 : 112;
  let columnGap = narrow ? 12 : 16;
  let rowGap = narrow ? 9 : 12;
  let labelH = 14;

  if(width <= 430 && height <= 650){
    cardW = 52; cardH = 80;
    tableX = 7; tableTop = 54; tableBottom = 108;
    columnGap = 12; rowGap = 8; labelH = 11;
  }
  if(width <= 430 && height <= 620){
    cardW = 48; cardH = 72;
    tableX = 6; tableTop = 52; tableBottom = 104;
    columnGap = 10; rowGap = 6; labelH = 11;
  }
  if(width <= 360){
    tableX = 6; tableTop = 52; tableBottom = 102;
    columnGap = 12; rowGap = 9;
  }
  if(width <= 360 && height <= 600){
    cardW = 48; cardH = 72;
    tableX = 6; tableTop = 50; tableBottom = 98;
    columnGap = 10; rowGap = 6; labelH = 11;
  }

  const arenaW = width - 8;
  const arenaH = height - hud - round - hand - 8;
  const table = rect(tableX, tableTop, arenaW - tableX * 2, arenaH - tableTop - tableBottom, 'table-safe-area');
  const slotH = cardH + 4 + labelH;
  const gridW = cardW * 2 + columnGap;
  const gridH = slotH * 2 + rowGap;
  assert.ok(gridW <= table.width && gridH <= table.height, `${width}x${height}: portrait trick matrix fits`);
  const startX = table.x + (table.width - gridW) / 2;
  const startY = table.y + (table.height - gridH) / 2;
  const cells = [
    {name:'left', col:0, row:0},
    {name:'top', col:1, row:0},
    {name:'right', col:1, row:1},
    {name:'bottom', col:0, row:1}
  ];
  const cards = cells.map(({name, col, row}) => rect(
    startX + col * (cardW + columnGap),
    startY + row * (slotH + rowGap),
    cardW,
    cardH,
    `${name}-card`
  ));
  const labels = cells.map(({name, col, row}) => rect(
    startX + col * (cardW + columnGap),
    startY + row * (slotH + rowGap) + cardH + 4,
    cardW,
    labelH,
    `${name}-label`
  ));
  assertAllSeparated(cards, `${width}x${height} portrait cards`);
  assertAllSeparated([...cards, ...labels], `${width}x${height} portrait card/label cells`);
  [...cards, ...labels].forEach(item => assertInside(item, table, `${width}x${height}`));

  const playerH = narrow ? 45 : 48;
  const playerW = Math.min(112, (arenaW - 24) / 3);
  const players = [
    rect(5, 5, playerW, playerH, 'left-cpu'),
    rect((arenaW - playerW) / 2, 5, playerW, playerH, 'top-cpu'),
    rect(arenaW - 5 - playerW, 5, playerW, playerH, 'right-cpu')
  ];
  assertAllSeparated(players, `${width}x${height} portrait CPU rail`);
  for(const card of cards) for(const player of players) assertSeparated(card, player, `${width}x${height}`);

  const resultOffset = width <= 360 && height <= 600 ? 81
    : width <= 360 ? 85
      : width <= 430 && height <= 620 ? 86
        : width <= 430 && height <= 650 ? 89
          : 94;
  const resultW = width - (width <= 360 ? 16 : 20);
  const resultH = 50;
  const result = rect((arenaW - resultW) / 2, table.bottom + resultOffset - resultH, resultW, resultH, 'result-summary');
  const arena = rect(0, 0, arenaW, arenaH, 'arena');
  assertInside(result, arena, `${width}x${height} portrait result lane`);
  assertSeparated(table, result, `${width}x${height} portrait table/result lane`);
  for(const item of [...cards, ...labels, ...players]) assertSeparated(item, result, `${width}x${height} portrait result lane`);

  const smallRail = width <= 360;
  const commentBottom = smallRail ? 50 : 54;
  const commentH = smallRail ? 42 : 48;
  const messageBottom = smallRail ? 5 : 6;
  const messageH = smallRail ? 38 : 42;
  const commentary = rect(6, arenaH - commentBottom - commentH, arenaW - 12, commentH, 'commentary-rail');
  const message = rect(6, arenaH - messageBottom - messageH, arenaW - 12, messageH, 'message-rail');
  assertSeparated(commentary, message, `${width}x${height} portrait bottom rails`);
  assertSeparated(table, commentary, `${width}x${height} table/commentary rails`);

  const avatar = smallRail ? 26 : 29;
  const bubblePad = smallRail ? 6 : 7;
  const bubbleGap = smallRail ? 6 : 7;
  const face = rect(commentary.x + bubblePad, commentary.y + (commentary.height - avatar) / 2, avatar, avatar, 'comment-avatar');
  const copy = rect(face.right + bubbleGap, commentary.y + 4, commentary.right - bubblePad - face.right - bubbleGap, commentary.height - 8, 'comment-copy');
  assert.ok(copy.width > 80, `${width}x${height}: commentary copy has readable width`);
  assertSeparated(face, copy, `${width}x${height} commentary internals`);
  assertInside(face, commentary, `${width}x${height}`);
  assertInside(copy, commentary, `${width}x${height}`);

  const selectedTop = hand - 8 - cardH - 16;
  const titleBottom = 34;
  assert.ok(selectedTop >= titleBottom, `${width}x${height}: selected hand card clears title controls`);

  return {width, height, table:[Math.round(table.width), Math.round(table.height)], grid:[gridW, gridH], resultGap:Number((result.y - table.bottom).toFixed(2)), commentGap:message.y - commentary.bottom};
}

function landscapeProfile(width, height){
  const short = height <= 360;
  const hud = short ? 34 : 38;
  const round = short ? 26 : 30;
  const hand = short ? 90 : 108;
  const cardW = short ? 42 : 48;
  const cardH = short ? 62 : 72;
  const tableX = short ? 6 : 8;
  const tableTop = short ? 36 : 44;
  const tableBottom = short ? 34 : 42;
  const gap = short ? 8 : 12;
  const arenaW = width - 10;
  const arenaH = height - hud - round - hand - 6;
  const table = rect(tableX, tableTop, arenaW - tableX * 2, arenaH - tableTop - tableBottom, 'table-safe-area');
  const slotH = cardH + 4 + 10;
  const gridW = cardW * 4 + gap * 3;
  assert.ok(gridW <= table.width && slotH <= table.height, `${width}x${height}: landscape trick row fits`);
  const startX = table.x + (table.width - gridW) / 2;
  const startY = table.y + (table.height - slotH) / 2;
  const cards = ['left','top','right','bottom'].map((name, index) => rect(startX + index * (cardW + gap), startY, cardW, cardH, `${name}-card`));
  const labels = ['left','top','right','bottom'].map((name, index) => rect(startX + index * (cardW + gap), startY + cardH + 4, cardW, 10, `${name}-label`));
  assertAllSeparated([...cards, ...labels], `${width}x${height} landscape card/label cells`);
  [...cards, ...labels].forEach(item => assertInside(item, table, `${width}x${height}`));

  const playerH = short ? 32 : 38;
  const playerW = 104;
  const players = [
    rect(4, 3, playerW, playerH, 'left-cpu'),
    rect((arenaW - playerW) / 2, 3, playerW, playerH, 'top-cpu'),
    rect(arenaW - 4 - playerW, 3, playerW, playerH, 'right-cpu')
  ];
  assertAllSeparated(players, `${width}x${height} landscape CPU rail`);
  for(const card of cards) for(const player of players) assertSeparated(card, player, `${width}x${height}`);

  const resultOffset = short ? 29 : 32;
  const resultH = short ? 26 : 28;
  const resultW = width - 20;
  const result = rect((arenaW - resultW) / 2, table.bottom + resultOffset - resultH, resultW, resultH, 'result-summary');
  const arena = rect(0, 0, arenaW, arenaH, 'arena');
  assertInside(result, arena, `${width}x${height} landscape result lane`);
  assertSeparated(table, result, `${width}x${height} landscape table/result lane`);
  for(const item of [...cards, ...labels, ...players]) assertSeparated(item, result, `${width}x${height} landscape result lane`);

  const railBottom = short ? 3 : 4;
  const railH = short ? 28 : 34;
  const commentary = rect(4, arenaH - railBottom - railH, arenaW * 0.42 - 6, railH, 'commentary-rail');
  const messageW = arenaW * 0.58 - 6;
  const message = rect(arenaW - 4 - messageW, arenaH - railBottom - railH, messageW, railH, 'message-rail');
  assertSeparated(commentary, message, `${width}x${height} landscape bottom rails`);
  assertSeparated(table, commentary, `${width}x${height} table/commentary rails`);
  assertSeparated(table, message, `${width}x${height} table/message rails`);

  const avatar = short ? 19 : 23;
  const bubblePad = short ? 4 : 5;
  const bubbleGap = short ? 4 : 5;
  const face = rect(commentary.x + bubblePad, commentary.y + (commentary.height - avatar) / 2, avatar, avatar, 'comment-avatar');
  const copy = rect(face.right + bubbleGap, commentary.y + 3, commentary.right - bubblePad - face.right - bubbleGap, commentary.height - 6, 'comment-copy');
  assert.ok(copy.width > 70, `${width}x${height}: landscape commentary copy has readable width`);
  assertSeparated(face, copy, `${width}x${height} commentary internals`);

  const selectedTop = hand - cardH - 4;
  const titleBottom = short ? 22 : 31;
  assert.ok(selectedTop >= titleBottom, `${width}x${height}: landscape selected card clears title controls`);

  return {width, height, table:[Math.round(table.width), Math.round(table.height)], grid:[gridW, slotH], resultGap:Number((result.y - table.bottom).toFixed(2)), railGap:Number((message.x - commentary.right).toFixed(2))};
}

function desktopProfile(width, height){
  const low = height <= 700;
  const hud = low ? 48 : 56;
  const round = low ? 30 : 36;
  const hand = low ? 146 : 176;
  const cardW = low ? 64 : 74;
  const cardH = low ? 94 : 112;
  const arenaW = width - 24;
  const arenaH = height - hud - round - hand - 14;
  const gap = 14;
  const labelH = 15;
  const gridW = cardW * 4 + gap * 3;
  const gridH = cardH + 4 + labelH;
  const tableW = Math.min(width * 0.66, 720);
  const tableH = Math.max(low ? 260 : 250, Math.min(520, arenaH - (low ? 70 : 86)));
  const table = rect((arenaW - tableW) / 2, (arenaH - tableH) / 2, tableW, tableH, 'table-safe-area');
  assert.ok(gridW <= tableW && gridH <= tableH, `${width}x${height}: desktop trick row fits table`);
  const startX = (arenaW - gridW) / 2;
  const startY = (arenaH - gridH) / 2;
  const cards = ['left','top','right','bottom'].map((name, index) => rect(startX + index * (cardW + gap), startY, cardW, cardH, `${name}-card`));
  const labels = ['left','top','right','bottom'].map((name, index) => rect(startX + index * (cardW + gap), startY + cardH + 4, cardW, labelH, `${name}-label`));
  assertAllSeparated([...cards, ...labels], `${width}x${height} desktop card/label cells`);

  const playerW = Math.max(126, Math.min(184, width * 0.14));
  const playerH = 64;
  const players = [
    rect((arenaW - playerW) / 2, 9, playerW, playerH, 'top-player'),
    rect(9, (arenaH - playerH) / 2, playerW, playerH, 'left-player'),
    rect(arenaW - 9 - playerW, (arenaH - playerH) / 2, playerW, playerH, 'right-player'),
    rect((arenaW - playerW) / 2, arenaH - 9 - playerH, playerW, playerH, 'bottom-player')
  ];
  for(const item of [...cards, ...labels]) for(const player of players) assertSeparated(item, player, `${width}x${height}`);

  const messageW = Math.min(arenaW * 0.72, 620);
  const message = rect((arenaW - messageW) / 2, arenaH - 80 - 30, messageW, 30, 'message-rail');
  for(const item of [...cards, ...labels, ...players]) assertSeparated(message, item, `${width}x${height} desktop message`);

  const commentaryW = Math.min(330, width * 0.31);
  const commentary = rect(arenaW - 14 - commentaryW, 14, commentaryW, 64, 'commentary');
  for(const player of players) assertSeparated(commentary, player, `${width}x${height} desktop commentary`);
  const face = rect(commentary.x + 7, commentary.y + 7, 32, 32, 'comment-avatar');
  const copy = rect(face.right + 7, commentary.y + 7, commentary.right - 7 - face.right - 7, commentary.height - 14, 'comment-copy');
  assert.ok(copy.width > 150, `${width}x${height}: desktop commentary copy has readable width`);
  assertSeparated(face, copy, `${width}x${height} desktop commentary internals`);

  const resultW = Math.min(tableW * 0.94, 500);
  const resultH = 50;
  const result = rect(table.x + (table.width - resultW) / 2, table.bottom - 7 - resultH, resultW, resultH, 'result-summary');
  assertInside(result, table, `${width}x${height} desktop result lane`);
  for(const item of [...cards, ...labels, ...players.slice(0, 3)]) assertSeparated(item, result, `${width}x${height} desktop result lane`);

  return {width, height, arena:[arenaW, arenaH], grid:[gridW, gridH], resultCardGap:Number((result.y - labels[0].bottom).toFixed(2)), messagePlayerGap:Number((players[3].y - message.bottom).toFixed(2))};
}

const portrait = [
  [320,568], [360,600], [360,640], [390,600], [390,640], [390,664], [390,844], [393,852], [430,600], [430,650], [430,800], [430,932]
].map(v => portraitProfile(...v));

const landscape = [
  [568,320], [640,360], [667,375], [844,390], [932,430]
].map(v => landscapeProfile(...v));

const desktop = [
  [768,600], [1024,600], [1280,720], [1024,768], [1280,800], [1440,900]
].map(v => desktopProfile(...v));

console.log(JSON.stringify({result:'passed', portrait, landscape, desktop}));
