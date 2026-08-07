'use strict';
const fs=require('fs');
const path=require('path');
const assert=require('assert');
const root=path.resolve(__dirname,'..');
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
const dialogue=fs.readFileSync(path.join(root,'cpu_personality_dialogue.js'),'utf8');

assert.match(server,/function personaContextText\(/,'server must normalize persona template values');
assert.match(server,/card:personaContextText\(rawCtx\.card, 'この札', \{cardLike:true\}\)/,'card context must be formatted after merge');
assert.match(server,/drawn:personaContextText\(rawCtx\.drawn, 'この札', \{cardLike:true\}\)/,'drawn context must be formatted after merge');
assert.doesNotMatch(server,/card:ctx\.card \? cardText\(ctx\.card\)[\s\S]*?\}, ctx \|\| \{\}\)/,'raw ctx must not overwrite formatted card values');
assert.match(dialogue,/function safeTemplateValue\(/,'dialogue renderer needs a defensive object formatter');

const expected=[
  ['joker',/if\(drawn\?\.joker\) return \{delayMs:3100,durationMs:SPOTLIGHT_DISPLAY_MS\}/],
  ['pair',/if\(paired\) return \{delayMs:1950,durationMs:SPOTLIGHT_DISPLAY_MS\}/],
  ['mad',/isMadPig\(drawn\)\) return \{delayMs:2450,durationMs:SPOTLIGHT_DISPLAY_MS\}/],
  ['normal',/return \{delayMs:100,durationMs:SPOTLIGHT_DISPLAY_MS\}/]
];
assert.match(server,/const SPOTLIGHT_DISPLAY_MS = 2200;/,'spotlight duration must be unified at 2.2 seconds');
for(const [label,re] of expected) assert.match(server,re,`${label} spotlight must use the unified 2.2-second duration`);
assert.match(server,/if\(result\?\.drawn\?\.joker\) return 5700;/);
assert.match(server,/if\(result\?\.paired\) return 4600;/);
assert.match(server,/isMadPig\(result\?\.drawn\)\) return 5100;/);
assert.match(server,/return 2800;/);
console.log('dialogue object context regression: all assertions passed');
