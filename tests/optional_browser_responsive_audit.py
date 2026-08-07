"""Optional real-Chromium responsive audit.

Requires Python Playwright and a local Chromium executable. It does not run in
`npm test`, so Render deployment remains dependency-free. Run from repository:
  python tests/optional_browser_responsive_audit.py
"""
from __future__ import annotations

import json
import pathlib
from typing import Any

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
HTML = (ROOT / "public" / "index.html").read_text(encoding="utf-8")
CHROMIUM = "/usr/bin/chromium"

BASE = r'''() => {
 const suits=['apple','corn','cabbage','mud']; let cards=[];
 for(let i=0;i<13;i++){const suit=suits[i%4];const rank=String((i%13)+1);cards.push({id:'h'+i,suit,rank,val:Number(rank),joker:false});}
 const P=(id,name,cpu,key,img,count,hand=null)=>({id,name,cpu,cpuKey:key,cpuStyle:'',cpuTitle:'',avatar:'🐷',avatarImage:img,connected:true,handCount:count,hand,scorePileCount:4,pairsCount:1,shootUsed:false,out:false,final:null,lastComment:null});
 const players=[P('ME','ピピ',false,null,null,13,cards),P('C1','かももどき',true,'kamomodoki','cpu_characters/kamomodoki.jpg',10),P('C2','ワクもどき',true,'wakumodoki','cpu_characters/wakumodoki.jpg',11),P('C3','リクもどき',true,'rikumodoki','cpu_characters/rikumodoki.png',12)];
 state={code:'TEST',hostId:'ME',you:'ME',yourIndex:0,phase:'playing',round:2,totalRounds:3,madPigEnabled:true,jokerPenalty:20,jokerPenaltyTiming:'perRound',shootThePigEnabled:true,shootThePigLimit:'unlimited',shootThePigPerPlayerLimit:null,initialPairDiscardEnabled:false,passThreeEnabled:false,penaltyMode:'mud6',pickTargetCount:2,passDone:[],initialPairDone:[],roundStart:null,roundEndSummary:null,roundEndAutoContinueAt:null,lead:0,current:0,leadSuit:null,message:'光っているカードから1枚選んでください。',removedCard:null,trick:[],pendingPick:null,players,playableCardIds:cards.map(c=>c.id),isYourTurn:true,commentary:[{pid:2,cpuKey:'wakumodoki',avatarImage:'cpu_characters/wakumodoki.jpg',name:'ワクもどき',text:'ババもマッドも、逆転の材料にしてやるぞぉ〜✊🏻 まだまだ勝負はここから！',mood:'hype',intensity:'strong',eventKey:'round',icon:'✊',label:'HYPE',expiresAt:Date.now()+100000},{pid:1,cpuKey:'kamomodoki',avatarImage:'cpu_characters/kamomodoki.jpg',name:'かももどき',text:'マストフォローは祝福です♡ 人の不幸は蜜の味♡',mood:'scheme',intensity:'medium',eventKey:'play',icon:'♡',label:'COMMENT',expiresAt:Date.now()+100000}],lastTrick:null,trickReview:null,log:[]};
 resumeToken=''; return {cards,players};
}'''

MODS = {
 "normal": "({cards})=>{}",
 "review": r'''({cards})=>{state.current=null;state.leadSuit='apple';state.trick=[0,1,2,3].map((pid,i)=>({pid,card:{...cards[i],suit:i<2?'apple':cards[i].suit},order:i}));state.trickReview={winnerPid:1,weakestPid:3,until:Date.now()+5000};state.lastTrick={winnerPid:1,weakestPid:3,winnerName:'かももどき',weakestName:'リクもどき',winnerCard:'2 🍎 リンゴ',weakestCard:'4 💧',expiresAt:Date.now()+10000};state.isYourTurn=false;state.playableCardIds=[];}''',
 "passing": r'''({cards})=>{state.phase='passing';state.passThreeEnabled=true;state.current=null;state.isYourTurn=false;state.passDone=[];state.passTargetPid=1;state.passSourcePid=3;state.passableCardIds=cards.map(c=>c.id);state.playableCardIds=[];state.message='次の人へ渡すカードを3枚選んでください。';}''',
 "initialPair": r'''({cards})=>{cards[1]={...cards[1],rank:cards[0].rank,val:cards[0].val};state.players[0].hand=cards;state.phase='initialPair';state.initialPairDiscardEnabled=true;state.current=null;state.isYourTurn=false;state.initialPairDone=[];state.initialPairCandidateIds=cards.map(c=>c.id);state.playableCardIds=[];state.message='同じ数字のペアを選ぶか、スキップしてください。';}''',
 "pickTarget": r'''({cards})=>{state.current=null;state.pendingPick={winnerPid:2,weakestPid:0,trickWinnerPid:2,trickWeakestPid:0,pickProviderPid:0,pickerPid:2,readyAt:Date.now()+999999,ready:false,readyInMs:999999,targetCount:2,targetSelectionRequired:true,targetSelectionDone:false,targetCandidateCount:2,targetSelectableCardIds:cards.map(c=>c.id),result:null,pairChoice:null};state.isYourTurn=false;state.playableCardIds=[];}''',
 "pick": r'''({cards})=>{state.current=null;state.pendingPick={winnerPid:0,weakestPid:1,trickWinnerPid:0,trickWeakestPid:1,pickProviderPid:1,pickerPid:0,readyAt:Date.now()-1000,ready:true,readyInMs:0,targetCount:2,targetSelectionRequired:true,targetSelectionDone:true,targetCandidateCount:2,targetSelectableCardIds:[],result:null,pairChoice:null};state.isYourTurn=false;state.playableCardIds=[];}''',
 "pair": r'''({cards})=>{state.current=null;state.pendingPick={winnerPid:0,weakestPid:1,trickWinnerPid:0,trickWeakestPid:1,pickProviderPid:1,pickerPid:0,readyAt:Date.now()-1000,ready:true,readyInMs:0,targetCount:2,targetSelectionRequired:true,targetSelectionDone:true,targetCandidateCount:2,result:null,pairChoice:{drawn:{...cards[0],rank:'5',val:5,id:'drawn'},candidates:[{...cards[1],rank:'5',val:5,id:'pair1'},{...cards[2],rank:'5',val:5,id:'pair2'}]}};state.players[0].hand.push(state.pendingPick.pairChoice.drawn,...state.pendingPick.pairChoice.candidates);state.players[0].handCount=16;state.isYourTurn=false;state.playableCardIds=[];}''',
 "roundEnd": r'''({cards})=>{state.phase='roundEnd';state.current=null;state.isYourTurn=false;state.playableCardIds=[];state.commentary=[];state.roundEndAutoContinueInMs=44000;state.roundEndClientAutoContinueAt=Date.now()+44000;state.roundEndSummary={round:2,reasonPid:0,reasonText:'ピピの手札がなくなりました。',madPigEnabled:true,shootThePigEnabled:true,shootPigResult:null,jokerPenaltyValue:20,jokerPenaltyTiming:'perRound',penaltyMode:'mud6',createdAt:Date.now(),rows:state.players.map((p,i)=>({pid:i,name:p.name,normalHand:8+i,hasJoker:i===2,pile:12-i,pairs:i%2,madPig:i===1?1:0,pileScore:12-i,handPenalty:24+i*3,madPigPenalty:i===1?13:0,jokerPenalty:i===2?20:0,jokerPenaltyTotal:i===2?40:0,pendingFinalJokerPenalty:0,shootThePig:false,shootUsed:false,shootPigMadPigWaived:false,shootPigPenalty:0,total:i===0?3:-10-i*5}))};}''',
 "finished": r'''({cards})=>{state.phase='finished';state.current=null;state.isYourTurn=false;state.playableCardIds=[];state.commentary=[];state.finalRoundSummary={round:3,reasonText:'リクもどきの手札がなくなりました。'};state.players.forEach((p,i)=>p.final={pile:18-i,normalHand:5+i,handPenalty:15+i*3,madPig:i===1?1:0,madPigHand:0,madPigPile:i===1?1:0,madPigPenalty:i===1?13:0,joker:i===2?1:0,jokerPenalty:i===2?60:0,shootPigPenalty:i===3?10:0,shootPigActivatedRounds:i===0?[2]:[],shootPigMadPigWaived:i===0,total:[3,3,-40,-18][i]});}''',
}

VIEWPORTS = [
 ("portrait-320x568",320,568), ("portrait-360x600",360,600),
 ("portrait-390x640",390,640), ("portrait-393x852",393,852),
 ("portrait-430x800",430,800), ("landscape-568x320",568,320),
 ("landscape-640x360",640,360), ("landscape-667x375",667,375),
 ("landscape-844x390",844,390), ("landscape-932x430",932,430),
 ("desktop-768x600",768,600), ("desktop-1024x600",1024,600),
 ("desktop-1280x720",1280,720), ("desktop-1440x900",1440,900),
]

JS_AUDIT = r'''(phase) => {
 const rect=e=>{if(!e)return null;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height,display:s.display,visibility:s.visibility,opacity:Number(s.opacity),scrollWidth:e.scrollWidth,clientWidth:e.clientWidth,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight};};
 const visible=e=>{const r=rect(e);return !!r&&r.display!=='none'&&r.visibility!=='hidden'&&r.width>0&&r.height>0;};
 const withinViewport=e=>{const r=rect(e);return !!r&&r.left>=-1&&r.right<=innerWidth+1&&r.top>=-1&&r.bottom<=innerHeight+1;};
 const within=e=>{const r=rect(e),t=rect(document.querySelector('#table'));return !!r&&!!t&&r.left>=t.left-1&&r.right<=t.right+1&&r.top>=t.top-1&&r.bottom<=t.bottom+1;};
 const result={phase,viewport:[innerWidth,innerHeight],docWidth:[document.documentElement.scrollWidth,document.documentElement.clientWidth],checks:{}};
 result.checks.noHorizontalPageOverflow=document.documentElement.scrollWidth<=innerWidth+1;
 result.checks.gameVisible=visible(document.querySelector('#gameScreen'));
 if(phase==='normal'){
   result.checks.tableVisible=visible(document.querySelector('#table'));
   result.checks.handVisible=visible(document.querySelector('.hand-dock'));
   result.checks.commentRows=document.querySelectorAll('#tableCommentary .speech-bubble').length===2;
 }
 if(phase==='review'){
   const banner=document.querySelector('.review-result-v11'), hand=document.querySelector('.hand-dock');
   const br=rect(banner), hr=rect(hand);
   result.checks.reviewBanner=withinViewport(banner)&&!!br&&!!hr&&br.bottom<=hr.top+1;
 }
 if(phase==='passing'){
   result.checks.setupClass=document.querySelector('#gameScreen').classList.contains('is-setup-mode');
   result.checks.passButton=withinViewport(document.querySelector('[data-pass-submit]'));
   result.checks.handRail=withinViewport(document.querySelector('#hand'))&&rect(document.querySelector('#hand')).height>=45;
   result.checks.pointer=getComputedStyle(document.querySelector('#handNote')).pointerEvents!=='none';
 }
 if(phase==='initialPair'){
   result.checks.setupClass=document.querySelector('#gameScreen').classList.contains('is-setup-mode');
   result.checks.skipButton=withinViewport(document.querySelector('[data-initial-skip]'));
   result.checks.handRail=withinViewport(document.querySelector('#hand'))&&rect(document.querySelector('#hand')).height>=45;
 }
 if(phase==='pickTarget'){
   result.checks.submit=within(document.querySelector('[data-pick-target-submit]'));
   result.checks.rail=within(document.querySelector('.pick-target-cards'))&&rect(document.querySelector('.pick-target-cards')).height>=40;
   result.checks.firstCard=visible(document.querySelector('.pick-target-card'));
 }
 if(phase==='pick') result.checks.pickCard=within(document.querySelector('.pick-card'));
 if(phase==='pair'){
   result.checks.drawn=within(document.querySelector('.pick-drawn-card'));
   result.checks.candidates=[...document.querySelectorAll('.pair-card-btn')].every(within);
   result.checks.skip=within(document.querySelector('[data-pair-skip]'));
 }
 if(phase==='roundEnd'){
   result.checks.panelWidth=rect(document.querySelector('.round-panel')).right<=innerWidth+1&&rect(document.querySelector('.round-panel')).left>=-1;
   result.checks.continue=withinViewport(document.querySelector('[data-continue-round]'));
   result.checks.scoreText=visible(document.querySelector('.round-card .stat b'))&&visible(document.querySelector('.round-total'));
 }
 if(phase==='finished'){
   result.checks.scoreVisible=visible(document.querySelector('.score-screen'));
   const hype=document.querySelector('.hype-toast');result.checks.noHypeOverlap=!hype||getComputedStyle(hype).display==='none';
 }
 result.rects={table:rect(document.querySelector('#table')),hand:rect(document.querySelector('.hand-dock')),pick:rect(document.querySelector('.pick-stage')),round:rect(document.querySelector('.round-panel'))};
 return result;
}'''


def main() -> None:
    results: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=CHROMIUM, args=["--no-sandbox"])
        for phase, mod in MODS.items():
            for label, width, height in VIEWPORTS:
                page = browser.new_page(viewport={"width": width, "height": height}, is_mobile=label.startswith(("portrait", "landscape")), has_touch=label.startswith(("portrait", "landscape")))
                errors: list[str] = []
                page.on("pageerror", lambda exc, errors=errors: errors.append(str(exc)))
                page.set_content(HTML)
                context = page.evaluate(BASE)
                page.evaluate(mod, context)
                page.evaluate("() => { applyDeviceUiMode(); render(); }")
                page.wait_for_timeout(200)
                result = page.evaluate(JS_AUDIT, phase)
                result.update({"viewportLabel": label, "errors": errors})
                failed = [name for name, passed in result["checks"].items() if not passed]
                if errors or failed:
                    failures.append({"phase": phase, "viewport": label, "errors": errors, "failed": failed, "result": result})
                results.append(result)
                page.close()
        browser.close()
    report = {"result": "passed" if not failures else "failed", "cases": len(results), "viewports": len(VIEWPORTS), "phases": list(MODS), "failures": failures}
    print(json.dumps(report, ensure_ascii=False))
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
