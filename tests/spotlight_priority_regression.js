'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const {scoreSpotlightCandidate,chooseSpotlightCandidate}=require('../spotlight_priority');

const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'public','index.html'),'utf8');
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');

const player=(name,key,cpu=true,handCount=8)=>({name,cpu,cpuKey:key,hand:Array.from({length:handCount},(_,i)=>({id:`${name}-${i}`}))});
const room={
  round:2,totalRounds:3,
  players:[player('かももどき','kamomodoki'),player('ワクもどき','wakumodoki'),player('リクもどき','rikumodoki'),player('ピピ',null,false)],
  spotlightHistory:[],spotlightRoundCounts:{}
};
const plan=(speakerPid,eventType,extra={})=>({
  speakerPid,eventType,cpuKey:room.players[speakerPid]?.cpuKey,text:`${eventType}-${speakerPid}`,
  priority:70,role:'witness',relevance:10,drama:5,...extra
});

// The CPU directly affected by a major event must beat spectators.
{
  const chosen=chooseSpotlightCandidate(room,[
    plan(0,'resultJoker',{role:'victim',actorPid:0,affectedPid:0,relevance:55,drama:44,priority:97}),
    plan(1,'babaReveal',{role:'witness',actorPid:0,affectedPid:0,targetPid:0,relevance:30,drama:40,priority:96}),
    plan(2,'babaReveal',{role:'analyst',actorPid:0,affectedPid:0,targetPid:0,relevance:30,drama:40,priority:96})
  ],()=>0);
  assert.strictEqual(chosen.speakerPid,0,'directly affected CPU should speak about its own Baba draw');
}

// When the affected player is human, Riku's analytical affinity should win over generic witnesses.
{
  const local={...room,players:[...room.players],spotlightHistory:[],spotlightRoundCounts:{}};
  const chosen=chooseSpotlightCandidate(local,[
    plan(0,'babaReveal',{role:'witness',actorPid:3,affectedPid:3,targetPid:3,relevance:20,drama:35,priority:80}),
    plan(1,'babaReveal',{role:'witness',actorPid:3,affectedPid:3,targetPid:3,relevance:20,drama:35,priority:80}),
    plan(2,'babaReveal',{role:'analyst',actorPid:3,affectedPid:3,targetPid:3,relevance:20,drama:35,priority:80})
  ],()=>0);
  assert.strictEqual(chosen.speakerPid,2,'Riku should lead public-risk analysis when the human is affected');
}

// Repeated speakers must yield to another relevant CPU unless they are overwhelmingly necessary.
{
  const local={...room,spotlightHistory:[{pid:0},{pid:0},{pid:2}],spotlightRoundCounts:{0:3,1:0,2:1}};
  const repeated=plan(0,'watchDrama',{role:'witness',priority:45,relevance:14});
  const fresh=plan(1,'watchDrama',{role:'witness',priority:43,relevance:14});
  assert(scoreSpotlightCandidate(local,repeated,()=>0)<scoreSpotlightCandidate(local,fresh,()=>0),'recent repetition penalty must be strong');
  assert.strictEqual(chooseSpotlightCandidate(local,[repeated,fresh],()=>0).speakerPid,1,'fresh speaker should be selected');
}

// Mandatory actors override fairness penalties for private-impact events.
{
  const local={...room,spotlightHistory:[{pid:0},{pid:0},{pid:0}],spotlightRoundCounts:{0:5,1:0,2:0}};
  const actor=plan(0,'resultJoker',{mustSpeak:true,role:'victim',actorPid:0,affectedPid:0,priority:70});
  const spectator=plan(2,'babaReveal',{role:'analyst',actorPid:0,affectedPid:0,targetPid:0,priority:120});
  assert.strictEqual(chooseSpotlightCandidate(local,[actor,spectator],()=>0).speakerPid,0);
}

// Non-CPU plans are never valid spotlight candidates.
{
  const local={...room};
  assert.strictEqual(chooseSpotlightCandidate(local,[{speakerPid:3,text:'human',eventType:'normal'}],()=>0),null);
}

assert.match(server,/pendingSpotlightPlans = spotlightPlansAfterTrick/,'trick candidates must be retained until pick completion');
assert.match(server,/spotlightTimingAfterPick/,'special pick overlays need coordinated spotlight timing');
assert.match(server,/spotlightHistory/,'speaker fairness history must be stored');
assert.match(html,/spotlight-scanlines/,'SFC scanlines must be present');
assert.match(html,/spotlight-typed-text/,'SFC typewriter text must be present');
assert.match(html,/@keyframes sfcWindowIn/,'SFC stepped window animation must be present');
assert.match(html,/image-rendering:pixelated/,'portraits and frames must preserve pixel art');
assert.match(html,/prefers-reduced-motion:reduce/,'reduced-motion support must remain');

console.log('spotlight priority + SFC regression: all assertions passed');
