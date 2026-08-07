from __future__ import annotations
import json, pathlib
from playwright.sync_api import sync_playwright
ROOT=pathlib.Path(__file__).resolve().parents[1]
HTML=(ROOT/'public'/'index.html').read_text(encoding='utf-8')
CHROMIUM='/usr/bin/chromium'
VIEWPORTS=[('iphone-se',320,568),('iphone-pro',393,852),('landscape',568,320),('desktop',1280,720)]
SETUP=r'''() => {
 const P=(id,name,cpu,key)=>({id,name,cpu,cpuKey:key,cpuStyle:'',cpuTitle:'',avatar:'🐷',avatarImage:null,connected:true,handCount:0,hand:[],scorePileCount:0,pairsCount:0,shootUsed:false,out:true,final:null,lastComment:null});
 const players=[P('ME','とても長いプレイヤー名ピピ',false,null),P('C1','かももどき',true,'kamomodoki'),P('C2','ワクもどき',true,'wakumodoki'),P('C3','リクもどき',true,'rikumodoki')];
 const totals=[0,-9,-15,-24];
 players.forEach((p,i)=>p.final={pile:16-i,completedRoundCardScore:i*2,normalHand:5+i,handPenalty:i?15+i*3:0,madPig:i===2?1:0,madPigHand:0,madPigPile:i===2?1:0,madPigPenalty:i===2?13:0,joker:i===3?1:0,jokerPenalty:i===3?20:0,shootPigPenalty:0,shootPigActivatedRounds:[],shootPigMadPigWaived:false,total:totals[i]});
 state={code:'TEST',hostId:'ME',you:'ME',yourIndex:0,phase:'finished',round:3,totalRounds:3,roundDealMode:'reshuffle',madPigEnabled:true,jokerPenalty:20,jokerPenaltyTiming:'perRound',shootThePigEnabled:true,penaltyMode:'mud6',players,commentary:[],log:[],finalRoundSummary:{round:3,reasonText:'テスト終了'}};
 resumeToken=''; render();
}'''
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,executable_path=CHROMIUM,args=['--no-sandbox','--disable-dev-shm-usage'])
 failures=[]; results=[]
 for label,w,h in VIEWPORTS:
  page=browser.new_page(viewport={'width':w,'height':h},is_mobile=w<700,has_touch=w<700)
  errors=[]; page.on('pageerror',lambda e,errors=errors:errors.append(str(e)))
  page.set_content(HTML,wait_until='load'); page.evaluate(SETUP); page.wait_for_timeout(100)
  before=page.evaluate('''() => { const s=document.querySelector('.score-screen'); return {client:s.clientHeight,scroll:s.scrollHeight,top:s.scrollTop,body:getComputedStyle(document.body).overflowY,action:document.querySelector('.final-actions').getBoundingClientRect().top}; }''')
  page.evaluate("document.querySelector('.score-screen').scrollTop=document.querySelector('.score-screen').scrollHeight")
  page.wait_for_timeout(60)
  after=page.evaluate('''() => { const s=document.querySelector('.score-screen'),a=document.querySelector('.final-actions').getBoundingClientRect(); return {top:s.scrollTop,max:s.scrollHeight-s.clientHeight,actionTop:a.top,actionBottom:a.bottom,visible:a.bottom>0&&a.top<innerHeight,buttons:[...document.querySelectorAll('.final-actions button')].map(b=>({text:b.textContent.trim(),top:b.getBoundingClientRect().top,bottom:b.getBoundingClientRect().bottom}))}; }''')
  page.click('[data-scroll-top]')
  page.wait_for_timeout(450)
  button_top=page.evaluate("document.querySelector('.score-screen').scrollTop")
  after['buttonTop']=button_top
  ok=before['scroll']>before['client'] and after['top']>0 and after['visible'] and button_top<3 and not errors
  results.append({'viewport':label,'before':before,'after':after,'errors':errors,'ok':ok})
  if not ok: failures.append(label)
  page.close()
 browser.close()
 report={'result':'passed' if not failures else 'failed','results':results,'failures':failures}
 (ROOT/'BROWSER_FINAL_RESULT_SCROLL_V29_RESULT.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
 print(json.dumps(report,ensure_ascii=False))
 if failures: raise SystemExit(1)
