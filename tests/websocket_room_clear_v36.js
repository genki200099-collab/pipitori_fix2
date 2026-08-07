'use strict';

const assert=require('assert');
const path=require('path');
const {spawn}=require('child_process');
const WebSocket=require('ws');
const root=path.resolve(__dirname,'..');
const port=35000+(process.pid%20000);

function waitFor(socket,predicate,timeout=5000){
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{cleanup();reject(new Error('message timeout'));},timeout);
    const onMessage=raw=>{
      let msg;try{msg=JSON.parse(String(raw));}catch{return;}
      if(!predicate(msg))return;
      cleanup();resolve(msg);
    };
    const onError=error=>{cleanup();reject(error);};
    function cleanup(){clearTimeout(timer);socket.off('message',onMessage);socket.off('error',onError);}
    socket.on('message',onMessage);socket.on('error',onError);
  });
}
function sendAwait(socket,payload,predicate,timeout){
  const pending=waitFor(socket,predicate,timeout);socket.send(JSON.stringify(payload));return pending;
}
function openSocket(){return new Promise((resolve,reject)=>{const socket=new WebSocket(`ws://127.0.0.1:${port}`);socket.once('open',()=>resolve(socket));socket.once('error',reject);});}

const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','pipe']});
let stderr='';child.stderr.on('data',chunk=>stderr+=String(chunk));

(async()=>{
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('server start timeout')),5000);
    child.stdout.on('data',chunk=>{if(String(chunk).includes('server listening')){clearTimeout(timer);resolve();}});
    child.once('exit',code=>reject(new Error(`server exited ${code}`)));
  });
  const host=await openSocket();
  const created=await sendAwait(host,{type:'create',name:''},m=>m.type==='created');
  const hostStatePromise=waitFor(host,m=>m.type==='state'&&m.state?.players?.length===2);
  const guest=await openSocket();
  const joined=await sendAwait(guest,{type:'join',name:'',code:created.code},m=>m.type==='joined');
  const twoState=(await hostStatePromise).state;
  assert.notStrictEqual(created.name,joined.name);
  assert.notStrictEqual(created.avatar,joined.avatar);
  assert.strictEqual(new Set(twoState.players.map(p=>p.name)).size,2);
  assert.strictEqual(new Set(twoState.players.map(p=>p.avatar)).size,2);

  const denied=await sendAwait(guest,{type:'clearRoom'},m=>m.type==='errorMsg');
  assert.match(denied.message,/ホスト/);

  const hostClosed=waitFor(host,m=>m.type==='roomClosed');
  const guestClosed=waitFor(guest,m=>m.type==='roomClosed');
  host.send(JSON.stringify({type:'clearRoom'}));
  const [hClose,gClose]=await Promise.all([hostClosed,guestClosed]);
  assert.strictEqual(hClose.reason,'hostCleared');assert.strictEqual(gClose.reason,'hostCleared');

  const stale=await openSocket();
  const staleError=await sendAwait(stale,{type:'reconnect',code:created.code,playerId:created.playerId,resumeToken:created.resumeToken,name:created.name},m=>m.type==='errorMsg');
  assert.match(staleError.message,/見つかりません/);

  const recreatedAck=waitFor(host,m=>m.type==='created');
  const recreatedState=waitFor(host,m=>m.type==='state'&&m.state?.players?.[0]?.name==='新ホスト');
  host.send(JSON.stringify({type:'create',name:'新ホスト',feastPointPerCard:2,pickProviderRole:'weakest'}));
  const recreated=await recreatedAck;
  const newState=(await recreatedState).state;
  assert.notStrictEqual(recreated.code,created.code);
  assert.strictEqual(recreated.name,'新ホスト');
  assert.strictEqual(newState.feastPointPerCard,2);
  assert.strictEqual(newState.pickProviderRole,'weakest');
  for(const socket of [host,guest,stale])socket.close();
  child.kill('SIGTERM');
  console.log(JSON.stringify({result:'passed',oldCode:created.code,newCode:recreated.code,identities:twoState.players.map(p=>`${p.avatar}${p.name}`)}));
})().catch(error=>{
  child.kill('SIGTERM');
  console.error(error.stack||error);if(stderr)console.error(stderr);process.exitCode=1;
});
