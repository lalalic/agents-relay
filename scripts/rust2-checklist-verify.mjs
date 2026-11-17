// New rust2 migration gate: verify that every baseline Node file has one checklist row and every PASS maps to documented Rust source.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const baseline = '234a8151fe0fe616c39c0109b4b014326044e17e';
const mainBaseline = 'ba22e4cbdfa68cdd4ccb08dc7e02df49b57e7a90';
const inventory = ref => execFileSync('git', ['ls-tree', '-r', '--name-only', ref, 'src'], {cwd: root, encoding: 'utf8'})
  .split('\n').filter(x => /\.(?:ts|js)$/.test(x));
const historicalSources = inventory(baseline);
const currentSources = inventory(mainBaseline);
const sources = [...new Set([...historicalSources,...currentSources])];
const doc = readFileSync(resolve(root, 'docs/RUST2_HEAD_TO_HEAD_CHECKLIST.md'), 'utf8');
const rows = [...doc.matchAll(/^\| `(src\/[^`]+\.(?:ts|js))` \| `(rust\/src\/[^`]+\.rs)` \| (PENDING|PORTING|PASS|EXCLUDED) \| ([^\n]+) \|$/gm)]
  .map(([,source,target,status,evidence])=>({source,target,status,evidence}));
assert.equal(rows.length,sources.length,'Checklist row count does not match pinned Node baseline');
const seen = new Set();
for(const row of rows){
 assert(sources.includes(row.source),`Unrecognized Node file in checklist: ${row.source}`);
 assert(!seen.has(row.source),`Duplicate Node checklist row: ${row.source}`);
 seen.add(row.source);
 const expectTarget = 'rust/src/' + row.source.slice(4).replace(/\.(ts|js)$/,'.rs').replaceAll('-','_');
 assert.equal(row.target,expectTarget,`Incorrect target path for ${row.source}`);
 if (row.status==='EXCLUDED') {
  // dashboard-html.ts remains as the Node-side compatibility projection for
  // the shared PWA. EXCLUDED means no second Rust browser HTML renderer, not
  // that this wrapper must be removed from the Node runtime.
  if (row.source==='src/dashboard-html.ts') {
   assert(currentSources.includes(row.source),'PWA compatibility source missing in pinned main');
   const wrapper=readFileSync(resolve(root,row.source),'utf8');
   assert.match(wrapper,/dashboardIndexHtml = readFileSync/);
   assert.match(wrapper,/dashboardClientJs = readFileSync/);
   assert(existsSync(resolve(root,'dashboard/index.html')));
   assert(existsSync(resolve(root,'dashboard/dashboard.js')));
  } else {
   assert(!currentSources.includes(row.source),`EXCLUDED file remains active in main: ${row.source}`);
   assert(!existsSync(resolve(root,row.source)),`EXCLUDED file still on disk: ${row.source}`);
  }
  assert(!/^\s*(?:—|-)\s*$/.test(row.evidence),`EXCLUDED without removal evidence: ${row.source}`);
  continue;
 }
 assert(currentSources.includes(row.source),`Active Node file absent from pinned main: ${row.source}`);
 assert(existsSync(resolve(root,row.source)),`Tracked active source is absent: ${row.source}`);
 if(row.status==='PASS') {
  const file=resolve(root,row.target);
  assert(existsSync(file),`PASS source has no Rust target: ${row.target}`);
  const first=readFileSync(file,'utf8').split('\n')[0];
  assert(first.startsWith('//')&&first.includes(row.source),`PASS Rust source missing Node provenance comment: ${row.target}`);
  assert(!/^\s*(?:—|-)\s*$/.test(row.evidence),`PASS without evidence: ${row.source}`);
  // Check all runtime exports, not only that a Rust source file exists. A
  // nominal PASS with omitted public functions/classes is not head-to-head.
  const nodeText=readFileSync(resolve(root,row.source),'utf8');
  const rustText=readFileSync(file,'utf8');
  const runtimeExport=/\bexport\s+(?:(?:declare|async)\s+)?(function|class|const|enum)\s+([A-Za-z_$][\w$]*)/g;
  for(const [,kind,symbol] of nodeText.matchAll(runtimeExport)){
    const snake=symbol.replace(/([a-z0-9])([A-Z])/g,'$1_$2').replace(/([A-Z])([A-Z][a-z])/g,'$1_$2').toLowerCase();
    // Rust naming may collapse proper-name acronyms that JS spells as two
    // capitalized words (GitHub -> github, ChatGPT -> chatgpt).
    const idiomatic=snake.replaceAll('git_hub','github').replaceAll('chat_gpt','chatgpt');
    const candidate=kind==='class'?[symbol]:kind==='const'?[snake,idiomatic,symbol]:[snake,idiomatic];
    assert(candidate.some(name=>new RegExp(`\\bpub\\s+(?:async\\s+)?(?:fn|struct|const|static|enum)\\s+${name}\\b`).test(rustText)),
      `PASS Rust source missing Node runtime export ${symbol}: ${row.target}`);
  }
 }
}
for(const source of sources) assert(seen.has(source),`Missing source from checklist: ${source}`);
const counts=rows.reduce((acc,row)=>(acc[row.status]++,acc),{PASS:0,PORTING:0,PENDING:0,EXCLUDED:0});
console.log(`Rust2 migration ledger validated: ${rows.length} baseline files; PASS=${counts.PASS} PORTING=${counts.PORTING} PENDING=${counts.PENDING} EXCLUDED=${counts.EXCLUDED}`);
