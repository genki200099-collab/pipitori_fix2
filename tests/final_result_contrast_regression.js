'use strict';
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function must(pattern, message){
  if(!pattern.test(html)) throw new Error(message);
}

must(/v31 Final result contrast and light-surface text safety/, 'v31 contrast safety CSS is missing');
must(/body\.finished-mode \.score-screen > h2\s*\{[^}]*color:#fff4e8!important/s, 'final-result title must use a high-contrast light color');
must(/body\.finished-mode \.final-stage\s*\{[^}]*color:#3b251d!important/s, 'final-stage must opt into a dark foreground palette');
must(/body\.finished-mode \.final-stage \.break-row span\s*\{[^}]*color:#6b493d!important/s, 'breakdown labels need an explicit dark color');
must(/body\.finished-mode \.final-stage \.break-row b\s*\{[^}]*color:#281713!important/s, 'breakdown values need an explicit dark color');
must(/body\.finished-mode \.final-stage table\.score th\s*\{[^}]*color:#5d2630!important/s, 'score headers need an explicit dark color');
must(/body\.finished-mode \.final-stage table\.score td\s*\{[^}]*color:#3a251e!important/s, 'score cells need an explicit dark color');

const finalContrastSection = html.split('v31 Final result contrast and light-surface text safety')[1] || '';
if(/color:\s*(?:#fff|white|rgb\(23[6-9],\s*25[0-9],\s*24[0-9]\))/i.test(finalContrastSection.match(/body\.finished-mode \.final-stage[\s\S]*?<\/style>/)?.[0] || '')){
  // White is allowed for the winner score badge, but not as the stage default.
  if(/body\.finished-mode \.final-stage\s*\{[^}]*color:\s*(?:#fff|white)/i.test(finalContrastSection)){
    throw new Error('final-stage default foreground regressed to white');
  }
}

console.log('final result contrast regression: passed');
