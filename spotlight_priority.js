'use strict';

const EVENT_WEIGHT = Object.freeze({
  shootSuccess:110, shootHit:104, resultJoker:101, babaReveal:96, madPig:92,
  resultPair:84, pairClean:80, trickWeak:72, trickWin:70, pickWin:58,
  endgame:56, pickWatch:32, watchDrama:30, normal:10
});

const ROLE_WEIGHT = Object.freeze({
  actor:34, winner:28, victim:32, weakest:30, affected:24,
  analyst:18, witness:8, observer:5
});

const CHARACTER_AFFINITY = Object.freeze({
  kamomodoki:{babaReveal:16,resultJoker:12,trickWeak:11,watchDrama:14,pickWatch:9,madPig:10},
  wakumodoki:{trickWin:16,pickWin:15,resultPair:18,pairClean:14,shootSuccess:18,endgame:12},
  rikumodoki:{resultJoker:17,babaReveal:14,madPig:18,pickWatch:15,watchDrama:13,trickWeak:10,endgame:16}
});

function recentPenalty(room, pid){
  const history=Array.isArray(room?.spotlightHistory) ? room.spotlightHistory : [];
  if(!history.length) return 0;
  let penalty=0;
  const recent=history.slice(0,5);
  if(recent[0]?.pid===pid) penalty+=32;
  if(recent[1]?.pid===pid) penalty+=14;
  if(recent[2]?.pid===pid) penalty+=7;
  const repeatCount=recent.filter(x=>x?.pid===pid).length;
  penalty+=Math.max(0,repeatCount-1)*6;
  if(recent[0]?.pid===pid && recent[1]?.pid===pid) penalty+=38;
  return penalty;
}

function underexposedBonus(room, pid){
  const counts=room?.spotlightRoundCounts || {};
  const cpuPids=(room?.players || []).map((p,i)=>p?.cpu ? i : -1).filter(i=>i>=0);
  if(!cpuPids.length) return 0;
  const values=cpuPids.map(i=>Number(counts[i] || 0));
  const min=Math.min(...values);
  const current=Number(counts[pid] || 0);
  return current===min ? 9 : Math.max(-8,(min-current)*4);
}

function scoreSpotlightCandidate(room, plan, random=Math.random){
  if(!plan || !Number.isInteger(plan.speakerPid) || !room?.players?.[plan.speakerPid]?.cpu) return -Infinity;
  const eventType=String(plan.eventType || 'normal');
  const role=String(plan.role || 'observer');
  const cpuKey=String(plan.cpuKey || '');
  let score=Number(plan.priority || 0);
  score+=Number(EVENT_WEIGHT[eventType] || EVENT_WEIGHT.normal)*0.48;
  score+=Number(ROLE_WEIGHT[role] || 0);
  score+=Number(plan.relevance || 0);
  score+=Number(plan.drama || 0);

  if(plan.speakerPid===plan.actorPid) score+=30;
  if(plan.speakerPid===plan.affectedPid) score+=27;
  if(plan.speakerPid===plan.targetPid) score+=14;

  score+=Number(CHARACTER_AFFINITY[cpuKey]?.[eventType] || 0);

  const speaker=room.players[plan.speakerPid];
  const remaining=Array.isArray(speaker?.hand) ? speaker.hand.length : 13;
  if(remaining<=3){
    score+=cpuKey==='rikumodoki' ? 11 : 5;
  }
  if((room.round || 1)>=(room.totalRounds || 3)){
    score+=cpuKey==='rikumodoki' ? 8 : 3;
  }

  score-=recentPenalty(room,plan.speakerPid);
  score+=underexposedBonus(room,plan.speakerPid);
  score+=(Number(random?.()) || 0)*4;
  return score;
}

function chooseSpotlightCandidate(room, plans, random=Math.random){
  const all=(Array.isArray(plans) ? plans : [plans]).filter(p=>p && p.text);
  if(!all.length) return null;
  // ババブタ取得・マッド取得・ペア浄化など、CPU本人にしか言えない場面は
  // 発言回数の均等化より当事者性を優先する。
  const mandatory=all.filter(plan=>plan.mustSpeak === true);
  const valid=mandatory.length ? mandatory : all;
  const scored=valid.map((plan,index)=>({plan,index,score:scoreSpotlightCandidate(room,plan,random)}))
    .filter(x=>Number.isFinite(x.score));
  if(!scored.length) return null;
  scored.sort((a,b)=>b.score-a.score || a.index-b.index);
  return Object.assign({},scored[0].plan,{selectionScore:Math.round(scored[0].score*10)/10});
}

module.exports={EVENT_WEIGHT,ROLE_WEIGHT,CHARACTER_AFFINITY,scoreSpotlightCandidate,chooseSpotlightCandidate};
