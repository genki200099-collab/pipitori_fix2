const fs=require('fs');
const path=require('path');
const assert=require('assert');
const root=path.resolve(__dirname,'..');
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
const html=fs.readFileSync(path.join(root,'public','index.html'),'utf8');

function num(re){ const m=server.match(re); assert(m,`missing ${re}`); return Number(m[1]); }
const unifiedDuration=num(/const SPOTLIGHT_DISPLAY_MS = (\d+);/);
const pick={joker:num(/if\(result\?\.drawn\?\.joker\) return (\d+);/),pair:num(/if\(result\?\.paired\) return (\d+);/),mad:num(/isMadPig\(result\?\.drawn\)\) return (\d+);/)};
const timing={
 joker:[num(/if\(drawn\?\.joker\) return \{delayMs:(\d+),durationMs:SPOTLIGHT_DISPLAY_MS\}/),unifiedDuration],
 pair:[num(/if\(paired\) return \{delayMs:(\d+),durationMs:SPOTLIGHT_DISPLAY_MS\}/),unifiedDuration],
 mad:[num(/isMadPig\(drawn\)\) return \{delayMs:(\d+),durationMs:SPOTLIGHT_DISPLAY_MS\}/),unifiedDuration]
};
assert.strictEqual(unifiedDuration,2200,'all spotlight dialogue must display for 2.2 seconds');
const fade=280;
assert(timing.joker[0]+timing.joker[1]+fade < pick.joker,'joker spotlight must finish before next trick');
assert(timing.pair[0]+timing.pair[1]+fade < pick.pair,'pair spotlight must finish before next trick');
assert(timing.mad[0]+timing.mad[1]+fade < pick.mad,'mad spotlight must finish before next trick');
assert.match(html,/remainingMs<=280 \|\| remainingMs<=waitMs\+220/,'late/reconnected events must be skipped');
assert.match(html,/Math\.max\(280,\s*Math\.min\(Number\(ev\.durationMs/,'client duration must use remaining server lifetime');
assert.match(html,/window\.clearTimeout\(window\.__spotlightStartTimer\);\n  __scheduledSpotlightEventId='';/,'stale delayed start timer must be cancelled');
assert.match(html,/portraitImg\.addEventListener\('error'/,'portrait load failure needs fallback');
assert.match(server,/room\.pendingSpotlightPlans = null;/,'pending plans must be cleared');
assert.match(server,/spotlightEvent:null, pendingSpotlightPlans:null/,'new rooms must initialize spotlight state');

assert.match(server,/room\.spotlightEvent = null;[\s\S]*?room\.pendingSpotlightPlans = null;[\s\S]*?room\.pendingPick = null;/,'round end clears spotlight');
assert.match(html,/if\(state\.phase!==\'playing\' \|\| !ev\)/,'spotlight suppressed outside play');
assert.match(html,/spotlight-visually-hidden/,'one full accessibility announcement');
assert.match(html,/spotlight-card\" aria-hidden=\"true\"/,'typed fragments hidden from AT');
assert.match(html,/root\.dataset\.eventId=key/,'active event tracked');
assert.match(html,/function clearSpotlightOverlay/,'single cleanup path');

console.log('spotlight flow regression: all assertions passed');
