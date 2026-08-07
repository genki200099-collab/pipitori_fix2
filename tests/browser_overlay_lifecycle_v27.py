from pathlib import Path
import json
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[1]
html=(root/'public'/'index.html').read_text()
results={}
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium')
    page=browser.new_page(viewport={'width':393,'height':852})
    errors=[]
    page.on('pageerror',lambda exc: errors.append(str(exc)))
    page.set_content(html,wait_until='load')
    errors.clear()
    # Spotlight hides the small rail and clearing restores it.
    page.evaluate("""() => {
      state={code:'V27',round:1,totalRounds:3,phase:'playing',players:[{name:'CPU'}],commentary:[{pid:0,name:'CPU',text:'小さい実況',compactText:'小さい実況',expiresAt:Date.now()+1000}],trick:[],log:[],current:null,lead:null,spotlightEvent:{id:'spot-a',speakerPid:0,speakerName:'CPU',cpuKey:'rikumodoki',text:'中央コメント',emotion:'normal',bubbleStyle:'focus',animation:'side-in',eventType:'pickWatch',startsAt:0,expiresAt:Date.now()+1000,durationMs:900}};
      __lastCommentaryRenderKey='';__lastSpotlightEventId='';renderCommentary();renderSpotlightOverlay();
    }""")
    page.wait_for_timeout(50)
    results['spotlightActive']=page.evaluate("""() => ({body:document.body.classList.contains('spotlight-active'),railOpacity:getComputedStyle(document.querySelector('.commentary-layer')).opacity,spotCount:document.querySelectorAll('.spotlight-card').length})""")
    assert results['spotlightActive']['body'] and float(results['spotlightActive']['railOpacity'])==0 and results['spotlightActive']['spotCount']==1
    page.evaluate("""() => {state.spotlightEvent=null;renderSpotlightOverlay();}""")
    results['spotlightCleared']=page.evaluate("""() => ({body:document.body.classList.contains('spotlight-active'),html:document.querySelector('#spotlightOverlay').innerHTML})""")
    assert not results['spotlightCleared']['body'] and results['spotlightCleared']['html']==''
    # Old nested timer must not erase a newer event.
    page.evaluate("""() => {
      const root=document.querySelector('#babaDrawOverlay');
      clearTimedOverlay(root,{holdTimer:'__qaHold',clearTimer:'__qaClear'});
      root.dataset.active='1';root.dataset.eventId='old';root.innerHTML='<b>OLD</b>';
      scheduleTimedOverlayExit(root,{eventId:'old',holdMs:10,fadeMs:10,holdTimer:'__qaHold',clearTimer:'__qaClear'});
      setTimeout(()=>{clearTimedOverlay(root,{holdTimer:'__qaHold',clearTimer:'__qaClear'});root.dataset.active='1';root.dataset.eventId='new';root.innerHTML='<b>NEW</b>';scheduleTimedOverlayExit(root,{eventId:'new',holdMs:120,fadeMs:10,holdTimer:'__qaHold',clearTimer:'__qaClear'});},5);
    }""")
    page.wait_for_timeout(45)
    results['replacementGuard']=page.evaluate("""() => ({id:document.querySelector('#babaDrawOverlay').dataset.eventId,text:document.querySelector('#babaDrawOverlay').textContent.trim(),active:document.querySelector('#babaDrawOverlay').dataset.active})""")
    assert results['replacementGuard']=={'id':'new','text':'NEW','active':'1'}
    # Expired rail comments disappear without another server broadcast.
    page.evaluate("""() => {clearTimedOverlay(document.querySelector('#babaDrawOverlay'),{holdTimer:'__qaHold',clearTimer:'__qaClear'});state.spotlightEvent=null;state.commentary=[{pid:0,name:'CPU',text:'短命コメント',compactText:'短命コメント',expiresAt:Date.now()+60}];__lastCommentaryRenderKey='';renderCommentary();}""")
    page.wait_for_timeout(130)
    results['commentExpiry']=page.evaluate("""() => document.querySelector('#tableCommentary').textContent.trim()""")
    assert results['commentExpiry']==''
    # Special overlay timing adapts to the server's spotlight start time.
    results['adaptiveHold']=page.evaluate("""() => {state.spotlightEvent={startsAt:Date.now()+1000};return timedOverlayHoldMs(2600,450)}""")
    assert 450 <= results['adaptiveHold'] <= 550
    assert not errors,errors
    browser.close()
out={'result':'passed','details':results}
(root/'BROWSER_OVERLAY_LIFECYCLE_V27_RESULT.json').write_text(json.dumps(out,ensure_ascii=False,indent=2))
print(json.dumps(out,ensure_ascii=False))
