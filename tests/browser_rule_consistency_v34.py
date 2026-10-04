"""Static Chromium audit for dynamic Shoot-the-Pig final-result explanations."""
from __future__ import annotations
import json, pathlib
from playwright.sync_api import sync_playwright
ROOT=pathlib.Path(__file__).resolve().parents[1]
HTML=(ROOT/'public'/'index.html').read_text(encoding='utf-8')
CHROMIUM='/usr/bin/chromium'
CASES=[
 ('unlimited',{'madPigEnabled':True,'shootThePigEnabled':True,'shootThePigLimit':'unlimited','jokerPenaltyTiming':'perRound'},'発動回数無制限','各ラウンド終了時'),
 ('once',{'madPigEnabled':True,'shootThePigEnabled':True,'shootThePigLimit':'once','jokerPenaltyTiming':'gameEnd'},'各プレイヤー1ゲーム1回まで','最終ラウンドだけ'),
 ('shoot-off',{'madPigEnabled':True,'shootThePigEnabled':False,'shootThePigLimit':'unlimited','jokerPenaltyTiming':'perRound'},'シュート・ザ・ピッグを使用しません',''),
 ('mad-off',{'madPigEnabled':False,'shootThePigEnabled':False,'shootThePigLimit':'unlimited','jokerPenaltyTiming':'perRound'},'マッド・ピッグなし',''),
]
def main():
 failures=[]
 with sync_playwright() as p:
  browser=p.chromium.launch(headless=True,executable_path=CHROMIUM,args=['--no-sandbox','--disable-dev-shm-usage'])
  page=browser.new_page(viewport={'width':393,'height':852},is_mobile=True,has_touch=True)
  errors=[];page.on('pageerror',lambda exc:errors.append(str(exc)))
  page.set_content(HTML,wait_until='load')
  for label,state,expected,extra in CASES:
   text=page.evaluate("""(s)=>{eval('state='+JSON.stringify(s));return finalShootRuleExplanation();}""",state)
   if expected not in text or (extra and extra not in text): failures.append({'case':label,'text':text})
  page.close();browser.close()
 report={'result':'passed' if not failures and not errors else 'failed','cases':len(CASES),'errors':errors,'failures':failures}
 (ROOT/'BROWSER_RULE_CONSISTENCY_V34_RESULT.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
 print(json.dumps(report,ensure_ascii=False))
 if report['result']!='passed': raise SystemExit(1)
if __name__=='__main__': main()
