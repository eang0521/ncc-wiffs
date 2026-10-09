// Cache-busting for GitHub Pages (which serves files with a 10-minute cache).
// Rewrites index.html so every local module, the stylesheet and the entry script are requested with
// a ?v=<content hash> query. Only files whose contents changed get a new URL.
// Run before committing:  node tools/stamp.mjs
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const hash = (file) => createHash('sha1').update(readFileSync(join(root, file))).digest('hex').slice(0, 10);
const walk = (dir) => readdirSync(join(root, dir)).flatMap((n) => {
  const rel = `${dir}/${n}`;
  return statSync(join(root, rel)).isDirectory() ? walk(rel) : rel.endsWith('.js') ? [rel] : [];
});

const files = walk('js').map((f) => relative(root, join(root, f)).replace(/\\/g, '/')).sort();
const imports = {
  three: 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js',
  'three/addons/': 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/',
};
for (const f of files) imports[`./${f}`] = `./${f}?v=${hash(f)}`;

const htmlPath = join(root, 'index.html');
let html = readFileSync(htmlPath, 'utf8');
const map = JSON.stringify({ imports }, null, 2).split('\n').map((l) => '    ' + l).join('\n');
html = html.replace(/<script type="importmap">[\s\S]*?<\/script>/, `<script type="importmap">\n${map}\n  </script>`);
html = html.replace(/<script type="module" src="js\/main\.js(\?v=[^"]*)?"><\/script>/, `<script type="module" src="js/main.js?v=${hash('js/main.js')}"></script>`);
html = html.replace(/<link rel="stylesheet" href="css\/style\.css(\?v=[^"]*)?" \/>/, `<link rel="stylesheet" href="css/style.css?v=${hash('css/style.css')}" />`);
writeFileSync(htmlPath, html);
console.log(`stamped ${files.length} modules + style.css`);
