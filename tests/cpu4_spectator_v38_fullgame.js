'use strict';
const assert=require('assert');
const path=require('path');
const {spawn}=require('child_process');
const WebSocket=require('ws');
const root=path.resolve(__dirname,'..');
const port=41000+(process.pid%12000);
const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','pipe']});
let socket=null,finished=false,started=false,lastCpuCount=-1,sawMoveState=false,sawFullHands=false;
const errors=[];child.stderr.on('data',d=>errors.push(String(d)));
const deadline=setTimeout(()=>done(new Error('CPU4 spectator v38 full-game timeout')),240000);
function send(payload){if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(payload));}
function cleanup(){clearTimeout(deadline);try{socket?.close();}catch{}try{child.kill('SIGKILL');}catch{}}
function done(error,result){if(finished)return;finished=true;cleanup();if(error){console.error(error.stack||error);if(errors.length)console.error(errors.join(''));process.exit(1);}console.log(JSON.stringify(result));process.exit(0);}
function act(state){
  assert.strictEqual(state.participantRole,'spectator');
  assert.strictEqual(state.yourIndex,-1);
  assert.strictEqual(state.forceJokerPickCandidate,true);
  assert.strictEqual(state.shootRequiresBabaMoved,true);
  if(state.players.length===4 && state.phase!=='lobby') sawFullHands=state.players.every(p=>Array.isArray(p.hand));
  if(state.babaMovedThisRound) sawMoveState=true;
  if(state.phase==='lobby'){
    if(state.players.length<4){
      if(lastCpuCount!==state.players.length){lastCpuCount=state.players.length;send({type:'addCpu'});}
      return;
    }
    if(!started){started=true;send({type:'start'});}
    return;
  }
  if(state.phase==='finished'){
    assert.strictEqual(state.players.length,4);
    assert.strictEqual(state.spectatorCount,1);
    assert(sawFullHands,'spectator must receive all four complete hands during play');
    assert(state.players.every(p=>p.cpu));
    assert(state.players.every(p=>p.final&&Number.isFinite(p.final.total)));
    assert(state.players.every(p=>Array.isArray(p.playEvaluation)&&p.playEvaluation.length>=1&&p.playEvaluation.length<=3));
    assert(state.players.every(p=>p.matchStats&&Number.isFinite(p.matchStats.babaForcedCandidateCount)));
    done(null,{result:'passed',suite:'cpu4-spectator-v38-fullgame',players:4,spectators:1,sawMoveState,totals:state.players.map(p=>p.final.total)});
  }
}
function connect(){
  socket=new WebSocket(`ws://127.0.0.1:${port}`);
  socket.on('open',()=>send({
    type:'create',name:'CPU観戦ホスト',participantRole:'spectator',rounds:1,
    forceJokerPickCandidate:true,shootRequiresBabaMoved:true,pickTargetCount:1,
    madPigEnabled:true,shootThePigEnabled:true
  }));
  socket.on('message',raw=>{try{const message=JSON.parse(String(raw));if(message.type==='errorMsg')throw new Error(message.message);if(message.type==='state')act(message.state);}catch(error){done(error);}});
  socket.on('error',done);
}
child.stdout.on('data',d=>{if(String(d).includes('server listening')&&!socket)connect();});
