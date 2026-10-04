'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm'),crypto=require('crypto');
module.exports=function(seed=46){
 const root=path.resolve(__dirname,'..');let value=seed>>>0;
 const random=()=>{value=(Math.imul(value,1664525)+1013904223)>>>0;return value/4294967296;};
 const math=Object.create(Math);math.random=random;
 const timer=()=>({unref(){}});
 class FakeServer{constructor(){this.clients=new Set();}on(){}}
 const sandbox={console:{log(){},error:console.error},Math:math,process:{env:{}},__dirname:root,setTimeout:timer,clearTimeout(){},setInterval:timer,clearInterval(){},require(name){
 if(name==='http')return {createServer:()=>({listen(){}})};
 if(name==='ws')return{Server:FakeServer,OPEN:1};
 if(name==='crypto')return crypto;
 if(name==='fs')return fs;
 if(name==='path')return path;
 if(name.startsWith('./'))return require(path.join(root,name));
 throw Error('Unexpected module '+name);
 }};
 const source=fs.readFileSync(process.env.V46_SERVER_SOURCE || path.join(root,'server.js'),'utf8');
 vm.runInNewContext(source+`\nglobalThis.api={rooms,createRoom,addCpu,startGame,playCard,advanceReviewToPick,doPick,submitPickTargets,resolvePairChoice,beginNextRound,ensureRoomProgress,playableIds,clearAllProgressTimers,submitPassThree,skipInitialPairs,activePickLanes,finishPickLane,resolveShootDecision,finishShootPresentation,rankTrickPlayers,roomSeatCapacity,roomHandSize,secondaryPickRanks,publicState,buildPostTrickFlow,cpuCardPlayScore,makeRoundSnapshot,checkRoundEnd};`,sandbox,{filename:'server.js'});
 return sandbox.api;
};
