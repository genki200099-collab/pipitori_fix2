'use strict';
const assert=require('assert');
const path=require('path');
const {spawn}=require('child_process');
const WebSocket=require('ws');
const root=path.resolve(__dirname,'..');
const port=36000+(process.pid%20000);
const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','pipe']});
let code=''; let finished=false; const clients=[]; const errors=[]; const started=Date.now();
const deadline=setTimeout(()=>done(new Error('four-human smoke timeout')),210000);
child.stderr.on('data',d=>errors.push(String(d)));
function send(ws,obj){if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(obj));}
function cleanup(){clearTimeout(deadline);for(const c of clients){try{c.ws.close();}catch{}}try{child.kill('SIGKILL');}catch{}}
function done(err,result){if(finished)return;finished=true;cleanup();if(err){console.error(err.stack||err);if(errors.length)console.error(errors.join(''));process.exit(1);}console.log(JSON.stringify(result));process.exit(0);}
function actionFor(c,state){
 assert.strictEqual(state.feastPointPerCard,2);assert.strictEqual(state.pickProviderRole,'weakest');
 if(state.phase==='lobby'){
  if(c.index===0&&state.players.length===4)send(c.ws,{type:'start'});
  return;
 }
 if(state.phase==='roundEnd'){send(c.ws,{type:'continueRound'});return;}
 if(state.phase==='finished'){
  if(c.index===0)done(null,{result:'passed',elapsedMs:Date.now()-started,totals:state.players.map(p=>p.final.total),round:state.round});
  return;
 }
 if(state.phase!=='playing')return;
 const pp=state.pendingPick;
 if(pp?.targetSelectionRequired&&!pp.targetSelectionDone&&pp.pickProviderPid===state.yourIndex){
  const n=Math.min(pp.targetCandidateCount||0,pp.targetSelectableCardIds?.length||0);
  const ids=(pp.targetSelectableCardIds||[]).slice(0,n); const key=`target:${pp.readyAt}:${ids.join(',')}`;
  if(ids.length&&c.last!==key){c.last=key;send(c.ws,{type:'pickTargets',cardIds:ids});}return;
 }
 if(pp?.pairChoice&&pp.pickerPid===state.yourIndex){const key=`pair:${pp.pairChoice.drawn?.id}`;if(c.last!==key){c.last=key;send(c.ws,{type:'pairChoice',skip:true});}return;}
 if(pp&&!pp.result&&pp.pickerPid===state.yourIndex&&pp.ready){const key=`pick:${pp.readyAt}`;if(c.last!==key){c.last=key;send(c.ws,{type:'pick',index:0});}return;}
 if(state.isYourTurn&&state.playableCardIds?.length){const cardId=state.playableCardIds[0];const key=`play:${state.round}:${state.trick?.length}:${cardId}:${state.players[state.yourIndex]?.handCount}`;if(c.last!==key){c.last=key;send(c.ws,{type:'play',cardId});}}
}
function connect(index,name,join=false){
 const ws=new WebSocket(`ws://127.0.0.1:${port}`);const c={ws,index,name,last:''};clients.push(c);
 ws.on('open',()=>{if(join)send(ws,{type:'join',code,name});else send(ws,{type:'create',name,rounds:1,roundDealMode:'reshuffle',feastPointPerCard:2,pickProviderRole:'weakest'});});
 ws.on('message',raw=>{try{const m=JSON.parse(String(raw));if(m.type==='errorMsg')throw new Error(`${name}: ${m.message}`);if(m.type==='created'){code=m.code;for(let i=1;i<4;i++)connect(i,`Human${i}`,true);}if(m.type==='state')actionFor(c,m.state);}catch(e){done(e);}});
 ws.on('error',done);
}
child.stdout.on('data',d=>{if(String(d).includes('server listening')&&!clients.length)connect(0,'Human0',false);});
