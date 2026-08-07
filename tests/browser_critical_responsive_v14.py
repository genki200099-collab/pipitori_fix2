"""Targeted real-Chromium audit for v14 critical UI changes.

Checks the new round-deal selector, PC commentary clipping, phone commentary rails,
and round-result scoring at representative portrait, landscape, and desktop sizes.
This is optional and is not part of npm test.
"""
from __future__ import annotations

import json
import pathlib
from typing import Any

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
HTML = (ROOT / "public" / "index.html").read_text(encoding="utf-8")
CHROMIUM = "/usr/bin/chromium"

VIEWPORTS = [
    ("portrait-320x568", 320, 568, True, True),
    ("portrait-393x852", 393, 852, True, True),
    ("landscape-568x320", 568, 320, True, True),
    ("landscape-844x390", 844, 390, True, True),
    ("desktop-768x600", 768, 600, False, False),
    ("desktop-1280x720", 1280, 720, False, False),
]

BASE_STATE = r'''() => {
 const suits=['apple','corn','cabbage','mud'];
 const cards=[];
 for(let i=0;i<13;i++){
   const suit=suits[i%4], rank=String((i%13)+1);
   cards.push({id:'h'+i,suit,rank,val:Number(rank),joker:false});
 }
 const player=(id,name,cpu,key,img,count,hand=null)=>({
   id,name,cpu,cpuKey:key,cpuStyle:'',cpuTitle:'',avatar:'🐷',avatarImage:img,
   connected:true,handCount:count,hand,scorePileCount:4,pairsCount:1,
   shootUsed:false,out:false,final:null,lastComment:null
 });
 const players=[
   player('ME','ピピ',false,null,null,13,cards),
   player('C1','かももどき',true,'kamomodoki','cpu_characters/kamomodoki.jpg',10),
   player('C2','ワクもどき',true,'wakumodoki','cpu_characters/wakumodoki.jpg',11),
   player('C3','リクもどき',true,'rikumodoki','cpu_characters/rikumodoki.png',12)
 ];
 state={
   code:'TEST',hostId:'ME',you:'ME',yourIndex:0,phase:'playing',round:2,totalRounds:3,
   roundDealMode:'reshuffle',madPigEnabled:true,jokerPenalty:20,jokerPenaltyTiming:'perRound',
   shootThePigEnabled:true,shootThePigLimit:'unlimited',shootThePigPerPlayerLimit:null,initialPairDiscardEnabled:false,
   passThreeEnabled:false,penaltyMode:'mud6',pickTargetCount:2,passDone:[],initialPairDone:[],
   roundStart:null,roundEndSummary:null,roundEndAutoContinueAt:null,lead:0,current:0,leadSuit:null,
   message:'光っているカードから1枚選んでください。',removedCard:null,trick:[],pendingPick:null,
   players,playableCardIds:cards.map(c=>c.id),isYourTurn:true,
   commentary:[
     {pid:3,cpuKey:'rikumodoki',avatarImage:'cpu_characters/rikumodoki.png',name:'リクもどき',text:'マストは失点が重いです。2💧を処理します。',mood:'analysis',intensity:'medium',eventKey:'play',icon:'📋',label:'計画手',expiresAt:Date.now()+100000},
     {pid:3,cpuKey:'rikumodoki',avatarImage:'cpu_characters/rikumodoki.png',name:'リクもどき',text:'とりあえず手札に入れておきます。',mood:'analysis',intensity:'medium',eventKey:'pick',icon:'🐽',label:'PICK',expiresAt:Date.now()+100000}
   ],
   lastTrick:null,trickReview:null,log:[]
 };
 resumeToken='';
 return {cards,players};
}'''

ROUND_END = r'''({players}) => {
 state.phase='roundEnd'; state.current=null; state.isYourTurn=false; state.playableCardIds=[];
 state.commentary=[]; state.roundEndAutoContinueInMs=44000;
 state.roundEndSummary={
   round:2,reasonPid:0,reasonText:'ピピの手札がなくなりました。',roundDealMode:'reshuffle',
   madPigEnabled:true,shootThePigEnabled:true,shootPigResult:null,jokerPenaltyValue:20,
   jokerPenaltyTiming:'perRound',penaltyMode:'mud6',createdAt:Date.now(),
   rows:players.map((p,i)=>({
     pid:i,name:p.name,normalHand:8+i,hasJoker:i===2,pile:12-i,pairs:i%2,madPig:i===1?1:0,
     pileScore:12-i,handPenalty:24+i*3,madPigPenalty:i===1?13:0,jokerPenalty:i===2?20:0,
     jokerPenaltyTotal:i===2?40:0,pendingFinalJokerPenalty:0,shootThePig:false,shootUsed:false,
     shootPigMadPigWaived:false,shootPigPenalty:0,completedRoundCardScore:i*2,
     currentRoundCardScore:-12-i,total:i===0?3:-10-i*5
   }))
 };
}'''

RESET_RENDER = r'''() => {
 const names=['__lastTableRenderKey','__lastRoundStatusKey','__lastHandRenderKey','__lastRoundModalKey',
 '__lastScoreRenderKey','__lastLogRenderKey','__lastLastTrickKey','__lastMatchTrendKey',
 '__lastCommentaryRenderKey','__lastPlayersRenderKey','__lastBasicStatusKey','__lastMessageText'];
 for(const name of names){ try{ eval(name+'=""'); }catch(e){} }
 applyDeviceUiMode(); render();
}'''

AUDIT_NORMAL = r'''(isLandscape) => {
 const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
 const visible=e=>{if(!e)return false;const r=rect(e),s=getComputedStyle(e);return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0;};
 const layer=document.querySelector('#tableCommentary');
 const bubbles=[...document.querySelectorAll('#tableCommentary .speech-bubble')].filter(visible);
 const lr=rect(layer);
 const rows=bubbles.map(b=>{
   const br=rect(b), face=b.querySelector('.speech-face'), body=b.querySelector('.speech-body');
   const fr=rect(face), tr=rect(body);
   return {
     bubbleInside:br.left>=lr.left-.6&&br.right<=lr.right+.6,
     faceInside:fr.left>=br.left-.6&&fr.right<=br.right+.6,
     bodyInside:tr.left>=br.left-.6&&tr.right<=br.right+.6,
     name:b.querySelector('.speech-meta b')?.textContent,
     text:b.querySelector('.speech-body p')?.textContent,
     rect:br
   };
 });
 return {
   noHorizontalOverflow:document.documentElement.scrollWidth<=innerWidth+1,
   visibleRows:bubbles.length,
   expectedRows:isLandscape?1:2,
   layerInside:lr.left>=-1&&lr.right<=innerWidth+1,
   rows,
   allInside:rows.every(r=>r.bubbleInside&&r.faceInside&&r.bodyInside),
   fullNames:rows.every(r=>r.name==='リクもどき'),
   hasTexts:rows.every(r=>!!r.text)
 };
}'''

AUDIT_LOBBY = r'''() => {
 const select=document.querySelector('#roundDealMode');
 const help=document.querySelector('[data-help-rule="roundDealMode"]');
 return {
   noHorizontalOverflow:document.documentElement.scrollWidth<=innerWidth+1,
   selectExists:!!select,
   defaultValue:select?.value,
   options:[...(select?.options||[])].map(o=>o.value),
   helpExists:!!help
 };
}'''

AUDIT_ROUND = r'''() => {
 const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
 const visible=e=>{if(!e)return false;const r=rect(e),s=getComputedStyle(e);return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0;};
 const panel=document.querySelector('.round-panel');
 const totals=[...document.querySelectorAll('.round-total')];
 const stats=[...document.querySelectorAll('.round-card .stat b')];
 const intro=document.querySelector('.round-panel > p.small');
 const button=document.querySelector('[data-continue-round]');
 return {
   noHorizontalOverflow:document.documentElement.scrollWidth<=innerWidth+1,
   panelInside:!!panel&&rect(panel).left>=-1&&rect(panel).right<=innerWidth+1,
   totalsVisible:totals.length===4&&totals.every(visible),
   scoreStatsVisible:stats.length>0&&stats.every(visible),
   modeExplained:(intro?.textContent||'').includes('全カードを回収してシャッフル'),
   buttonVisible:visible(button),
   buttonReachable:rect(button).left>=-1&&rect(button).right<=innerWidth+1
 };
}'''


def all_true(obj: dict[str, Any], keys: list[str]) -> bool:
    return all(bool(obj.get(k)) for k in keys)


def main() -> None:
    failures: list[dict[str, Any]] = []
    cases = 0
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROMIUM, args=["--no-sandbox", "--disable-dev-shm-usage"])
        for label, width, height, is_mobile, has_touch in VIEWPORTS:
            page = browser.new_page(viewport={"width": width, "height": height}, is_mobile=is_mobile, has_touch=has_touch)
            errors: list[str] = []
            page.on("pageerror", lambda exc, errors=errors: errors.append(str(exc)))

            # Lobby / option default
            page.set_content(HTML, wait_until="load")
            lobby = page.evaluate(AUDIT_LOBBY)
            cases += 1
            lobby_ok = all_true(lobby, ["noHorizontalOverflow", "selectExists", "helpExists"]) and lobby["defaultValue"] == "reshuffle" and lobby["options"] == ["reshuffle", "carryOver"]
            if errors or not lobby_ok:
                failures.append({"case": "lobby", "viewport": label, "errors": list(errors), "result": lobby})

            # Normal game / commentary clipping
            errors.clear()
            ctx = page.evaluate(BASE_STATE)
            page.evaluate(RESET_RENDER)
            page.wait_for_timeout(120)
            normal = page.evaluate(AUDIT_NORMAL, label.startswith("landscape"))
            cases += 1
            normal_ok = all_true(normal, ["noHorizontalOverflow", "layerInside", "allInside", "fullNames", "hasTexts"]) and normal["visibleRows"] == normal["expectedRows"]
            if errors or not normal_ok:
                failures.append({"case": "normal", "viewport": label, "errors": list(errors), "result": normal})

            # Round result / score readability and deal mode explanation
            errors.clear()
            page.evaluate(ROUND_END, ctx)
            page.evaluate(RESET_RENDER)
            page.wait_for_timeout(120)
            round_result = page.evaluate(AUDIT_ROUND)
            cases += 1
            round_ok = all_true(round_result, ["noHorizontalOverflow", "panelInside", "totalsVisible", "scoreStatsVisible", "modeExplained", "buttonVisible", "buttonReachable"])
            if errors or not round_ok:
                failures.append({"case": "roundEnd", "viewport": label, "errors": list(errors), "result": round_result})

            page.close()
        browser.close()

    report = {
        "result": "passed" if not failures else "failed",
        "cases": cases,
        "viewports": [v[0] for v in VIEWPORTS],
        "failures": failures,
    }
    (ROOT / "BROWSER_CRITICAL_RESPONSIVE_AUDIT_V14_RESULT.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
