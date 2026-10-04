'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const vm=require('vm');
const root=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'server.js'),'utf8');
const html=fs.readFileSync(path.join(root,'public','index.html'),'utf8');

// Generic duplicate protection must exclude legitimate repeatable seat changes.
const mutationSetMatch=source.match(/const DEDUPED_CLIENT_ACTION_TYPES = new Set\(\[([^\]]+)\]\)/);
assert(mutationSetMatch,'duplicate-action mutation set missing');
const protectedTypes=mutationSetMatch[1];
assert(!protectedTypes.includes('addCpu'),'addCpu must remain repeatable');
assert(!protectedTypes.includes('removeCpu'),'removeCpu must remain repeatable');
assert(protectedTypes.includes('play'),'irreversible play action must remain protected');
assert(protectedTypes.includes('continueRound'),'continueRound must remain protected');

assert(html.includes('function finalShootRuleExplanation()'),'dynamic final shoot explanation missing');
assert(html.includes("state?.shootThePigLimit === 'once'"),'once/unlimited branch missing');
assert(html.includes('発動回数無制限（同一ラウンドでは1回、別ラウンドで再発動可能）'),'unlimited explanation missing');
assert(html.includes('各プレイヤー1ゲーム1回まで'),'once explanation missing');
assert(html.includes('この部屋ではシュート・ザ・ピッグを使用しません。'),'shoot-off explanation missing');
assert(html.includes('マッド・ピッグなしのため、シュート・ザ・ピッグは発動しません。'),'mad-off explanation missing');
assert(!html.includes('各プレイヤー1回までです。山のマッドは条件に含みません。'),'stale hard-coded final-result rule remains');

console.log('v34 senior audit regression: all assertions passed');
