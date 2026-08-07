'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const publicDir = path.join(root, 'public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(publicDir, 'site.webmanifest'), 'utf8'));

function pngDimensions(file) {
  const b = fs.readFileSync(file);
  assert.strictEqual(b.toString('hex', 0, 8), '89504e470d0a1a0a', `${file} is not PNG`);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

assert.match(html, /rel="manifest" href="\/site\.webmanifest\?v=17"/);
assert.match(html, /rel="apple-touch-icon" sizes="180x180" href="\/apple-touch-icon\.png\?v=17"/);
assert.match(html, /rel="icon" href="\/favicon\.ico\?v=17"/);
assert.match(html, /name="apple-mobile-web-app-title" content="ピピトリ"/);
assert.match(server, /'\.webmanifest':'application\/manifest\+json; charset=utf-8'/);

assert.deepStrictEqual(pngDimensions(path.join(publicDir, 'apple-touch-icon.png')), [180,180]);
assert.deepStrictEqual(pngDimensions(path.join(publicDir, 'app-icon-192.png')), [192,192]);
assert.deepStrictEqual(pngDimensions(path.join(publicDir, 'app-icon-512.png')), [512,512]);
assert.deepStrictEqual(pngDimensions(path.join(publicDir, 'app-icon-1024.png')), [1024,1024]);
const ico = fs.readFileSync(path.join(publicDir, 'favicon.ico'));
assert.strictEqual(ico.readUInt16LE(0), 0);
assert.strictEqual(ico.readUInt16LE(2), 1);
assert.ok(ico.readUInt16LE(4) >= 4, 'favicon should contain multiple sizes');

assert.strictEqual(manifest.short_name, 'ピピトリ');
assert.strictEqual(manifest.display, 'standalone');
assert.strictEqual(manifest.theme_color, '#052f31');
assert.ok(manifest.icons.some(i => i.sizes === '192x192'));
assert.ok(manifest.icons.some(i => i.sizes === '512x512' && /maskable/.test(i.purpose || '')));
console.log('app icon regression: all assertions passed');
