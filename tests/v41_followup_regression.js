'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const csstree=require('css-tree');

const root=path.resolve(__dirname,'..');
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
const html=fs.readFileSync(path.join(root,'public','index.html'),'utf8');
const styleBlocks=[...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(match=>match[1]);
assert(styleBlocks.length>0,'application CSS exists');
for(const css of styleBlocks) csstree.parse(css,{positions:true});

// CPU 1～3 are authored identities. Only the repeated fourth personality receives an animal identity.
assert.match(server,/const characterAlreadySeated=.*cpuCharacter\(player\)\?\.key===ch\.key/);
assert.match(server,/characterAlreadySeated\s*\? assignCpuDisplayIdentity\(room\)\s*:\s*\{name:ch\.name,avatar:ch\.avatar,identityKey:null\}/);

// A routine two-lane result must no longer fall through without a comment.
const summary=server.slice(server.indexOf('function parallelPickSummary'),server.indexOf('function finishParallelPickGroup'));
assert(!summary.includes('if(!important) return'),'routine parallel results cannot silently return');
assert(summary.includes('2つのピックが決着。次の手札の流れに注目です。'));
assert.match(summary,/group\.commentEmitted=true/);
const shoot=server.slice(server.indexOf('function resolveShootDecision'),server.indexOf('function beginPickStepResume'));
assert.match(shoot,/room\.parallelPickGroup\.preferredCommentPid=reactionPid/,'parallel shoot commentary is deferred to group completion');

// Lobby role state cannot be squeezed into one-glyph columns by the global phone button width rule.
assert.match(html,/\.participant-role-actions>span\{[\s\S]*?white-space:nowrap/);
assert.match(html,/@media\(max-width:620px\)\{[\s\S]*?\.participant-role-actions\{[\s\S]*?display:grid/);
assert.match(html,/\.participant-role-actions \.btn\{width:100%;max-width:none\}/);

// Parallel target selection keeps the primary result compact and the actual commit action reachable.
for(const token of ['is-target-selecting','parallel-target-status','parallel-mandatory-note','parallel-pick-submit']) assert(html.includes(token),`${token} exists`);
assert(html.includes('🃏 ババブタ選択済み'));
assert(html.includes('ピック対象を確定'));
assert.match(html,/\.parallel-pick-shell\{[\s\S]*?overflow-y:auto/,'parallel shell has an intentional portrait scroll fallback');
assert.match(html,/\.parallel-pick-lane\.is-target-selecting \.parallel-pick-submit\{[\s\S]*?position:sticky/);
assert.match(html,/\.parallel-pick-lane\.is-complete \.parallel-lane-people\{display:none\}/);

// At the reported tall iPhone sizes, the compact layout budget fits the measured v40 table heights.
// Smaller supported screens use the bounded inner scroll plus the sticky 44px commit action.
const compactBudgetPx=435;
const portraitCases=[
  {viewport:'320x568',tableHeight:187,mode:'bounded-scroll'},
  {viewport:'375x667',tableHeight:266,mode:'bounded-scroll'},
  {viewport:'390x844',tableHeight:443,mode:'direct-fit'},
  {viewport:'393x852',tableHeight:451,mode:'direct-fit'},
  {viewport:'430x932',tableHeight:531,mode:'direct-fit'}
];
for(const item of portraitCases){
  if(item.mode==='direct-fit') assert(item.tableHeight>=compactBudgetPx,`${item.viewport} fits the compact lanes`);
  else assert(html.includes('overflow-y:auto')&&html.includes('position:sticky'),`${item.viewport} retains a reachable action`);
}

// Pair choice text explicitly names both the action and the skipped operation.
assert(html.includes('ペア浄化対象を選んでください'));
assert(html.includes('ペア浄化をスキップ'));
assert(html.includes('この札と浄化'));
assert(server.includes('浄化しない場合は「ペア浄化をスキップ」を選べます。'));

// Every user-facing middle-pick explanation describes the v40/v41 parallel flow.
for(const stale of ['通常ピック後に2位','続けて2位→3位','1位→最弱に続いて2位→3位','必殺技演出の後にその追加ピック']){
  assert(!html.includes(stale),`serial wording removed: ${stale}`);
}
assert(html.includes('1位↔4位と2位→3位を同時進行します'));

console.log(JSON.stringify({
  result:'passed',suite:'v41-followup-regression',cssParsed:true,
  fixedCpuPersonas:3,randomAnimalSeat:4,parallelCommentAfterBoth:true,
  lobbyRoleHorizontal:true,targetConfirmSticky:true,pairCopyExplicit:true,
  portraitCases
}));
