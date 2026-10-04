'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const {
  PERSONA_PROFILES,
  DIALOGUE_POOLS,
  COMMON_EVENTS,
  createPersonaLine,
  getSpotlightPresentation
} = require('../cpu_personality_dialogue');

const characters = ['kamomodoki','wakumodoki','rikumodoki'];
const ctx = {
  target:'ピピ', winner:'ワクもどき', weakest:'リクもどき', speaker:'CPU',
  card:'💧11', drawn:'ババブタ', round:3, remaining:2, penalty:20,
  mode:'通常カード-3／💧-6'
};

for(const key of characters){
  assert(PERSONA_PROFILES[key], `${key} profile must exist`);
  assert(DIALOGUE_POOLS[key], `${key} dialogue pool must exist`);
  const templates = Object.values(DIALOGUE_POOLS[key].events).flat();
  assert(templates.length >= 180, `${key} needs a very large event-aware dialogue pool`);
  assert(new Set(templates).size === templates.length, `${key} templates must not contain exact duplicates`);

  for(const event of COMMON_EVENTS){
    for(let i=0;i<20;i++){
      const line = createPersonaLine(key, event, ctx, []);
      assert(line && typeof line === 'string', `${key}/${event} must return dialogue`);
      assert([...line].length <= 86, `${key}/${event} dialogue must remain displayable: ${line}`);
    }
    const presentation = getSpotlightPresentation(key, event);
    assert(['normal','joy','anger','sad','pleased'].includes(presentation.emotion), 'valid portrait emotion required');
    assert(['normal','focus','impact','scheme','jagged','burst'].includes(presentation.bubble), 'valid bubble style required');
    const portrait = path.join('public','cpu_characters','spotlight',key,presentation.imageFile);
    assert(fs.existsSync(portrait), `portrait must exist: ${portrait}`);
  }
}

const kamoLines = Object.values(DIALOGUE_POOLS.kamomodoki.events).flat().join('\n');
assert(!/(50歳|五十歳|年齢は|年齢が)/.test(kamoLines), 'kamomodoki dialogue must never directly mention age');
for(const phrase of ['明日のパン','おでん','刻みネギ','昭和','子ども']){
  assert(kamoLines.includes(phrase), `kamomodoki flavour missing: ${phrase}`);
}
const wakuLines = Object.values(DIALOGUE_POOLS.wakumodoki.events).flat().join('\n');
for(const phrase of ['エベレスト','長野','スネから拭く','寝かしつけ']){
  assert(wakuLines.includes(phrase), `wakumodoki flavour missing: ${phrase}`);
}
const rikuLines = Object.values(DIALOGUE_POOLS.rikumodoki.events).flat().join('\n');
for(const phrase of ['進捗','締切','良くない…良くないよ…','未完了タスク']){
  assert(rikuLines.includes(phrase), `rikumodoki flavour missing: ${phrase}`);
}

let namedCount = 0;
let seed = 1;
const originalRandom = Math.random;
Math.random = ()=>((seed=(seed*1664525+1013904223)>>>0)/4294967296);
try{
  for(let i=0;i<500;i++){
    const line = createPersonaLine(characters[i%characters.length], COMMON_EVENTS[i%COMMON_EVENTS.length], ctx, []);
    if(line.includes('ピピ') || line.includes('ワクもどき') || line.includes('リクもどき')) namedCount++;
  }
} finally {
  Math.random = originalRandom;
}
assert(namedCount >= 80, 'dynamic player names should appear often enough to personalize commentary');


// Object-valued context must never leak JavaScript's default stringification
// into user-visible dialogue. This reproduces the reported [object Object] bug.
const objectCtx = {
  target:{name:'ピピ'}, winner:{name:'ワクもどき'}, weakest:{name:'リクもどき'},
  speaker:{name:'CPU'}, card:{suit:'mud',rank:'12',val:12,joker:false},
  drawn:{joker:true,rank:'JOKER'}, round:2, remaining:3, penalty:20,
  mode:{label:'通常カード-3／💧-6'}
};
for(const key of characters){
  for(const event of COMMON_EVENTS){
    for(let i=0;i<30;i++){
      const line=createPersonaLine(key,event,objectCtx,[]);
      assert(!line.includes('[object Object]'),`${key}/${event} leaked object stringification: ${line}`);
    }
  }
}

console.log('cpu personality dialogue regression: all assertions passed');
