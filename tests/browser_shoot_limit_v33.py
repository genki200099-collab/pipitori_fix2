"""Real-Chromium audit for the v33 Shoot-the-Pig limit selector."""
from __future__ import annotations
import json
import pathlib
from playwright.sync_api import sync_playwright

ROOT=pathlib.Path(__file__).resolve().parents[1]
HTML=(ROOT/'public'/'index.html').read_text(encoding='utf-8')
CHROMIUM='/usr/bin/chromium'
VIEWPORTS=[('portrait-320x568',320,568,True,True),('landscape-568x320',568,320,True,True),('desktop-1280x720',1280,720,False,False)]

def main():
    failures=[]; cases=0
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True,executable_path=CHROMIUM,args=['--no-sandbox','--disable-dev-shm-usage'])
        for label,w,h,mobile,touch in VIEWPORTS:
            page=browser.new_page(viewport={'width':w,'height':h},is_mobile=mobile,has_touch=touch)
            errors=[]
            page.on('pageerror',lambda exc,errors=errors:errors.append(str(exc)))
            page.set_content(HTML,wait_until='load')
            page.wait_for_timeout(80)
            result=page.evaluate("""() => {
              const details=document.querySelector('.settings-details');if(details)details.open=true;
              const limit=document.querySelector('#shootThePigLimit');
              const shoot=document.querySelector('#shootThePigEnabled');
              const mad=document.querySelector('#madPigEnabled');
              const trend=document.querySelector('#matchTrendPanel');
              const preset=document.querySelector('[data-rule-preset="standard"]');
              const standardMeta=preset?.querySelector('.preset-meta')?.textContent||'';
              const visible=(el)=>{if(!el)return false;const r=el.getBoundingClientRect(),s=getComputedStyle(el);return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0;};
              limit?.scrollIntoView({block:'center'});
              const lr=limit?.getBoundingClientRect();
              const initial={value:limit?.value,disabled:limit?.disabled,visible:visible(limit),inViewport:!!lr&&lr.top>=-1&&lr.bottom<=innerHeight+1,standardMeta,overflow:document.documentElement.scrollWidth<=innerWidth+1};
              limit.value='once';limit.dispatchEvent(new Event('change',{bubbles:true}));
              const once={trend:trend?.textContent||'',custom:document.querySelector('#selectedPresetSummary')?.textContent||'',limitDisabled:limit.disabled};
              shoot.value='false';shoot.dispatchEvent(new Event('change',{bubbles:true}));
              const off={limitDisabled:limit.disabled};
              shoot.value='true';shoot.dispatchEvent(new Event('change',{bubbles:true}));
              const on={limitDisabled:limit.disabled};
              mad.value='false';mad.dispatchEvent(new Event('change',{bubbles:true}));
              const madOff={shootValue:shoot.value,shootDisabled:shoot.disabled,limitDisabled:limit.disabled};
              preset.click();
              const reset={mad:mad.value,shoot:shoot.value,limit:limit.value,limitDisabled:limit.disabled,selected:preset.getAttribute('aria-pressed')};
              const mk=(id,name,count)=>({id,name,cpu:false,cpuKey:null,avatar:'🐷',avatarImage:null,connected:true,handCount:5,scorePileCount:2,pairsCount:0,shootUsed:count>0,shootActivationCount:count,shootLimitReached:false,out:false,final:null,lastComment:null});
              state={code:'UI33',hostId:'P0',you:'P0',yourIndex:0,phase:'playing',current:0,round:2,totalRounds:3,shootThePigEnabled:true,shootThePigLimit:'unlimited',players:[mk('P0','子ブタ',2),mk('P1','A',0),mk('P2','B',0),mk('P3','C',0)]};
              try{eval('__lastPlayersRenderKey=""')}catch(e){}
              renderPlayers();
              const unlimitedBadge=document.querySelector('.position-bottom .shoot-used-mini')?.textContent||'';
              state.shootThePigLimit='once';state.players[0].shootActivationCount=1;state.players[0].shootLimitReached=true;
              try{eval('__lastPlayersRenderKey=""')}catch(e){}
              renderPlayers();
              const onceBadge=document.querySelector('.position-bottom .shoot-used-mini')?.textContent||'';
              return {initial,once,off,on,madOff,reset,badges:{unlimitedBadge,onceBadge}};
            }""")
            cases+=1
            ok=(not errors and result['initial']['value']=='unlimited' and not result['initial']['disabled'] and result['initial']['visible'] and result['initial']['inViewport'] and result['initial']['overflow']
                and 'シュート無制限' in result['initial']['standardMeta']
                and '1回' in result['once']['trend'] and 'カスタム' in result['once']['custom'] and not result['once']['limitDisabled']
                and result['off']['limitDisabled'] and not result['on']['limitDisabled']
                and result['madOff']=={'shootValue':'false','shootDisabled':True,'limitDisabled':True}
                and result['reset']=={'mad':'true','shoot':'true','limit':'unlimited','limitDisabled':False,'selected':'true'}
                and result['badges']=={'unlimitedBadge':'🌕×2','onceBadge':'🌕済'})
            if not ok: failures.append({'viewport':label,'errors':errors,'result':result})
            page.close()
        browser.close()
    report={'result':'passed' if not failures else 'failed','cases':cases,'failures':failures}
    (ROOT/'BROWSER_SHOOT_LIMIT_V33_RESULT.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False))
    if failures: raise SystemExit(1)
if __name__=='__main__': main()
