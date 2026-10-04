'use strict';
// DOM behavior only. jsdom does not render, lay out, or emulate iOS Safari.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');const vm=require('node:vm');
const base=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(base,'public/index.html'),'utf8');
const main=[...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)][0][1];
const native=fs.readFileSync(path.join(base,'public/iphone-ui.js'),'utf8');
const widths=[320,375,390,430,768,1024,1440];
const fixtures=JSON.parse(fs.readFileSync(path.join(base,'qa/v44/browser-fixtures.json'),'utf8'));
function run(w,source){return new vm.Script(source).runInContext(w.__context);}
const rows=[];
function create(width,height=844,coarse=true){
 const dom=new JSDOM(html.replace(/<style[^>]*>[\s\S]*?<\/style>/g,'').replace(/<script[^>]*>[\s\S]*?<\/script>/g,''),{url:'http://localhost/',runScripts:'outside-only'});
 const w=dom.window,d=w.document;w.__context=dom.getInternalVMContext();w.innerWidth=width;w.innerHeight=height;w.scrollY=180;
 const viewport=new w.EventTarget();Object.assign(viewport,{height,offsetTop:0,scale:1});w.visualViewport=viewport;
 const raf=[];w.requestAnimationFrame=fn=>{raf.push(fn);return raf.length;};
 w.matchMedia=q=>({matches:q.includes('max-width: 720') ? width<=720||(height<=520&&coarse):q.includes('max-width:430')?width<=430:q.includes('prefers-reduced-motion')?false:q.includes('pointer: coarse')||q.includes('hover: none')?coarse:false,addEventListener(){}});
 w.scrollTo=opt=>{w.lastScroll=opt;};w.HTMLElement.prototype.scrollIntoView=function(opt){this.lastScroll=opt;};
 w.HTMLElement.prototype.getClientRects=function(){return this.closest('[hidden]')?[]:[{width:44,height:44}];};
 w.getComputedStyle=()=>({fontSize:d.documentElement.style.fontSize==='200%'?'32px':'16px'});
 w.setInterval=()=>0;w.clearInterval=()=>{};
 new vm.Script(main).runInContext(dom.getInternalVMContext());new vm.Script(native).runInContext(dom.getInternalVMContext());d.dispatchEvent(new w.Event('DOMContentLoaded'));
 const flush=()=>{let count=0;while(raf.length){if(++count>100)throw Error('RAF loop');raf.shift()();}};flush();
 const event=(target,type,opts={})=>{const e=new w.Event(type,{bubbles:true,cancelable:true});Object.assign(e,{pointerId:1,pointerType:'touch',button:0,isPrimary:true,clientX:20,clientY:20,detail:1,...opts});target.dispatchEvent(e);return e;};
 return {dom,w,d,flush,event};
}
try{
for(const width of widths){
 const {dom,w,d,flush,event}=create(width);
 try{
 d.getElementById('gameScreen').hidden=false;
 const opener=d.querySelector('[data-game-panel="log"]'),root=d.getElementById('gameUtilityPanel');
 opener.focus();opener.click();
 assert.equal(root.hidden,false);assert.equal(opener.getAttribute('aria-expanded'),'true');
 assert.equal(d.activeElement.className,'utility-close');assert(d.getElementById('playerGameArena').inert);
 assert(d.body.classList.contains('native-sheet-open'));
 d.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
 assert.equal(root.hidden,true);assert.equal(d.activeElement,opener);assert.equal(w.lastScroll.top,180);
 assert.equal(opener.getAttribute('aria-expanded'),'false');assert(!d.getElementById('playerGameArena').inert);
 const help=d.querySelector('.rule-help-btn');help.focus();w.openRuleHelp(help.dataset.helpRule);
 assert(d.getElementById('ruleHelpModal').classList.contains('open'));
 d.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
 assert.equal(d.activeElement,help);assert(!d.body.classList.contains('native-sheet-open'));
 const code=d.getElementById('code');code.value='ａｂ１２';event(code,'input');assert.equal(code.value,'AB12');
 code.value='ａｂ';event(code,'input',{isComposing:true});assert.equal(code.value,'ａｂ');event(code,'compositionend');assert.equal(code.value,'AB');
 let joins=0;d.getElementById('join').addEventListener('click',()=>joins++);
 code.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}));assert.equal(joins,0);
 code.value='';code.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));assert.equal(joins,1);
 const name=d.getElementById('name');name.focus();name.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));assert.notEqual(d.activeElement,name);
 const card=d.createElement('button');card.dataset.cardId='qa-card';d.getElementById('hand').append(card);
 event(card,'pointerdown');let up=event(card,'pointerup');assert.equal(w.PipitoriNativeUI.allowAction(up),true);
 event(card,'pointerdown');event(card,'pointermove',{clientY:70});up=event(card,'pointerup',{clientY:70});assert.equal(w.PipitoriNativeUI.allowAction(up),false);
 assert.equal(w.PipitoriNativeUI.allowAction(event(card,'click')),false);
 assert.equal(w.PipitoriNativeUI.allowAction(event(card,'click',{detail:0})),true);
 event(card,'pointerdown');event(card,'pointercancel');assert.equal(w.PipitoriNativeUI.allowAction(event(card,'click')),false);
 event(card,'pointerdown');up=event(card,'pointerup');assert.equal(w.PipitoriNativeUI.allowAction(up),true);
 event(card,'pointerdown');event(card,'pointerdown',{isPrimary:false,pointerId:2});up=event(card,'pointerup');assert.equal(w.PipitoriNativeUI.allowAction(up),false);
 // Exercise the existing card-selection handler and outgoing game message.
 run(w,`(${fixtures.BASE})();renderHand();ws={readyState:1};window.sent=[];send=payload=>{window.sent.push(payload);return true;};`);
 const playable=d.querySelector('#hand [data-card-id]');
 event(playable,'pointerdown');event(playable,'pointermove',{clientY:70});event(playable,'pointerup',{clientY:70});
 assert.equal(playable.getAttribute('aria-pressed'),'false');assert.equal(w.sent.length,0);
 event(playable,'pointerdown');event(playable,'pointerup');assert.equal(playable.getAttribute('aria-pressed'),'true');assert.equal(w.sent.length,0);
 event(playable,'pointerdown');event(playable,'pointerup');assert.equal(w.sent.length,1);assert.equal(w.sent[0].type,'play');
 event(playable,'click');assert.equal(w.sent.length,1); // pointer + synthesized click cannot send twice
 d.documentElement.style.fontSize='200%';w.applyDeviceUiMode();assert(d.body.classList.contains('large-text-mode'));d.documentElement.style.fontSize='100%';w.applyDeviceUiMode();
 const oldNow=w.Date.now;let time=10000;w.Date.now=()=>time;event(card,'pointerdown');time+=600;up=event(card,'pointerup');assert.equal(w.PipitoriNativeUI.allowAction(up),false);w.Date.now=oldNow;
 if(width<=720){
 opener.focus();opener.click();const handle=root.querySelector('[data-native-sheet-handle]');
 event(handle,'pointerdown');event(handle,'pointermove',{clientY:140});event(handle,'pointerup',{clientY:140});assert.equal(root.hidden,true);
 opener.click();event(handle,'pointerdown');event(handle,'pointermove',{clientY:50});event(handle,'pointercancel');assert.equal(root.hidden,false);
 event(handle,'click',{detail:0});assert.equal(root.hidden,true);
 }
 // visualViewport data is simulated; this checks state and avoids layout claims.
 const viewport=w.visualViewport;viewport.height=440;
 code.getBoundingClientRect=()=>({top:600,bottom:648});code.focus();flush();
 assert.equal(d.documentElement.style.getPropertyValue('--native-keyboard-inset'),'404px');assert(d.body.classList.contains('native-keyboard-open'));assert(code.lastScroll);
 viewport.scale=1.5;viewport.dispatchEvent(new w.Event('resize'));flush();assert.equal(d.documentElement.style.getPropertyValue('--native-keyboard-inset'),'0px');
 code.blur();flush();assert(!d.body.classList.contains('native-keyboard-open'));
 rows.push({width,domBehavior:'passed',sheetFocusAndScroll:true,ime:true,gestureSafety:true,keyboardSimulation:true,largeTextModeSimulation:true,cardSelectionAndSingleSend:true,renderedLayout:'not_checked'});
 }finally{dom.window.close();}
}
// Landscape iPhone uses a sheet; desktop short windows with a mouse do not.
for(const coarse of [true,false]){
 const {dom,w,d,event}=create(844,390,coarse);
 try{const opener=d.querySelector('[data-game-panel="log"]');opener.click();const root=d.getElementById('gameUtilityPanel'),handle=root.querySelector('[data-native-sheet-handle]');event(handle,'pointerdown');event(handle,'pointermove',{clientY:140});event(handle,'pointerup',{clientY:140});assert.equal(root.hidden,coarse);w.closeGameUtilityPanel();rows.push({width:844,height:390,coarse,landscapeGesture:'passed',renderedLayout:'not_checked'});}finally{dom.window.close();}
}
const result={result:'passed',method:'jsdom DOM events; no rendered layout or iOS emulation',rows};
fs.writeFileSync(path.join(base,process.env.UI_QA_DIR || 'qa/v45','native-dom-behavior.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(e){console.error(e.stack);process.exitCode=1;}
