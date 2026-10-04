const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const server = fs.readFileSync('server.js', 'utf8');
const html = fs.readFileSync('public/index.html', 'utf8');

function extractFunction(source, name){
  const start = source.indexOf(`function ${name}(`);
  assert(start >= 0, `${name} must exist`);
  const brace = source.indexOf('{', start);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for(let i = brace; i < source.length; i++){
    const ch = source[i];
    if(quote){
      if(escaped){ escaped = false; continue; }
      if(ch === '\\'){ escaped = true; continue; }
      if(ch === quote) quote = null;
      continue;
    }
    if(ch === '"' || ch === "'" || ch === '`'){ quote = ch; continue; }
    if(ch === '{') depth++;
    if(ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`could not extract ${name}`);
}

const context = {};
vm.runInNewContext(`${extractFunction(server, 'compactCpuComment')}; this.compactCpuComment=compactCpuComment;`, context);
const compact = context.compactCpuComment;

assert.strictEqual(
  compact('💧スートは失点が重いです。 12 💧を処理します。', 'card-danger'),
  '💧12を処理します。'
);
assert.strictEqual(
  compact('かももどきさん、ごめん！自由なら大胆にいくぞぉ〜✊🏻', 'card-play'),
  '大胆にいくぞぉ〜✊🏻'
);
assert.strictEqual(
  compact('リクもどきさんの袋から裏向きで1枚選びます。ピック工程に入ります。', 'pick'),
  '袋から裏向きで1枚ピックします。'
);
const longResult = compact('これはとても長い実況文章で、そのままではスマートフォンの実況欄から大きくはみ出してしまいます。', 'default');
assert([...longResult].length <= 25, 'compact commentary must fit the mobile character budget');

assert(server.includes('compactText:compactCpuComment(text, presentation.eventKey)'), 'server must send compactText');
assert(html.includes('class="commentary-full-text"'), 'client must retain full commentary');
assert(html.includes('class="commentary-compact-text"'), 'client must render compact commentary');
assert(html.includes('aria-label="${escAttr(c.text)}"'), 'full text must remain available to assistive technology');
assert(/ui-phone-portrait[\s\S]*commentary-compact-text\{display:inline!important\}/.test(html), 'portrait phones must show compact commentary');
assert(/-webkit-line-clamp:2!important/.test(html), 'portrait commentary must allow two lines');
assert(/max-height:650px[\s\S]*white-space:nowrap!important/.test(html), 'short portrait screens must use one-line compact fallback');

console.log('commentary readability regression: all assertions passed');
