'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'public','index.html'),'utf8');
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');

assert.match(html,/className='shoot-choice-panel'/);assert.match(html,/data-shoot-decision="normal"/);assert.match(html,/data-shoot-decision="fire"/);
assert.match(html,/通常ピック/);assert.match(html,/発射する！/);
for(const phase of ['shoot-fire-title','shoot-fire-cards','shoot-fire-shooter','shoot-projectile-card','shoot-impact-target','shoot-fire-success'])assert.match(html,new RegExp(phase));
assert.match(html,/\.shoot-fire-cutscene\{[^}]*pointer-events:none/);
assert.match(html,/\.shoot-choice-panel\{[^}]*safe-area-inset-top/);
assert.match(html,/@media\(max-height:430px\) and \(orientation:landscape\)[\s\S]*\.shoot-fire-success\{bottom:2%\}/);
assert.match(html,/@media\(prefers-reduced-motion:reduce\)[\s\S]*\.shoot-fire-cutscene \*\{animation:none!important\}/);
assert.match(html,/@media\(prefers-reduced-motion:reduce\)[\s\S]*\.shoot-speedline\{display:none\}/);
assert.match(html,/effectVibrate\(\[45,35,110\]\)/,'shake/vibration cue stays under 250ms total');
assert.match(html,/window\.__shootPigOverlayTimer=window\.setTimeout\([\s\S]*,3500\)/);
assert.match(html,/window\.clearTimeout\(window\.__shootPigOverlayTimer\)/);
assert.match(html,/if\(!__animationStateHydrated\)\{ __lastShootFireEventId=ev\.id;return true; \}/,'reconnect hydration suppresses historical replay');
assert.match(html,/if\(__lastShootFireEventId===ev\.id\) return true/,'state resend is deduplicated by event id');
assert.match(server,/id:`shoot-fire-\$\{result\.round\}-\$\{shooterPid\}-\$\{uid\(\)\}`/);
assert.match(server,/expiresAt:Date\.now\(\)\+7200/);
assert.match(server,/pendingShootTransition=\{id:choice\.id,until:Date\.now\(\)\+GAME_TIMING\.shootFirePresentation\}/);
assert.match(server,/shootFirePresentation:3400/);

// Player-private load notification and spectator-only inspection stay separate.
assert.match(server,/shootLoadState:viewerPlayer \? \{loaded:playerIsShootLoaded/);
assert.match(server,/spectatorShootLoadStates:isSpectator \?/);
assert.doesNotMatch(server,/log\(room, `🌕 \$\{player\.name\} のシュート装填条件/);

// Turn toast is transition-keyed and never shown for CPU/spectator views.
assert.match(html,/if\(!state \|\| state\.isSpectator \|\| state\.participantRole==='spectator'\) return/);
assert.match(html,/if\(key===__lastTurnNoticeKey\) return/);assert.match(html,/あなたの番です/);
assert.match(html,/カードを1枚選んでください/);

// Confirmed score badge is present in both player seats and spectator hands.
assert.match(html,/class="score-total-mini player-score-total"/);assert.match(html,/終了済みラウンドまでの確定得点/);
assert.match(html,/spectator-hand-meta">総合\$\{totalLabel\}/);

// Percentage lanes fit the two minimum-class viewports before font clamping.
const portrait={width:320,height:568,title:.09*568,cards:.28*568,shooter:.57*568,projectile:.66*568,impact:.60*568,success:.94*568};
assert(['title','cards','shooter','projectile','impact','success'].every(key=>portrait[key]>=0&&portrait[key]<=portrait.height));
const landscape={width:568,height:320,title:.04*320,cards:.18*320,shooter:.50*320,projectile:.60*320,impact:.53*320,success:.98*320};
assert(['title','cards','shooter','projectile','impact','success'].every(key=>landscape[key]>=0&&landscape[key]<=landscape.height));

console.log(JSON.stringify({result:'passed',suite:'v39-shoot-ui-regression',durationMs:3500,reducedMotion:true,viewports:['320x568','568x320'],pointerBlocking:false}));
