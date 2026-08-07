"""Real-Chromium audit for concise CPU commentary on portrait/landscape/desktop."""
from __future__ import annotations
import json
import pathlib
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
HTML = (ROOT / 'public' / 'index.html').read_text(encoding='utf-8')
CHROMIUM = '/usr/bin/chromium'
VIEWPORTS = [
    ('portrait-320x568', 320, 568, True, True, 2, True),
    ('portrait-393x852', 393, 852, True, True, 2, True),
    ('landscape-568x320', 568, 320, True, True, 1, True),
    ('landscape-844x390', 844, 390, True, True, 1, True),
    ('desktop-1280x720', 1280, 720, False, False, 2, False),
]

SETUP = r'''() => {
 const suits=['apple','corn','cabbage','mud'];
 const cards=Array.from({length:13},(_,i)=>({id:'h'+i,suit:suits[i%4],rank:String(i+1),val:i+1,joker:false}));
 const P=(id,name,cpu,key,img,count,hand=null)=>({id,name,cpu,cpuKey:key,cpuStyle:'',cpuTitle:'',avatar:'🐷',avatarImage:img,connected:true,handCount:count,hand,scorePileCount:4,pairsCount:1,shootUsed:false,out:false,final:null,lastComment:null});
 const players=[P('ME','ピピ',false,null,null,11,cards),P('C1','かももどき',true,'kamomodoki','cpu_characters/kamomodoki.jpg',12),P('C2','ワクもどき',true,'wakumodoki','cpu_characters/wakumodoki.jpg',11),P('C3','リクもどき',true,'rikumodoki','cpu_characters/rikumodoki.png',11)];
 state={code:'TEST',hostId:'ME',you:'ME',yourIndex:0,phase:'playing',round:1,totalRounds:3,roundDealMode:'reshuffle',madPigEnabled:true,jokerPenalty:20,jokerPenaltyTiming:'perRound',shootThePigEnabled:true,shootThePigLimit:'unlimited',shootThePigPerPlayerLimit:null,initialPairDiscardEnabled:false,passThreeEnabled:false,penaltyMode:'mud6',pickTargetCount:2,passDone:[],initialPairDone:[],roundStart:null,roundEndSummary:null,roundEndAutoContinueAt:null,lead:0,current:0,leadSuit:'mud',message:'リクもどきが12 💧を出しました。',removedCard:null,trick:[],pendingPick:null,players,playableCardIds:cards.map(c=>c.id),isYourTurn:true,commentary:[
  {pid:3,cpuKey:'rikumodoki',avatarImage:'cpu_characters/rikumodoki.png',name:'リクもどき',text:'💧スートは失点が重いです。12 💧を処理します。',compactText:'💧12を処理します。',mood:'analysis',intensity:'medium',eventKey:'card-danger',icon:'📋',label:'計画手',expiresAt:Date.now()+100000},
  {pid:2,cpuKey:'wakumodoki',avatarImage:'cpu_characters/wakumodoki.jpg',name:'ワクもどき',text:'かももどきさん、ごめん！自由なら大胆にいくぞぉ〜✊🏻',compactText:'大胆にいくぞぉ〜✊🏻',mood:'hype',intensity:'strong',eventKey:'card-play',icon:'✊🏻',label:'大胆な一手',expiresAt:Date.now()+100000}
 ],lastTrick:null,trickReview:null,log:[]};
 resumeToken='';
 for(const n of ['__lastTableRenderKey','__lastRoundStatusKey','__lastHandRenderKey','__lastRoundModalKey','__lastScoreRenderKey','__lastLogRenderKey','__lastLastTrickKey','__lastMatchTrendKey','__lastCommentaryRenderKey','__lastPlayersRenderKey','__lastBasicStatusKey','__lastMessageText']){try{eval(n+'=""')}catch(e){}}
 applyDeviceUiMode(); render();
}'''

AUDIT = r'''({expectedCount, useCompact}) => {
 const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0};
 const bubbles=[...document.querySelectorAll('#tableCommentary .speech-bubble')].filter(visible);
 const texts=bubbles.map(b=>{
   const compact=b.querySelector('.commentary-compact-text');
   const full=b.querySelector('.commentary-full-text');
   return {
     compactVisible:visible(compact), fullVisible:visible(full),
     compact:compact?.textContent||'', full:full?.textContent||'',
     pOverflow:(()=>{const p=b.querySelector('p'); return p ? p.scrollHeight > p.clientHeight + 1 : true;})(),
     bubble:b.getBoundingClientRect().toJSON()
   };
 });
 const commentary=document.querySelector('#tableCommentary')?.getBoundingClientRect();
 const message=document.querySelector('#message')?.getBoundingClientRect();
 return {
   count:bubbles.length,
   expectedCount,
   useCompact,
   texts,
   noTextOverflow:texts.every(t=>!t.pOverflow),
   correctMode:texts.every(t=>useCompact ? t.compactVisible&&!t.fullVisible : t.fullVisible&&!t.compactVisible),
   expectedCopy:useCompact ? texts.map(t=>t.compact).join('|')===(expectedCount===1?'💧12を処理します。':'💧12を処理します。|大胆にいくぞぉ〜✊🏻') : texts[0]?.full.includes('失点が重い'),
   noMessageOverlap:!commentary||!message||commentary.right<=message.left+1||message.right<=commentary.left+1||commentary.bottom<=message.top+1||message.bottom<=commentary.top+1,
   noHorizontalOverflow:document.documentElement.scrollWidth<=innerWidth+1
 };
}'''

def main():
    failures=[]
    results=[]
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True,executable_path=CHROMIUM,args=['--no-sandbox','--disable-dev-shm-usage'])
        for label,w,h,mobile,touch,count,compact in VIEWPORTS:
            page=browser.new_page(viewport={'width':w,'height':h},is_mobile=mobile,has_touch=touch)
            errors=[]
            page.on('pageerror',lambda e,errors=errors: errors.append(str(e)))
            page.set_content(HTML,wait_until='load')
            page.evaluate(SETUP)
            page.wait_for_timeout(100)
            result=page.evaluate(AUDIT,{'expectedCount':count,'useCompact':compact})
            result['viewport']=label
            result['errors']=errors
            results.append(result)
            checks=[result['count']==count,result['noTextOverflow'],result['correctMode'],result['expectedCopy'],result['noMessageOverlap'],result['noHorizontalOverflow'],not errors]
            if not all(checks): failures.append(result)
            page.close()
        browser.close()
    report={'result':'passed' if not failures else 'failed','cases':len(results),'results':results,'failures':failures}
    (ROOT/'BROWSER_COMMENTARY_READABILITY_V16_RESULT.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False))
    if failures: raise SystemExit(1)

if __name__=='__main__':
    main()
