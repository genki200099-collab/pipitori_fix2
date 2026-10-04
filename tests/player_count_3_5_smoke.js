'use strict';

const assert=require('assert');
const path=require('path');
const {spawn}=require('child_process');
const WebSocket=require('ws');

const root=path.resolve(__dirname,'..');
const port=36000+(process.pid%20000);
const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','pipe']});
const errors=[];
let client=null,done=false,capacity=3,lastRequestedCount=-1,startSent=false;
let timeout=setTimeout(()=>fail(new Error('3/5 player startup timed out')),25000);
function stop(){clearTimeout(timeout);if(client&&client.readyState<WebSocket.CLOSING)client.close();if(!child.killed)child.kill('SIGTERM');}
function fail(error){if(done)return;done=true;stop();console.error(error.stack||error);if(errors.length)console.error(errors.join(''));process.exitCode=1;}
function connectRoom(seats){capacity=seats;lastRequestedCount=-1;startSent=false;client=new WebSocket(`ws://127.0.0.1:${port}`);client.on('open',()=>client.send(JSON.stringify({type:'create',name:`${seats}p smoke`,playerCount:seats,rounds:1})));client.on('message',raw=>{
  try{
    const msg=JSON.parse(String(raw));
    if(msg.type==='errorMsg')throw new Error(msg.message);
    if(msg.type!=='state')return;
    const state=msg.state;
    assert.strictEqual(state.playerSeatCapacity,seats);
    if(state.phase==='lobby'){
      if(state.players.length<seats&&state.players.length!==lastRequestedCount){lastRequestedCount=state.players.length;client.send(JSON.stringify({type:'addCpu'}));}
      else if(state.players.length===seats&&!startSent){startSent=true;client.send(JSON.stringify({type:'start'}));}
      return;
    }
    if(state.phase==='playing'){
      const target=Math.floor(52/seats);
      assert.strictEqual(state.cardsPerPlayer,target);
      assert.deepStrictEqual(state.players.map(p=>p.handCount),Array(seats).fill(target));
      console.log(`${seats}-player startup passed (${target} cards each)`);
      client.close();
      if(seats===3){setTimeout(()=>connectRoom(5),150);return;}
      done=true;stop();
    }
  }catch(error){fail(error);}
});client.on('error',fail);}
child.stderr.on('data',chunk=>errors.push(String(chunk)));
child.stdout.on('data',chunk=>{if(String(chunk).includes('server listening')&&!client)connectRoom(3);});
child.on('exit',code=>{if(!done&&code!==null)fail(new Error(`server exited (${code})`));});
