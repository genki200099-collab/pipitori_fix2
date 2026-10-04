'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path'),vm=require('vm'),{JSDOM}=require('jsdom');
const root=path.resolve(__dirname,'..'),source=fs.readFileSync(process.env.V46_UI_SOURCE || path.join(root,'public/index.html'),'utf8');
const main=[...source.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)][0][1];
const fixtures=JSON.parse(fs.readFileSync(path.join(root,'qa/v44/browser-fixtures.json')));
const rows=[];
for(const width of [320,375,390,430,768,1024,1440]){
 const dom=new JSDOM(source.replace(/<style[^>]*>[\s\S]*?<\/style>/g,'').replace(/<script[^>]*>[\s\S]*?<\/script>/g,''),{url:'http://localhost/',runScripts:'outside-only'}),w=dom.window,d=w.document,context=dom.getInternalVMContext();
 const run=s=>new vm.Script(s).runInContext(context);w.innerWidth=width;w.innerHeight=844;w.setInterval=()=>0;w.requestAnimationFrame=()=>0;w.scrollTo=()=>{};w.matchMedia=()=>({matches:false});w.getComputedStyle=()=>({fontSize:'16px'});
 try{
 run(main);
 for(const count of [3,4,5])for(let viewer=0;viewer<count;viewer++){
 run(`(${fixtures.BASE})();state.playerSeatCapacity=${count};state.playerCount=${count};state.cardsPerPlayer=Math.floor(52/${count});state.players=state.players.slice(0,${count});while(state.players.length<${count})state.players.push({...state.players[1],id:'C4',name:'なかとーもどき',cpuKey:'nakato_modoki'});state.yourIndex=${viewer};state.you=state.players[${viewer}].id;state.current=0;__lastTableRenderKey='';__lastPlayersRenderKey='';renderPlayers();renderTable();`);
 const players=[...d.querySelectorAll('#players [data-player-pid]')],slots=[...d.querySelectorAll('#table [data-trick-pid]')];
 assert.equal(players.length,count);assert.equal(slots.length,count);assert.equal(d.querySelectorAll('#table .multiplayer-trick-slots').length,count===4?0:1,'scroll only the cards, preserve outside result banner');
 assert.equal(new Set(slots.map(e=>e.className.match(/slot-(\S+)/)[1])).size,count,'one distinct relative position per participant');
 for(const slot of slots){const pid=slot.dataset.trickPid;const player=players.find(p=>p.dataset.playerPid===pid);const position=player.className.match(/position-(\S+)/)[1];assert(slot.classList.contains('slot-'+position),'table and player seat agree');}
 for(const provider of ['winner','weakest']){
  run(`state.pickProviderRole='${provider}';`);assert.equal(run('primaryPickLabel()'),provider==='winner'?`1位→${count}位`:`${count}位→1位`);
 }
 run(`setStartRequestUi(false);`);assert.equal(d.getElementById('start').textContent,`${count}人で遊ぶ`);
 run(`state=null;`);d.getElementById('playerCount').value=String(count);run('syncPlayerCountUi();');assert.equal(d.getElementById('enableMiddleRankPick').disabled,count===3);assert(d.getElementById('playerCountHint').textContent.includes(`${Math.floor(52/count)}枚`));
 rows.push({width,count,viewer,seatIdentity:'passed',direction:'passed',startRetry:'passed',settings:'passed',renderedLayout:'not_checked'});
 }
 }finally{dom.window.close();}
}
const result={result:'passed',method:'DOM behavior; no rendered layout',cases:rows.length,rows};fs.writeFileSync(path.join(root,'qa/v46/multiplayer-ui.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({result:'passed',cases:rows.length,widths:[320,375,390,430,768,1024,1440],renderedLayout:'not_checked'}));
