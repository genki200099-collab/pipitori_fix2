'use strict';

const assert=require('assert');
const path=require('path');
const {spawn}=require('child_process');
const WebSocket=require('ws');
const root=path.resolve(__dirname,'..');
const port=44000+(process.pid%9000);
const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','pipe']});
let socket=null,finished=false,started=false,lastCpuCount=-1;
let sawFullHands=false,sawPrimary=false,sawSecondary=false,sawRankings=false,sawConfirmedZero=false,sawShoot=false;
const shootEventIds=new Set(),errors=[];child.stderr.on('data',chunk=>errors.push(String(chunk)));
const deadline=setTimeout(()=>done(new Error('v39 featured CPU4 full-game timeout')),300000);
function send(payload){if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(payload));}
function cleanup(){clearTimeout(deadline);try{socket?.close();}catch{}try{child.kill('SIGKILL');}catch{}}
function done(error,result){if(finished)return;finished=true;cleanup();if(error){console.error(error.stack||error);if(errors.length)console.error(errors.join(''));process.exit(1);}console.log(JSON.stringify(result));process.exit(0);}
function act(state){
  assert.strictEqual(state.participantRole,'spectator');assert.strictEqual(state.yourIndex,-1);
  assert.strictEqual(state.enableMiddleRankPick,true);assert.strictEqual(state.shootLoadFireMode,true);
  assert.strictEqual(state.forceJokerPickCandidate,true);assert.strictEqual(state.shootRequiresBabaMoved,false);
  assert.strictEqual(state.playerSeatCount,state.players.length);
  if(state.phase==='lobby'){
    if(state.players.length<4){if(lastCpuCount!==state.players.length){lastCpuCount=state.players.length;send({type:'addCpu'});}return;}
    if(!started){started=true;send({type:'start'});}return;
  }
  if(state.players.length===4){
    sawFullHands=sawFullHands||state.players.every(player=>Array.isArray(player.hand));
    sawConfirmedZero=sawConfirmedZero||state.round===1&&state.completedRoundTotalScores.every(total=>total===0);
  }
  if(state.trickRankings?.length===4)sawRankings=true;
  if(state.pendingPick?.pickStage==='primary')sawPrimary=true;
  if(state.pendingPick?.pickStage==='secondary')sawSecondary=true;
  if(state.shootFireEvent){sawShoot=true;shootEventIds.add(state.shootFireEvent.id);assert(Number.isInteger(state.shootFireEvent.shooterPid));assert(Number.isInteger(state.shootFireEvent.targetPid));assert(state.shootFireEvent.babaCardId);assert(state.shootFireEvent.madCardId);}
  if(state.phase==='finished'){
    assert(sawFullHands,'spectator received all four hands');assert(sawPrimary,'primary pick occurred');
    assert(sawSecondary,'secondary pick occurred');assert(sawRankings,'one stable four-player ranking was public');
    assert(sawConfirmedZero,'R1 play exposed no provisional points as confirmed totals');
    assert.strictEqual(state.players.length,4);assert.strictEqual(state.spectatorCount,1);
    assert(state.players.every(player=>player.cpu&&player.final&&Number.isFinite(player.final.total)));
    assert(state.players.every(player=>Number.isFinite(player.completedRoundTotalScore)));
    assert(state.players.every(player=>player.completedRoundTotalScore===player.final.total),'confirmed totals match final totals');
    const stats=state.players.map(player=>player.matchStats);
    assert(stats.every(item=>item&&Number.isFinite(item.middlePickProviderCount)&&Number.isFinite(item.shootFiredCount)));
    assert(stats.reduce((sum,item)=>sum+item.middlePickProviderCount,0)>0);
    assert(stats.reduce((sum,item)=>sum+item.middlePickerCount,0)>0);
    assert.strictEqual(stats.reduce((sum,item)=>sum+item.middlePickTransferredCards,0),stats.reduce((sum,item)=>sum+item.middlePickReceivedCards,0));
    assert.strictEqual(stats.reduce((sum,item)=>sum+item.shootFiredCount,0),stats.reduce((sum,item)=>sum+item.shootReceivedBabaCount,0));
    done(null,{result:'passed',suite:'v39-cpu4-featured-fullgame',middlePick:true,sawShoot,shootEvents:shootEventIds.size,totals:state.players.map(player=>player.final.total)});
  }
}
function connect(){
  socket=new WebSocket(`ws://127.0.0.1:${port}`);
  socket.on('open',()=>send({
    type:'create',name:'v39観戦ホスト',participantRole:'spectator',rounds:1,
    enableMiddleRankPick:true,shootLoadFireMode:true,forceJokerPickCandidate:true,
    shootRequiresBabaMoved:true,pickTargetCount:2,madPigEnabled:true,shootThePigEnabled:true
  }));
  socket.on('message',raw=>{try{const message=JSON.parse(String(raw));if(message.type==='errorMsg')throw new Error(message.message);if(message.type==='state')act(message.state);}catch(error){done(error);}});
  socket.on('error',done);
}
child.stdout.on('data',chunk=>{if(String(chunk).includes('server listening')&&!socket)connect();});
