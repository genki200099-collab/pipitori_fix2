'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const vm=require('vm');

const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'public','index.html'),'utf8');
const serverSource=fs.readFileSync(path.join(root,'server.js'),'utf8');

const styles=[...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(m=>m[1]);
const scripts=[...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m=>m[1]);
const markupOnly=html
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'')
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'');
const ids=new Map();
for(const m of markupOnly.matchAll(/\bid\s*=\s*(["'])(.*?)\1/gi)) ids.set(m[2],(ids.get(m[2])||0)+1);
const inlineClickCount=[...markupOnly.matchAll(/\bonclick\s*=/gi)].length;

assert.strictEqual(styles.length,1,'one consolidated stylesheet expected');
assert.strictEqual(scripts.length,1,'one consolidated client script expected');
assert.deepStrictEqual([...ids].filter(([,count])=>count>1),[],'duplicate DOM ids are not allowed');
assert.strictEqual(inlineClickCount,0,'inline click handlers are not allowed');
assert.doesNotMatch(html,/\sonclick=/,'generated markup must also avoid inline click handlers');
assert.doesNotMatch(scripts[0],/\balert\s*\(/,'blocking browser alerts must not interrupt play');
assert.doesNotMatch(scripts[0],/\bconfirm\s*\(/,'blocking browser confirms must not interrupt play');

function assertBalancedCss(css){
  const cleaned=css
    .replace(/\/\*[\s\S]*?\*\//g,'')
    .replace(/"(?:\\.|[^"\\])*"/g,'""')
    .replace(/'(?:\\.|[^'\\])*'/g,"''");
  let depth=0;
  for(const ch of cleaned){
    if(ch==='{') depth++;
    else if(ch==='}') depth--;
    assert(depth>=0,'CSS contains an unexpected closing brace');
  }
  assert.strictEqual(depth,0,'CSS braces must be balanced');
}
for(const css of styles) assertBalancedCss(css);

new vm.Script(serverSource,{filename:'server.js'});
new vm.Script(scripts[0],{filename:'public/index.html#script'});

function topLevelFunctionNames(source){
  const names=new Map();
  for(const m of source.matchAll(/^function\s+([A-Za-z_$][\w$]*)\s*\(/gm)){
    const line=source.slice(0,m.index).split('\n').length;
    const rows=names.get(m[1])||[];
    rows.push(line);
    names.set(m[1],rows);
  }
  return names;
}
function duplicates(source){
  return [...topLevelFunctionNames(source)].filter(([,lines])=>lines.length>1);
}
assert.deepStrictEqual(duplicates(serverSource),[],'server functions must not be silently overridden');
assert.deepStrictEqual(duplicates(scripts[0]),[],'client functions must not be silently overridden');

assert.match(html,/viewport-fit=cover/);
assert.match(html,/env\(safe-area-inset-bottom\)/);
assert.match(html,/@media\(prefers-reduced-motion:reduce\)/);
assert.match(html,/:where\(button,input,select,summary,\[tabindex\]\):focus-visible/);
assert.match(html,/\.hud-button\{min-width:42px;min-height:36px/);
assert.match(html,/\.round-panel \.round-actions\{position:sticky/);
assert.match(serverSource,/maxPayload:64 \* 1024/);
assert.match(serverSource,/try\{[\s\S]*client message handling error/);
assert.match(serverSource,/const HUMAN_ANIMAL_IDENTITIES = Object\.freeze/);
assert.match(serverSource,/function clearRoom\(room, requesterId, requesterWs=null\)/);
assert.match(serverSource,/pickProviderPid: roles\.pickProviderPid/);
assert.match(serverSource,/pickerPid: roles\.pickerPid/);
assert.match(html,/id="feastPointPerCard"/);
assert.match(html,/id="pickProviderRole"/);
assert.match(html,/msg\.type==='roomClosed'/);

console.log(JSON.stringify({
  result:'passed',
  htmlBytes:Buffer.byteLength(html),
  ids:ids.size,
  cssParsed:true,
  serverFunctions:topLevelFunctionNames(serverSource).size,
  clientFunctions:topLevelFunctionNames(scripts[0]).size,
  duplicateIds:0,
  duplicateFunctions:0,
  blockingAlerts:0
}));
