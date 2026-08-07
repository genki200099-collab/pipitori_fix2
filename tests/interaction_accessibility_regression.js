'use strict';
const fs=require('fs');
const path=require('path');
const assert=require('assert');

const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'public','index.html'),'utf8');
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');

assert.match(html,/function shouldHandleActionEvent\(ev, key\)/,'shared activation guard missing');
assert.match(html,/ev\.pointerType === 'mouse' && ev\.button !== 0/,'non-primary mouse pointer guard missing');
assert.match(html,/ev\.detail === 0\) return true/,'keyboard click activation must remain enabled');
assert.match(html,/function scheduleActionRecovery\(key, guard, restore, delay=4500\)/,'action timeout recovery missing');
assert.match(html,/scheduleActionRecovery\('pick'/,'pick recovery missing');
assert.match(html,/scheduleActionRecovery\('pair'/,'pair recovery missing');
assert.match(html,/scheduleActionRecovery\('pick-target'/,'pick-target recovery missing');
assert.match(html,/scheduleActionRecovery\('pass-three'/,'pass-three recovery missing');
assert.match(html,/scheduleActionRecovery\('initial-pair'/,'initial-pair recovery missing');
assert.match(html,/aria-label="裏向きのピック候補 \$\{i\+1\}枚目を選ぶ"/,'hidden pick candidates need accessible names');
assert.match(html,/aria-pressed="\$\{selected\?'true':'false'\}"/,'selection buttons need pressed state');
assert.match(html,/data-player-avatar-fallback/,'avatar fallback metadata missing');
assert.match(html,/document\.addEventListener\('error',[\s\S]*img\.replaceWith\(fallback\)/,'avatar error fallback missing');
assert.match(html,/\.hud-button\{min-width:44px!important;min-height:40px!important/,'HUD touch targets were not enlarged');
assert.match(html,/\.hand-view-toggle\{min-height:36px!important;min-width:60px!important/,'hand toggle touch target was not enlarged');

assert.match(server,/const progressWatchdogTimer=setInterval/,'watchdog handle missing');
assert.match(server,/progressWatchdogTimer\.unref\?\.\(\)/,'watchdog should not pin process');
assert.match(server,/room\.cleanupTimer\.unref\?\.\(\)/,'room cleanup timer should not pin process');
assert.match(server,/room\.pickFinishTimer\.unref\?\.\(\)/,'pick finish timer should not pin process');
assert.match(server,/room\.reviewTimer\.unref\?\.\(\)/,'review timer should not pin process');
assert.match(server,/room\.cpuPickTimer\.unref\?\.\(\)/,'CPU pick timer should not pin process');
assert.match(server,/room\.cpuTimer\.unref\?\.\(\)/,'CPU play timer should not pin process');
assert.match(server,/ピック準備中です。あと\$\{remaining\}秒お待ちください。/,'early pick feedback missing');

console.log('interaction + accessibility regression: all assertions passed');
