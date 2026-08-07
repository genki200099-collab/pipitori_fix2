'use strict';
const fs=require('fs');
const path=require('path');
const assert=require('assert');
const html=fs.readFileSync(path.join(__dirname,'..','public','index.html'),'utf8');

assert(/body\.finished-mode\{[\s\S]*?overflow:hidden!important/.test(html),'finished mode must lock the document scroll');
assert(/body\.finished-mode \.score-screen\{[\s\S]*?position:fixed!important[\s\S]*?overflow-y:auto!important[\s\S]*?-webkit-overflow-scrolling:touch!important[\s\S]*?touch-action:pan-y!important/.test(html),'score screen must own vertical touch scrolling');
assert(/body\.finished-mode \.final-actions\{[\s\S]*?position:sticky/.test(html),'final actions must stay reachable');
assert(/\.round-panel,[\s\S]*?\.utility-sheet,[\s\S]*?\.rule-help-panel\{[\s\S]*?-webkit-overflow-scrolling:touch/.test(html),'other tall overlays must support iOS momentum scrolling');
assert(/if\(__lastUiPhase !== state\.phase\)/.test(html),'phase transition must reset result scroll safely');
assert(/scoreScreen\.scrollTop=0/.test(html),'result scroll must reset when entering or leaving finished phase');
console.log('final result scroll regression: all assertions passed');
