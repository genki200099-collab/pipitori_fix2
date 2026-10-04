from __future__ import annotations
import json, math, pathlib, re
from playwright.sync_api import sync_playwright

ROOT=pathlib.Path(__file__).resolve().parents[1]
HTML=(ROOT/'public'/'index.html').read_text(encoding='utf-8')
CHROMIUM='/usr/bin/chromium'
VIEWPORTS=[('iphone-se',320,568),('iphone-pro',393,852),('landscape',568,320),('desktop',1280,720),('wide',1875,588)]
SETUP=r'''() => {
 const P=(id,name,cpu,key)=>({id,name,cpu,cpuKey:key,cpuStyle:'',cpuTitle:'',avatar:'🐷',avatarImage:null,connected:true,handCount:0,hand:[],scorePileCount:0,pairsCount:0,shootUsed:false,out:true,final:null,lastComment:null});
 const players=[P('ME','子ブタ',false,null),P('C1','かももどき',true,'kamomodoki'),P('C2','ワクもどき',true,'wakumodoki'),P('C3','リクもどき',true,'rikumodoki')];
 const totals=[-17,-56,-12,-22];
 players.forEach((p,i)=>p.final={pile:[0,24,8,0][i],completedRoundCardScore:0,normalHand:5,handPenalty:[12,15,12,0][i],madPig:0,madPigHand:0,madPigPile:0,madPigPenalty:[0,13,0,0][i],joker:0,jokerPenalty:[0,40,20,0][i],shootPigPenalty:0,shootPigActivatedRounds:[],shootPigMadPigWaived:false,total:totals[i]});
 state={code:'TEST',hostId:'ME',you:'ME',yourIndex:0,phase:'finished',round:3,totalRounds:3,roundDealMode:'reshuffle',madPigEnabled:true,jokerPenalty:20,jokerPenaltyTiming:'perRound',shootThePigEnabled:true,penaltyMode:'mud6',players,commentary:[],log:[],finalRoundSummary:{round:3,reasonText:'テスト終了'}};
 resumeToken=''; render();
}'''

SELECTORS={
 'title':'.score-screen>h2',
 'podium_name':'.podium-name',
 'break_heading':'.break-card h4',
 'break_label':'.break-row span',
 'break_value':'.break-row b',
 'break_total':'.break-total',
 'table_header':'.score th',
 'table_cell':'.score td',
 'table_total':'.score td b',
 'final_comment':'.final-comment',
}

def parse_rgb(value:str):
 m=re.match(r'rgba?\((\d+),\s*(\d+),\s*(\d+)',value or '')
 if not m: raise ValueError(value)
 return tuple(int(x) for x in m.groups())

def lum(rgb):
 vals=[]
 for c in rgb:
  v=c/255
  vals.append(v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4)
 return .2126*vals[0]+.7152*vals[1]+.0722*vals[2]

def contrast(a,b):
 l1,l2=sorted([lum(a),lum(b)],reverse=True)
 return (l1+.05)/(l2+.05)

EXPECTED_BACKGROUNDS={
 'title':(9,46,50),
 'podium_name':(255,250,242),
 'break_heading':(255,255,255),
 'break_label':(255,255,255),
 'break_value':(255,255,255),
 'break_total':(255,241,189),
 'table_header':(248,223,202),
 'table_cell':(255,255,255),
 'table_total':(255,255,255),
 'final_comment':(255,248,216),
}

with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,executable_path=CHROMIUM,args=['--no-sandbox','--disable-dev-shm-usage'])
 failures=[]; results=[]
 for label,w,h in VIEWPORTS:
  page=browser.new_page(viewport={'width':w,'height':h},is_mobile=w<700,has_touch=w<700)
  errors=[]; page.on('pageerror',lambda e,errors=errors:errors.append(str(e)))
  page.set_content(HTML,wait_until='load'); page.evaluate(SETUP); page.wait_for_timeout(100)
  colors={}
  for key,selector in SELECTORS.items():
   style=page.eval_on_selector(selector,"e=>({color:getComputedStyle(e).color,background:getComputedStyle(e).backgroundColor,display:getComputedStyle(e).display})")
   ratio=contrast(parse_rgb(style['color']),EXPECTED_BACKGROUNDS[key])
   colors[key]={**style,'contrast':round(ratio,2)}
   if ratio < 4.5:
    failures.append(f'{label}:{key}:{ratio:.2f}')
  dimensions=page.evaluate('''() => { const s=document.querySelector('.score-screen'); const stage=document.querySelector('.final-stage'); return {bodyWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth,stageRight:stage.getBoundingClientRect().right,scrollWidth:s.scrollWidth,clientWidth:s.clientWidth}; }''')
  if dimensions['bodyWidth']>dimensions['viewportWidth']+1 or dimensions['stageRight']>dimensions['viewportWidth']+1:
   failures.append(f'{label}:horizontal-overflow')
  if errors: failures.append(f'{label}:pageerror')
  screenshot=ROOT/f'V31_FINAL_CONTRAST_{label}.png'
  page.screenshot(path=str(screenshot),full_page=False)
  results.append({'viewport':label,'colors':colors,'dimensions':dimensions,'errors':errors,'screenshot':screenshot.name})
  page.close()
 browser.close()
 report={'result':'passed' if not failures else 'failed','failures':failures,'results':results}
 (ROOT/'BROWSER_FINAL_RESULT_CONTRAST_V31_RESULT.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
 print(json.dumps(report,ensure_ascii=False))
 if failures: raise SystemExit(1)
