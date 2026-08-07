"""Chromium matrix audit for selected-rule UI and dependent options."""
from __future__ import annotations
import json, pathlib
from playwright.sync_api import sync_playwright
ROOT=pathlib.Path(__file__).resolve().parents[1]
HTML=(ROOT/'public'/'index.html').read_text(encoding='utf-8')
CHROMIUM='/usr/bin/chromium'
VIEWPORTS=[('portrait',393,852,True,True),('landscape',844,390,True,True),('desktop',1280,720,False,False)]

def main():
 failures=[]; cases=0
 with sync_playwright() as p:
  browser=p.chromium.launch(headless=True,executable_path=CHROMIUM,args=['--no-sandbox','--disable-dev-shm-usage'])
  for label,w,h,mobile,touch in VIEWPORTS:
   page=browser.new_page(viewport={'width':w,'height':h},is_mobile=mobile,has_touch=touch)
   errors=[];page.on('pageerror',lambda exc,errors=errors:errors.append(str(exc)))
   page.set_content(HTML,wait_until='load');page.wait_for_timeout(80)
   dependency=page.evaluate(r"""() => {
    const mad=$('madPigEnabled'),shoot=$('shootThePigEnabled'),limit=$('shootThePigLimit'),timing=$('jokerPenaltyTiming');
    shoot.value='true';limit.value='once';syncShootThePigAvailability();
    mad.value='false';mad.dispatchEvent(new Event('change',{bubbles:true}));
    const off={shoot:shoot.value,shootDisabled:shoot.disabled,limitDisabled:limit.disabled,shootHint:$('shootThePigHint').textContent,limitHint:$('shootThePigLimitHint').textContent};
    mad.value='true';mad.dispatchEvent(new Event('change',{bubbles:true}));
    const restored={shoot:shoot.value,shootDisabled:shoot.disabled,limit:limit.value,limitDisabled:limit.disabled};
    timing.value='gameEnd';timing.dispatchEvent(new Event('change',{bubbles:true}));
    const gameEndHint=$('shootThePigLimitHint').textContent;
    return {off,restored,gameEndHint};
   }""")
   if not (dependency['off']['shoot']=='false' and dependency['off']['shootDisabled'] and dependency['off']['limitDisabled']
           and '使用不可' in dependency['off']['shootHint'] and '無効' in dependency['off']['limitHint']
           and dependency['restored']=={'shoot':'true','shootDisabled':False,'limit':'once','limitDisabled':False}
           and '実質最大1回' in dependency['gameEndHint']):
    failures.append({'viewport':label,'dependency':dependency})

   result_labels=page.evaluate(r"""() => {
    state={code:'LABEL',hostId:'P0',you:'P0',yourIndex:0,phase:'roundEnd',round:1,totalRounds:3,
      roundDealMode:'reshuffle',penaltyMode:'faceValue',madPigEnabled:true,jokerPenalty:20,jokerPenaltyTiming:'perRound',
      shootThePigEnabled:true,shootThePigLimit:'unlimited',players:[],roundEndSummary:{round:1,roundDealMode:'reshuffle',
      penaltyMode:'faceValue',madPigEnabled:true,jokerPenaltyTiming:'perRound',reasonPid:0,reasonText:'終了',shootPigResult:null,rows:[
       {pid:0,name:'A',pile:4,normalHand:1,pairs:0,madPig:1,pileScore:4,handPenalty:40,madPigPenalty:0,
        shootThePig:false,shootPigPenalty:20,completedRoundCardScore:0,currentRoundCardScore:-36,jokerPenalty:0,jokerPenaltyTotal:0,total:-56,hasJoker:false}
      ],createdAt:Date.now()}};
    try{eval('__lastRoundModalKey=""')}catch(e){};renderRoundModal();
    const roundText=$('roundModal').textContent.replace(/\s+/g,' ').trim();
    const P=(id,name,total)=>({id,name,cpu:false,cpuKey:null,cpuStyle:'',cpuTitle:'',avatar:'🐷',avatarImage:null,connected:true,handCount:0,hand:[],scorePileCount:0,pairsCount:0,shootUsed:false,shootActivationCount:0,shootLimitReached:false,out:true,lastComment:null,final:{pile:4,completedRoundCardScore:0,normalHand:1,handPenalty:40,madPig:1,madPigHand:1,madPigPile:0,madPigPenalty:0,joker:0,jokerPenalty:0,shootPigPenalty:20,shootPigActivatedRounds:[],shootPigMadPigWaived:false,total}});
    state={code:'LABEL',hostId:'P0',you:'P0',yourIndex:0,phase:'finished',round:3,totalRounds:3,roundDealMode:'reshuffle',penaltyMode:'faceValue',madPigEnabled:true,jokerPenalty:20,jokerPenaltyTiming:'perRound',shootThePigEnabled:true,shootThePigLimit:'unlimited',players:[P('P0','A',-56),P('P1','B',-20),P('P2','C',-10),P('P3','D',0)],commentary:[],log:[],finalRoundSummary:{createdAt:1,reasonText:'終了'}};
    try{eval('__lastScoreRenderKey=""')}catch(e){};renderScore();
    const headers=[...document.querySelectorAll('.score th')].map(x=>x.textContent.trim());
    return {roundText,headers};
   }""")
   if 'マッド山失点' not in result_labels['roundText'] or '手札失点' not in result_labels['roundText'] or 'シュート失点（累計）' not in result_labels['roundText'] or 'マッド山' not in result_labels['headers']:
    failures.append({'viewport':label,'result_labels':result_labels})

   matrix=page.evaluate(r"""() => {
    const results=[];
    const modes=['mud6','flat3','faceValue','mudSuit'];
    const booleans=[false,true];
    for(const penaltyMode of modes) for(const madPigEnabled of booleans) for(const shootThePigEnabled of booleans)
    for(const shootThePigLimit of ['unlimited','once']) for(const jokerPenaltyTiming of ['perRound','gameEnd'])
    for(const roundDealMode of ['reshuffle','carryOver']) for(const pickTargetCount of [0,2,13]){
      const effectiveShoot=madPigEnabled&&shootThePigEnabled;
      state={code:'MATRIX',phase:'playing',round:2,totalRounds:3,roundDealMode,penaltyMode,madPigEnabled,
        jokerPenalty:0,jokerPenaltyTiming,shootThePigEnabled:effectiveShoot,shootThePigLimit,pickTargetCount,
        passThreeEnabled:true,initialPairDiscardEnabled:true,roundEndDeferred:null,players:[]};
      try{eval('__lastActiveRuleSummaryKey=""')}catch(e){}
      renderSelectedRuleSummary();
      const text=$('activeRuleSummary').textContent.replace(/\s+/g,' ').trim();
      const chips=compactOptionChips().join(' / ');
      const final=finalShootRuleExplanation();
      results.push({penaltyMode,madPigEnabled,effectiveShoot,shootThePigLimit,jokerPenaltyTiming,roundDealMode,pickTargetCount,text,chips,final});
    }
    return results;
   }""")
   cases+=len(matrix)
   for row in matrix:
    combined=' | '.join([row['text'],row['chips'],row['final']])
    bad=any(x in combined for x in ['undefined','NaN','[object Object]','-0点','ババ-0'])
    if not row['madPigEnabled']:
     bad=bad or '使用不可' not in row['text'] or 'マッドなし' not in row['chips'] or '発動しません' not in row['final']
    elif not row['effectiveShoot']:
     bad=bad or 'シュートOFF' not in row['chips'] or '使用しません' not in row['final']
    elif row['jokerPenaltyTiming']=='gameEnd':
     bad=bad or '最終ラウンド' not in row['text'] or '最終ラウンド' not in row['final']
    if row['penaltyMode']=='faceValue' and row['madPigEnabled']:
     bad=bad or '-40点' not in row['text']
    if row['pickTargetCount']==0:
     bad=bad or '手札全体' not in row['text']
    if bad:
     failures.append({'viewport':label,'row':row});break
   overflow=page.evaluate(r"""() => ({doc:document.documentElement.scrollWidth-innerWidth,body:document.body.scrollWidth-innerWidth})""")
   if errors or overflow['doc']>1 or overflow['body']>1: failures.append({'viewport':label,'errors':errors,'overflow':overflow})
   page.close()
  browser.close()
 report={'result':'passed' if not failures else 'failed','cases':cases,'failures':failures[:20]}
 (ROOT/'BROWSER_RULE_MATRIX_V35_RESULT.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
 print(json.dumps(report,ensure_ascii=False))
 if failures: raise SystemExit(1)
if __name__=='__main__': main()
