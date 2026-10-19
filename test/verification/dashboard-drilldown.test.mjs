import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
const read = path => readFileSync(new URL('../../'+path,import.meta.url),'utf8');
const main=read('workflow/main.mmd');
const graphIds=new Set(readdirSync(new URL('../../workflow/',import.meta.url)).filter(x=>x.endsWith('.mmd')));
const html=read('src/dashboard-html.ts');
const css=read('src/dashboard-style.ts');
test('presentation graph references only existing canonical Mermaid files',()=>{
 assert.match(main,/dashboard: presentation-only/);
 const targets=[...main.matchAll(/^click\s+\w+\s+href\s+"([\w-]+\.mmd)"/gm)].map(m=>m[1]);
 assert.ok(targets.length>=10);
 for(const path of targets)assert.ok(graphIds.has(path),`unbound graph ${path}`);
});
test('dashboard has history, deep link, maximize, zoom and safe SVG handling',()=>{
 for(const marker of ['history.pushState','workflowPath','popstate','graph-dialog','graph-zoom-in','graph-zoom-out','graph-dialog-close','sanitizeGraphSvg','securityLevel:\'strict\'','navigateGraph(next)'])assert.ok(html.includes(marker),marker);
 assert.match(html,/const elements=new Set\(/);
 assert.match(html,/attr\.namespaceURI\|\|!attributes\.has/);
});
test('interactive labels stay blue after graph palette and edge backgrounds remain transparent',()=>{
 assert.match(html,/node\.classList\.contains\('drillable'\)\?'#2367b1'/);
 assert.match(css,/\.edgeLabel[^\n]+fill:transparent !important/);
});
