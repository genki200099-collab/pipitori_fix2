'use strict';

const assert=require('assert');
const crypto=require('crypto');
const fs=require('fs');
const path=require('path');
const vm=require('vm');
const root=path.resolve(__dirname,'..');
const serverSource=fs.readFileSync(path.join(root,'server.js'),'utf8');
const html=fs.readFileSync(path.join(root,'public/index.html'),'utf8');

class FakeWSS{on(){}}
const sandbox={console,Buffer,process:{env:{}},__dirname:root,setTimeout(){return{unref(){}}},clearTimeout(){},setInterval(){return{unref(){}}},clearInterval(){},require(name){if(name==='http')return{createServer:()=>({listen(){}})};if(name==='ws')return{Server:FakeWSS,OPEN:1};if(name==='crypto')return crypto;if(name==='fs')return fs;if(name==='path')return path;if(name==='./cpu_personality_dialogue')return require(path.join(root,'cpu_personality_dialogue.js'));if(name==='./spotlight_priority')return require(path.join(root,'spotlight_priority.js'));throw new Error(name);}};sandbox.globalThis=sandbox;
vm.runInNewContext(`${serverSource}\n;globalThis.__v37={newMatchStats,matchStatsFor,generatePlayEvaluation,score,publicState,playCard,advanceReviewToPick,commentPresentation,HUMAN_ANIMAL_IDENTITIES,MAX_SPECTATORS_PER_ROOM,rooms,createRoom,joinRoom,addCpu,startGame};`,sandbox,{filename:'server.js'});
const api=sandbox.__v37;
function card(suit,rank,id){return{id,faceKey:`${suit}:${rank}`,suit,rank:String(rank),val:Number(rank),joker:false};}
function ws(){return{readyState:1,send(){}};}
function player(i,cpu=false){return{id:`P${i}`,name:cpu?['かももどき','ワクもどき','リクもどき'][i-1]:`Human${i}`,avatar:cpu?'🦆':'🐷',cpu,participantRole:'player',ws:cpu?null:ws(),hand:[card('apple',i+1,`h${i}`)],scorePile:[],pairs:[],completedRoundCardScoreBank:0,jokerPenaltyBank:0,shootPigPenaltyBank:0,shootPigActivatedRounds:[],out:false,matchStats:api.newMatchStats()};}

const players=[player(0),player(1,true),player(2,true),player(3,true)];
players[0].scorePile=[card('corn',4,'f1'),card('cabbage',7,'f2')];
Object.assign(players[0].matchStats,{trickWins:2,feastCardsWon:8,feastPointsWon:16,pairCleans:1,pairDangerCards:1,shootCount:0,remainingHandCount:1,remainingHandPenalty:3});
Object.assign(players[1].matchStats,{trickWins:0,weakestCount:3,pickerCount:3,pairCleans:0,shootCount:0,remainingHandCount:1,remainingHandPenalty:3});
Object.assign(players[2].matchStats,{trickWins:2,feastCardsWon:8,feastPointsWon:16,highCardWins:2});
Object.assign(players[3].matchStats,{trickWins:2,feastCardsWon:8,feastPointsWon:16,efficientLowWins:2,pairCleans:2});
const room={code:'STAT',hostId:'P0',players,spectators:[],phase:'finished',round:1,totalRounds:1,feastPointPerCard:2,roundDealMode:'carryOver',penaltyMode:'flat3',madPigEnabled:false,shootThePigEnabled:false,shootThePigLimit:'unlimited',jokerPenalty:20,jokerPenaltyTiming:'perRound',shootPigRoundResults:{},log:[],commentary:[],lead:0,current:null,trick:[]};
api.score(room);
assert(players.every(p=>Array.isArray(p.playEvaluation)&&p.playEvaluation.length>=1&&p.playEvaluation.length<=3));
assert(players[0].playEvaluation.some(text=>/トリック勝利2回/.test(text)));
assert(players[0].playEvaluation.some(text=>/ペア浄化を1回/.test(text)));
assert(!players[0].playEvaluation.some(text=>/シュート・ザ・ピッグ/.test(text)),'shoot must not be fabricated');
assert(!players[1].playEvaluation.some(text=>/ペア浄化を.*成功/.test(text)),'zero pair cleans must not be praised');
assert(players[0].final.pileScore===players[0].scorePile.length*2);
assert(players.every(p=>p.playEvaluation.every(text=>[...text].length<=92)));
const criticalComment=api.commentPresentation('ババブタを引いた！これは大事件です。',{eventKey:'baba',durationMs:14500});
assert(criticalComment.durationMs>=4700&&criticalComment.durationMs<=6500,'important CPU comments are readable without lingering for 10+ seconds');

const spectator={id:'S1',name:'Watcher',avatar:'🐱',participantRole:'spectator',ws:ws(),resumeToken:'token'};room.spectators.push(spectator);
const playerState=api.publicState(room,'P0');
const spectatorState=api.publicState(room,'S1');
assert(playerState.players.every((p,i)=>i===0?Array.isArray(p.hand):p.hand===null));
assert(spectatorState.players.every(p=>Array.isArray(p.hand)));
assert(spectatorState.players.every(p=>Array.isArray(p.playEvaluation)&&p.playEvaluation.length));

const playRoom={...room,phase:'playing',players:[player(0),player(1),player(2),player(3)],spectators:[],round:1,lead:0,current:0,leadSuit:null,trick:[],pendingPick:null,trickReview:null,transientTimers:new Map(),message:'',log:[],commentary:[]};
const playedId=playRoom.players[0].hand[0].id;
api.playCard(playRoom,'P0',playedId);
assert(playRoom.cardPlayEvent?.eventId?.startsWith('play-'));
assert.strictEqual(playRoom.cardPlayEvent.card.id,playedId);

function pickRoleStats(providerRole){
  const rolePlayers=[player(0),player(1),player(2),player(3)];
  const pickRoom={...playRoom,players:rolePlayers,pickProviderRole:providerRole,pickTargetCount:0,trickReview:{until:42},pendingPick:null,trick:[],leadSuit:null,current:0,transientTimers:new Map(),commentary:[],log:[]};
  api.advanceReviewToPick(pickRoom,42,0,1);
  return rolePlayers.map(p=>p.matchStats);
}
const winnerProviderStats=pickRoleStats('winner');
assert.strictEqual(winnerProviderStats[0].pickProviderCount,1);
assert.strictEqual(winnerProviderStats[1].pickerCount,1);
const weakestProviderStats=pickRoleStats('weakest');
assert.strictEqual(weakestProviderStats[1].pickProviderCount,1);
assert.strictEqual(weakestProviderStats[0].pickerCount,1);

assert.match(html,/--final-action-dock-height/);
assert.match(html,/body\.finished-mode \.final-actions\{position:fixed!important/);
assert.match(html,/padding-bottom:calc\(var\(--final-action-dock-height\)/);
assert.match(html,/id="spectatorView"/);
assert.match(html,/function renderSpectatorView\(/);
assert.match(html,/function processStateAnimations\(/);
assert.match(html,/__seenAnimationEventIds/);
assert.match(html,/pointer-events:none/);
assert.match(html,/@media\(prefers-reduced-motion:reduce\)[\s\S]*\.card-flight/);
assert.match(html,/class="play-evaluation"/);

function identitySocket(){return{readyState:1,roomCode:null,playerId:null,sent:[],send(raw){this.sent.push(JSON.parse(raw));}};}
const identitySockets=[identitySocket()];api.createRoom(identitySockets[0],'');
const identityRoom=[...api.rooms.values()].at(-1);
for(let i=1;i<4;i++){const socket=identitySocket();identitySockets.push(socket);api.joinRoom(socket,identityRoom.code,'',null,null,'player');}
for(let i=0;i<api.MAX_SPECTATORS_PER_ROOM;i++){const socket=identitySocket();identitySockets.push(socket);api.joinRoom(socket,identityRoom.code,'',null,null,'spectator');}
const allHumans=[...identityRoom.players,...identityRoom.spectators];
assert.strictEqual(identityRoom.players.length,4);
assert.strictEqual(identityRoom.spectators.length,api.MAX_SPECTATORS_PER_ROOM);
assert.strictEqual(new Set(identityRoom.players.map(p=>p.avatar)).size,4,'player avatars stay unique even with spectators');
assert.strictEqual(new Set(allHumans.map(p=>p.name)).size,allHumans.length);
assert.strictEqual(new Set(allHumans.map(p=>p.avatar)).size,allHumans.length);
const overLimit=identitySocket();api.joinRoom(overLimit,identityRoom.code,'Over',null,null,'spectator');
assert.match(overLimit.sent.at(-1).message,/最大/);

const spectatorHostSocket=identitySocket();
api.createRoom(spectatorHostSocket,'',3,true,-20,false,false,'mud6',2,'perRound',true,'reshuffle','unlimited',1,'winner','spectator');
const spectatorFirstRoom=[...api.rooms.values()].at(-1);
const originalSpectatorAvatar=spectatorFirstRoom.spectators[0].avatar;
for(let i=0;i<4;i++) api.joinRoom(identitySocket(),spectatorFirstRoom.code,'',null,null,'player');
assert.strictEqual(spectatorFirstRoom.spectators[0].avatar,originalSpectatorAvatar,'later player joins must not reassign an existing spectator avatar');
assert.strictEqual(new Set([...spectatorFirstRoom.players,...spectatorFirstRoom.spectators].map(p=>p.avatar)).size,5);

const cpuOnlyHost=identitySocket();
api.createRoom(cpuOnlyHost,'CPU観戦ホスト',1,true,-20,false,false,'mud6',2,'perRound',true,'reshuffle','unlimited',1,'winner','spectator');
const cpuOnlyRoom=[...api.rooms.values()].at(-1);
for(let i=0;i<4;i++) api.addCpu(cpuOnlyRoom,cpuOnlyRoom.hostId);
assert.strictEqual(api.startGame(cpuOnlyRoom,cpuOnlyRoom.hostId),true);
assert.strictEqual(cpuOnlyRoom.cleanupTimer,null,'active CPU-only game must not retain the lobby cleanup timer');
api.joinRoom(identitySocket(),cpuOnlyRoom.code,'途中観戦',null,null,'spectator');
assert.strictEqual(cpuOnlyRoom.cleanupTimer,null,'midgame spectator join must not start an empty-room timer for an active CPU game');

console.log(JSON.stringify({result:'passed',suite:'result-evaluation-animation-v37',evaluations:players.map(p=>p.playEvaluation.length),privacy:'passed'}));
