"""Real-Chromium checks for v32 input guards, recovery, labels, fallbacks and touch targets."""
from __future__ import annotations
import importlib.util
import json
import pathlib
from playwright.sync_api import sync_playwright

ROOT=pathlib.Path(__file__).resolve().parents[1]
HTML=(ROOT/'public'/'index.html').read_text(encoding='utf-8')
CHROMIUM='/usr/bin/chromium'

spec=importlib.util.spec_from_file_location('responsive_fixture', ROOT/'tests'/'browser_full_responsive_audit_v15.py')
fixture=importlib.util.module_from_spec(spec)
assert spec.loader
spec.loader.exec_module(fixture)
BASE=fixture.BASE
MODS=fixture.MODS
RESET=fixture.RESET


def main():
    failures=[]
    report={'result':'passed','checks':{},'failures':failures}
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True,executable_path=CHROMIUM,args=['--no-sandbox','--disable-dev-shm-usage'])
        page=browser.new_page(viewport={'width':393,'height':852},is_mobile=True,has_touch=True)
        errors=[]
        page.on('pageerror',lambda e: errors.append(str(e)))
        page.set_content(HTML,wait_until='load')

        # Normal hand: reject right mouse pointerup but preserve keyboard activation.
        ctx=page.evaluate(BASE)
        page.evaluate(RESET)
        page.evaluate("""() => {
          window.__played=[];
          requestPlay=(cardId)=>{ window.__played.push(cardId); return true; };
          selectedPlayCardId=null; playCommitPending=false;
        }""")
        first=page.locator('#hand [data-card-id]').first
        card_id=first.get_attribute('data-card-id')
        page.evaluate("""() => {
          const el=document.querySelector('#hand [data-card-id]');
          el.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,pointerType:'mouse',button:2,isPrimary:true}));
        }""")
        right_click=page.evaluate("() => ({selected:selectedPlayCardId,played:window.__played.length})")
        report['checks']['rightClickIgnored']=right_click['selected'] is None and right_click['played']==0
        if not report['checks']['rightClickIgnored']:
            failures.append({'check':'rightClickIgnored','actual':right_click})

        first.press('Enter')
        selected=page.evaluate("() => selectedPlayCardId")
        first.press('Enter')
        keyboard=page.evaluate("() => ({selected:selectedPlayCardId,played:window.__played.slice()})")
        report['checks']['keyboardActivation']=selected==card_id and keyboard['played']==[card_id]
        if not report['checks']['keyboardActivation']:
            failures.append({'check':'keyboardActivation','selectedAfterFirst':selected,'actual':keyboard,'card':card_id})

        # Pick buttons must expose useful names.
        ctx=page.evaluate(BASE); page.evaluate(MODS['pick'],ctx); page.evaluate(RESET); page.wait_for_timeout(40)
        pick_labels=page.locator('[data-pick-index]').evaluate_all("els=>els.map(e=>e.getAttribute('aria-label')||'')")
        report['checks']['pickAccessibleNames']=len(pick_labels)==2 and all(label.strip() for label in pick_labels)
        report['checks']['pickLabels']=pick_labels
        if not report['checks']['pickAccessibleNames']:
            failures.append({'check':'pickAccessibleNames','labels':pick_labels})

        # A rejected/no-op pair request must not leave controls permanently disabled.
        ctx=page.evaluate(BASE); page.evaluate(MODS['pair'],ctx); page.evaluate(RESET); page.wait_for_timeout(40)
        page.evaluate("""() => {
          const original=scheduleActionRecovery;
          scheduleActionRecovery=(key,guard,restore)=>original(key,guard,restore,70);
          requestPairChoice=()=>true;
        }""")
        pair=page.locator('[data-pair-card-id]').first
        pair.click()
        disabled_during=pair.is_disabled()
        page.wait_for_timeout(130)
        disabled_after=pair.is_disabled()
        report['checks']['pairRecovery']=disabled_during and not disabled_after
        if not report['checks']['pairRecovery']:
            failures.append({'check':'pairRecovery','disabledDuring':disabled_during,'disabledAfter':disabled_after})

        # Broken avatar images must fall back to a readable emoji node.
        ctx=page.evaluate(BASE)
        page.evaluate("""({players}) => {
          state.players=players;
          state.players[1].avatarImage='missing-avatar-v32.png';
          __lastPlayersRenderKey=''; renderPlayers();
          const img=document.querySelector('[data-player-avatar-fallback]');
          if(img) img.dispatchEvent(new Event('error'));
        }""",ctx)
        fallback=page.locator('.cpu-avatar-emoji[role="img"]').count()
        report['checks']['avatarFallback']=fallback>0
        if not report['checks']['avatarFallback']:
            failures.append({'check':'avatarFallback','count':fallback})

        # Portrait touch targets and overflow.
        ctx=page.evaluate(BASE); page.evaluate(RESET); page.wait_for_timeout(40)
        sizes=page.evaluate("""() => {
          const box=e=>{const r=e.getBoundingClientRect();return {w:r.width,h:r.height}};
          return {
            hud:[...document.querySelectorAll('.hud-button')].filter(e=>getComputedStyle(e).display!=='none').map(box),
            toggle:box(document.querySelector('[data-hand-view-toggle]')),
            scrollWidth:document.documentElement.scrollWidth,
            innerWidth
          };
        }""")
        report['checks']['hudTouchTargets']=bool(sizes['hud']) and all(x['h']>=39 for x in sizes['hud'])
        report['checks']['handToggleTarget']=sizes['toggle']['h']>=35
        report['checks']['noHorizontalOverflow']=sizes['scrollWidth']<=sizes['innerWidth']+1
        for key in ('hudTouchTargets','handToggleTarget','noHorizontalOverflow'):
            if not report['checks'][key]: failures.append({'check':key,'sizes':sizes})

        report['checks']['pageErrors']=errors
        if errors: failures.append({'check':'pageErrors','errors':errors})
        page.close(); browser.close()

    report['result']='passed' if not failures else 'failed'
    out=ROOT/'BROWSER_INTERACTION_ACCESSIBILITY_V32_RESULT.json'
    out.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False))
    if failures: raise SystemExit(1)

if __name__=='__main__':
    main()
