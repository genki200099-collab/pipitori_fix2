from pathlib import Path
import json
import base64
import mimetypes
from playwright.sync_api import sync_playwright

root=Path(__file__).resolve().parents[1]
html=(root/'public'/'index.html').read_text()
out_dir=Path('/mnt/data/pipitri_spotlight_v23_browser')
out_dir.mkdir(exist_ok=True)

cases=[
    ('portrait',320,568,{
        'id':'test-kamo','speakerPid':0,'speakerName':'かももどき','cpuKey':'kamomodoki',
        'text':'ピピさん、そのババブタは明日のパンより重たいですよ♡',
        'emotion':'anger','portraitPath':'./cpu_characters/spotlight/kamomodoki/anger.jpg',
        'bubbleStyle':'jagged','animation':'shock-in','eventType':'babaReveal'
    }),
    ('landscape',568,320,{
        'id':'test-waku','speakerPid':1,'speakerName':'ワクもどき','cpuKey':'wakumodoki',
        'text':'エベレストなら更地にしておいたよ？ このペアも浄化するぞぉ〜✊🏻',
        'emotion':'joy','portraitPath':'./cpu_characters/spotlight/wakumodoki/joy.png',
        'bubbleStyle':'burst','animation':'victory-jump','eventType':'resultPair'
    }),
    ('desktop',1280,720,{
        'id':'test-riku','speakerPid':2,'speakerName':'リクもどき','cpuKey':'rikumodoki',
        'text':'ピピさんの残り手札を確認。締切が近いです。進捗を更新してください。',
        'emotion':'normal','portraitPath':'./cpu_characters/spotlight/rikumodoki/normal.png',
        'bubbleStyle':'focus','animation':'side-in','eventType':'pickWatch'
    }),
]

results=[]
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True, executable_path='/usr/bin/chromium', args=['--allow-file-access-from-files'])
    for name,w,h,event in cases:
        page=browser.new_page(viewport={'width':w,'height':h}, device_scale_factor=1)
        errors=[]
        page.on('pageerror',lambda exc, errors=errors: errors.append(str(exc)))
        page.set_content(html, wait_until='load')
        errors.clear()
        event=dict(event)
        portrait_file=root/'public'/event['portraitPath'].lstrip('./')
        mime=mimetypes.guess_type(portrait_file.name)[0] or 'image/png'
        event['portraitPath']=f"data:{mime};base64,{base64.b64encode(portrait_file.read_bytes()).decode()}"
        event['startsAt']=0
        event['expiresAt']=10**15
        event['durationMs']=5000
        page.evaluate("""ev => {
          state={code:'TEST',round:1,totalRounds:3,phase:'playing',spotlightEvent:ev,players:[],commentary:[],trick:[],log:[],current:null,lead:null};
          __lastSpotlightEventId='';
          renderSpotlightOverlay();
        }""",event)
        page.wait_for_timeout(1800)
        card=page.locator('.spotlight-card')
        bubble=page.locator('.spotlight-bubble')
        portrait=page.locator('.spotlight-portrait')
        image=page.locator('.spotlight-portrait img')
        assert card.count()==1
        cb=card.bounding_box(); bb=bubble.bounding_box(); pb=portrait.bounding_box()
        assert cb and bb and pb
        tol=2
        assert cb['x']>=-tol and cb['y']>=-tol, (name,cb)
        assert cb['x']+cb['width']<=w+tol and cb['y']+cb['height']<=h+tol, (name,cb,w,h)
        metrics=page.evaluate("""() => {
          const b=document.querySelector('.spotlight-bubble');
          const t=document.querySelector('.spotlight-text');
          const img=document.querySelector('.spotlight-portrait img');
          return {
            bubbleScrollW:b.scrollWidth,bubbleClientW:b.clientWidth,
            bubbleScrollH:b.scrollHeight,bubbleClientH:b.clientHeight,
            textScrollW:t.scrollWidth,textClientW:t.clientWidth,
            naturalW:img?.naturalWidth||0,naturalH:img?.naturalHeight||0,
            bubbleRect:b.getBoundingClientRect().toJSON(),textRect:t.getBoundingClientRect().toJSON(),typed:t.textContent
          };
        }""")
        assert metrics['bubbleScrollW']<=metrics['bubbleClientW']+2,(name,metrics)
        assert metrics['textScrollW']<=metrics['textClientW']+2,(name,metrics)
        assert metrics['naturalW']>0 and metrics['naturalH']>0,(name,metrics)
        assert metrics['textRect']['top']>=metrics['bubbleRect']['top']-1,(name,metrics)
        assert metrics['textRect']['bottom']<=metrics['bubbleRect']['bottom']+1,(name,metrics)
        assert len(metrics['typed'])>0,(name,metrics)
        assert not errors,(name,errors)
        shot=out_dir/f'{name}_{w}x{h}.png'
        page.screenshot(path=str(shot),full_page=False)
        results.append({'case':name,'viewport':[w,h],'card':cb,'bubble':bb,'portrait':pb,'metrics':metrics,'screenshot':str(shot)})
        page.close()
    browser.close()

result_path=root/'BROWSER_SPOTLIGHT_V23_RESULT.json'
result_path.write_text(json.dumps({'result':'passed','cases':results},ensure_ascii=False,indent=2))
print(json.dumps({'result':'passed','cases':results},ensure_ascii=False))
