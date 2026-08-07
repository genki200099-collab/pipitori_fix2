"""Efficient real-Chromium audit for v15 gameplay phases and responsive layouts."""
from __future__ import annotations
import json
import pathlib
from typing import Any
from playwright.sync_api import sync_playwright

ROOT=pathlib.Path(__file__).resolve().parents[1]
HTML=(ROOT/'public'/'index.html').read_text(encoding='utf-8')
CHROMIUM='/usr/bin/chromium'
VIEWPORTS=[
 ('portrait-320x568',320,568,True,True),
 ('portrait-393x852',393,852,True,True),
 ('landscape-568x320',568,320,True,True),
 ('landscape-844x390',844,390,True,True),
 ('desktop-768x600',768,600,False,False),
 ('desktop-1280x720',1280,720,False,False),
]
BASE=r'''() => {
 const suits=['apple','corn','cabbage','mud']; const cards=[];
 for(let i=0;i<13;i++){const suit=suits[i%4],rank=String(i+1);cards.push({id:'h'+i,suit,rank,val:i+1,joker:false});}
 const P=(id,name,cpu,key,img,count,hand=null)=>({id,name,cpu,cpuKey:key,cpuStyle:'',cpuTitle:'',avatar:'🐷',avatarImage:img,connected:true,handCount:count,hand,scorePileCount:4,pairsCount:1,shootUsed:false,out:false,final:null,lastComment:null});
 const players=[P('ME','ピピ',false,null,null,13,cards),P('C1','かももどき',true,'kamomodoki','cpu_characters/kamomodoki.jpg',10),P('C2','ワクもどき',true,'wakumodoki','cpu_characters/wakumodoki.jpg',11),P('C3','リクもどき',true,'rikumodoki','cpu_characters/rikumodoki.png',12)];
 state={code:'TEST',hostId:'ME',you:'ME',yourIndex:0,phase:'playing',round:2,totalRounds:3,roundDealMode:'reshuffle',madPigEnabled:true,jokerPenalty:20,jokerPenaltyTiming:'perRound',shootThePigEnabled:true,shootThePigLimit:'unlimited',shootThePigPerPlayerLimit:null,initialPairDiscardEnabled:false,passThreeEnabled:false,penaltyMode:'mud6',pickTargetCount:2,passDone:[],initialPairDone:[],roundStart:null,roundEndSummary:null,roundEndAutoContinueAt:null,lead:0,current:0,leadSuit:null,message:'光っているカードから1枚選んでください。',removedCard:null,trick:[],pendingPick:null,players,playableCardIds:cards.map(c=>c.id),isYourTurn:true,commentary:[{pid:3,cpuKey:'rikumodoki',avatarImage:'cpu_characters/rikumodoki.png',name:'リクもどき',text:'マストは失点が重いです。2💧を処理します。',mood:'analysis',intensity:'medium',eventKey:'play',icon:'📋',label:'計画手',expiresAt:Date.now()+100000},{pid:2,cpuKey:'wakumodoki',avatarImage:'cpu_characters/wakumodoki.jpg',name:'ワクもどき',text:'ババもマッドも逆転の材料にします。',mood:'hype',intensity:'strong',eventKey:'pick',icon:'✊',label:'PICK',expiresAt:Date.now()+100000}],lastTrick:null,trickReview:null,log:[]};
 resumeToken=''; return {cards,players};
}'''
MODS={
 'normal':"({cards})=>{}",
 'review':r'''({cards})=>{state.current=null;state.leadSuit='apple';state.trick=[0,1,2,3].map((pid,i)=>({pid,card:{...cards[i],suit:i<2?'apple':cards[i].suit},order:i}));state.trickReview={winnerPid:1,weakestPid:3,until:Date.now()+5000};state.lastTrick={winnerPid:1,weakestPid:3,winnerName:'かももどき',weakestName:'リクもどき',winnerCard:'2 🍎',weakestCard:'4 💧',expiresAt:Date.now()+10000};state.isYourTurn=false;state.playableCardIds=[];}''',
 'passing':r'''({cards})=>{state.phase='passing';state.passThreeEnabled=true;state.current=null;state.passDone=[];state.passTargetPid=1;state.passSourcePid=3;state.passableCardIds=cards.map(c=>c.id);state.playableCardIds=[];state.message='次の人へ渡すカードを3枚選んでください。';}''',
 'initialPair':r'''({cards})=>{cards[1]={...cards[1],rank:cards[0].rank,val:cards[0].val};state.players[0].hand=cards;state.phase='initialPair';state.initialPairDiscardEnabled=true;state.current=null;state.initialPairDone=[];state.initialPairCandidateIds=cards.map(c=>c.id);state.playableCardIds=[];state.message='同じ数字のペアを選ぶか、スキップしてください。';}''',
 'pickTarget':r'''({cards})=>{state.current=null;state.pendingPick={winnerPid:2,weakestPid:0,trickWinnerPid:2,trickWeakestPid:0,pickProviderPid:0,pickerPid:2,readyAt:Date.now()+999999,ready:false,readyInMs:999999,targetCount:2,targetSelectionRequired:true,targetSelectionDone:false,targetCandidateCount:2,targetSelectableCardIds:cards.map(c=>c.id),result:null,pairChoice:null};state.playableCardIds=[];}''',
 'pick':r'''({cards})=>{state.current=null;state.pendingPick={winnerPid:0,weakestPid:1,trickWinnerPid:0,trickWeakestPid:1,pickProviderPid:1,pickerPid:0,readyAt:Date.now()-1,ready:true,readyInMs:0,targetCount:2,targetSelectionRequired:true,targetSelectionDone:true,targetCandidateCount:2,targetSelectableCardIds:[],result:null,pairChoice:null};state.playableCardIds=[];}''',
 'pair':r'''({cards})=>{state.current=null;state.pendingPick={winnerPid:0,weakestPid:1,trickWinnerPid:0,trickWeakestPid:1,pickProviderPid:1,pickerPid:0,ready:true,readyInMs:0,targetCount:2,targetSelectionRequired:true,targetSelectionDone:true,targetCandidateCount:2,result:null,pairChoice:{drawn:{...cards[0],rank:'5',val:5,id:'drawn'},candidates:[{...cards[1],rank:'5',val:5,id:'pair1'},{...cards[2],rank:'5',val:5,id:'pair2'}]}};state.players[0].hand.push(state.pendingPick.pairChoice.drawn,...state.pendingPick.pairChoice.candidates);state.players[0].handCount=16;state.playableCardIds=[];}''',
 'roundEnd':r'''({players})=>{state.phase='roundEnd';state.current=null;state.playableCardIds=[];state.commentary=[];state.roundEndAutoContinueInMs=44000;state.roundEndSummary={round:2,reasonPid:0,reasonText:'ピピの手札がなくなりました。',roundDealMode:'reshuffle',madPigEnabled:true,shootThePigEnabled:true,shootPigResult:null,jokerPenaltyValue:20,jokerPenaltyTiming:'perRound',penaltyMode:'mud6',createdAt:Date.now(),rows:players.map((p,i)=>({pid:i,name:p.name,normalHand:8+i,hasJoker:false,pile:12-i,pairs:i%2,madPig:0,pileScore:12-i,handPenalty:i===0?0:24+i*3,madPigPenalty:0,jokerPenalty:0,jokerPenaltyTotal:0,pendingFinalJokerPenalty:0,shootThePig:false,shootUsed:false,shootPigMadPigWaived:false,shootPigPenalty:0,completedRoundCardScore:i*2,currentRoundCardScore:-12-i,total:i===0?3:-10-i*5}))};}''',
 'finished':r'''({players})=>{state.phase='finished';state.current=null;state.playableCardIds=[];state.commentary=[];state.finalRoundSummary={round:3,reasonText:'リクもどきの手札がなくなりました。'};state.players.forEach((p,i)=>p.final={pile:18-i,completedRoundCardScore:i,normalHand:5+i,handPenalty:i===0?0:15+i*3,madPig:i===1?1:0,madPigHand:0,madPigPile:i===1?1:0,madPigPenalty:i===0?0:(i===1?13:0),joker:0,jokerPenalty:0,shootPigPenalty:0,shootPigActivatedRounds:i===0?[2]:[],shootPigMadPigWaived:i===0,total:[3,3,-10,-18][i]});}'''
}
RESET=r'''() => {for(const n of ['__lastTableRenderKey','__lastRoundStatusKey','__lastHandRenderKey','__lastRoundModalKey','__lastScoreRenderKey','__lastLogRenderKey','__lastLastTrickKey','__lastMatchTrendKey','__lastCommentaryRenderKey','__lastPlayersRenderKey','__lastBasicStatusKey','__lastMessageText']){try{eval(n+'=""')}catch(e){}} applyDeviceUiMode();render();}'''
AUDIT=r'''(phase) => {
 const R=e=>{if(!e)return null;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {l:r.left,r:r.right,t:r.top,b:r.bottom,w:r.width,h:r.height,d:s.display,v:s.visibility};};
 const vis=e=>{const r=R(e);return !!r&&r.d!=='none'&&r.v!=='hidden'&&r.w>0&&r.h>0;};
 const vp=e=>{const r=R(e);return !!r&&r.l>=-1&&r.r<=innerWidth+1&&r.t>=-1&&r.b<=innerHeight+1;};
 const q=s=>document.querySelector(s); const qa=s=>[...document.querySelectorAll(s)];
 const checks={noHorizontalOverflow:document.documentElement.scrollWidth<=innerWidth+1,gameVisible:vis(q('#gameScreen'))};
 if(phase==='normal'){
   const cards=qa('#hand .hand-card .playing-card').filter(vis);
   checks.handCardsVisible=cards.length===13;
   checks.handCardsInside=cards.every(c=>{const r=R(c);return r.b<=innerHeight+1;}); checks.handBounds=cards.map(R);
   checks.commentary=qa('#tableCommentary .speech-bubble').filter(vis).length>0;
 }
 if(phase==='review') checks.resultBanner=vis(q('.review-result-v11'));
 if(phase==='passing'){checks.submit=vp(q('[data-pass-submit]'));checks.hand=vp(q('#hand'));}
 if(phase==='initialPair'){checks.skip=vp(q('[data-initial-skip]'));checks.hand=vp(q('#hand'));}
 if(phase==='pickTarget'){checks.submit=vis(q('[data-pick-target-submit]'));checks.cards=qa('.pick-target-card').some(vis);}
 if(phase==='pick') checks.pick=qa('.pick-card').some(vis);
 if(phase==='pair'){checks.skip=vis(q('[data-pair-skip]'));checks.pairs=qa('.pair-card-btn').every(vis);}
 if(phase==='roundEnd'){
   const text=q('.round-panel')?.textContent||'';
   checks.panel=vis(q('.round-panel')); checks.continue=vp(q('[data-continue-round]'));
   checks.noNegativeZero=!/(^|[^0-9])-0([^0-9]|$)/.test(text); checks.cumulativeLabel=text.includes('累計暫定得点');
 }
 if(phase==='finished'){
   const text=q('#score')?.textContent||'';
   checks.score=vis(q('.score-screen')); checks.noNegativeZero=!/(^|[^0-9])-0([^0-9]|$)/.test(text);checks.tie=text.includes('同率1位');
 }
 return {checks,viewport:[innerWidth,innerHeight],phase};
}'''

def main():
 failures=[]; cases=0
 with sync_playwright() as p:
  browser=p.chromium.launch(headless=True,executable_path=CHROMIUM,args=['--no-sandbox','--disable-dev-shm-usage'])
  for label,w,h,mobile,touch in VIEWPORTS:
   page=browser.new_page(viewport={'width':w,'height':h},is_mobile=mobile,has_touch=touch)
   errors=[]; page.on('pageerror',lambda e,errors=errors: errors.append(str(e)))
   page.set_content(HTML,wait_until='load')
   for phase,mod in MODS.items():
    errors.clear(); ctx=page.evaluate(BASE); page.evaluate(mod,ctx); page.evaluate(RESET); page.wait_for_timeout(80)
    result=page.evaluate(AUDIT,phase); cases+=1
    failed=[k for k,v in result['checks'].items() if not v]
    if errors or failed: failures.append({'viewport':label,'phase':phase,'errors':list(errors),'failed':failed,'result':result})
   page.close()
  browser.close()
 report={'result':'passed' if not failures else 'failed','cases':cases,'viewports':[v[0] for v in VIEWPORTS],'phases':list(MODS),'failures':failures}
 (ROOT/'BROWSER_FULL_RESPONSIVE_AUDIT_V15_RESULT.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
 print(json.dumps(report,ensure_ascii=False))
 if failures: raise SystemExit(1)

if __name__=='__main__': main()
