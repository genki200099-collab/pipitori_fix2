'use strict';
const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const dialogue=require(path.join(root,'cpu_personality_dialogue.js'));
const html=fs.readFileSync(path.join(root,'public/index.html'),'utf8');
assert(dialogue.PERSONA_PROFILES.nakato_modoki,'new CPU persona exists');
assert(dialogue.DIALOGUE_POOLS.nakato_modoki,'new CPU dialogue exists');
assert(dialogue.COMMON_EVENTS.every(event=>dialogue.DIALOGUE_POOLS.nakato_modoki.events[event]?.length || dialogue.DIALOGUE_POOLS.nakato_modoki.events.normal?.length),'new persona covers all events');
for(const event of dialogue.COMMON_EVENTS){
  for(let i=0;i<12;i++){
    const line=dialogue.createPersonaLine('nakato_modoki',event,{target:'相手',winner:'勝者',weakest:'最弱',card:'💧11',drawn:'ババブタ',round:2,remaining:2},[]);
    assert(line && [...line].length<=86,`readable ${event} line`);
  }
  const face=dialogue.getSpotlightPresentation('nakato_modoki',event);
  assert(fs.existsSync(path.join(root,'public/cpu_characters/spotlight/nakato_modoki',face.imageFile)),`portrait for ${event}`);
}
assert(html.includes('<option value="nakato_modoki">なかとーもどき</option>'),'lobby selector includes new CPU');
assert(html.includes("characterKey:$('cpuCharacterSelect')?.value || 'auto'"),'selection is sent to server');
assert(html.includes('Number(state.playerSeatCapacity || 4)'),'CPU availability follows selected table capacity');
console.log('nakato-modoki CPU selection, dialogue, portraits and lobby regression: all assertions passed');
