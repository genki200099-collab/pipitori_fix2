'use strict';
const assert=require('assert');
const path=require('path');
const {spawn}=require('child_process');
const WebSocket=require('ws');
const root=path.resolve(__dirname,'..');
const port=41000+(process.pid%15000);
const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','pipe']});
let ws;let done=false;let lastCount=-1;let addRequests=0;let startSent=false;const errors=[];
const deadline=setTimeout(()=>finish(new Error('rapid lobby repeat timeout')),15000);
child.stderr.on('data',d=>errors.push(String(d)));
function send(o){if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify(o));}
function cleanup(){clearTimeout(deadline);try{ws?.close();}catch{}try{child.kill('SIGKILL');}catch{}}
function finish(err,result){if(done)return;done=true;cleanup();if(err){console.error(err.stack||err);if(errors.length)console.error(errors.join(''));process.exit(1);}console.log(JSON.stringify(result));process.exit(0);}
child.stdout.on('data',d=>{
 if(!String(d).includes('server listening')||ws)return;
 ws=new WebSocket(`ws://127.0.0.1:${port}`);
 ws.on('open',()=>send({type:'create',name:'RapidHost',rounds:1,feastPointPerCard:5,pickProviderRole:'weakest'}));
 ws.on('message',raw=>{
  try{
   const m=JSON.parse(String(raw));
   if(m.type==='errorMsg')throw new Error(m.message);
   if(m.type!=='state')return;
   const s=m.state;
   assert.strictEqual(s.feastPointPerCard,5);
   assert.strictEqual(s.pickProviderRole,'weakest');
   if(s.phase==='playing'){
    assert.strictEqual(s.players.length,4);
    assert.strictEqual(addRequests,3);
    assert.strictEqual(s.players.filter(p=>p.cpu).length,3);
    assert.strictEqual(s.players[0].handCount,13);
    return finish(null,{result:'passed',players:s.players.length,addRequests,phase:s.phase,handCount:s.players[0].handCount});
   }
   if(s.phase!=='lobby')return;
   if(s.players.length===lastCount)return;
   lastCount=s.players.length;
   if(s.players.length<4){addRequests++;send({type:'addCpu'});return;}
   assert.strictEqual(s.players.length,4);
   assert.strictEqual(addRequests,3);
   assert.strictEqual(s.players.filter(p=>p.cpu).length,3);
   if(!startSent){startSent=true;send({type:'start'});}
  }catch(e){finish(e);}
 });
 ws.on('error',finish);
});
child.on('exit',code=>{if(!done)finish(new Error(`server exited ${code}`));});
