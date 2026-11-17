// Node source: src/**/*.ts; Rust targets: rust/src/**/*.rs.
// Verify the static Rust2 PORTING API matrix is complete, reproducible, and
// never confuses a textual symbol/test reference with semantic parity.
import test from './test-runtime.js';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';

const root=resolve(import.meta.dirname,'..');
const read=path=>readFileSync(join(root,path),'utf8');
const report=JSON.parse(read('docs/RUST2_API_PARITY_MATRIX.json'));
const rows=[...read('docs/RUST2_HEAD_TO_HEAD_CHECKLIST.md').matchAll(
  /^\| `(src\/[^\x60]+\.(?:ts|js))` \| `(rust\/src\/[^\x60]+\.rs)` \| (PENDING|PORTING|PASS|EXCLUDED) \| ([^\n]+) \|$/gm)];
const porting=rows.filter(row=>row[3]==='PORTING');

test('every PORTING file has a unique source, Rust target, and API inventory',()=>{
  assert.equal(report.files.length,porting.length);
  assert.equal(report.summary.sourceCount,porting.length);
  assert.deepEqual(report.files.map(f=>f.source),porting.map(row=>row[1]));
  for(const file of report.files){
    assert(existsSync(join(root,file.source)),file.source);
    assert(existsSync(join(root,file.target)),file.target);
    assert.equal(file.ledgerStatus,'PORTING');
    assert.equal(file.runtimeExports,
      file.exports.filter(x=>['function','class','class-method','class-constructor','variable','enum'].includes(x.kind)).length);
    assert.equal(file.runtimeExports,
      file.directNameMatches+file.unmappedRuntime.length+
      file.exports.filter(x=>x.kind==='class-constructor'&&x.static==='review').length);
    for(const ref of file.directDiffImports)assert(existsSync(join(root,ref)),ref);
  }
});
test('AST captures methods and top-level exports, not only regex function names',()=>{
  const adapters=report.files.find(file=>file.source==='src/adapters.ts');
  assert(adapters);
  assert(adapters.exports.some(x=>x.kind==='function'&&x.name==='buildCodexArgs'));
  assert(adapters.exports.some(x=>x.kind==='class'&&x.name==='CodexAdapter'));
  assert(adapters.exports.some(x=>x.kind==='class-method'&&x.name==='launch'&&x.parent==='CodexAdapter'));
  assert(adapters.exports.some(x=>x.kind==='interface'&&x.name==='WorkerAdapter'));
  assert(adapters.directDiffImports.includes('rust/tests/head_to_head_stage2_pool_adapters.mjs'));
  const daemon=report.files.find(file=>file.source==='src/relayd.ts');
  assert(daemon.exports.some(x=>x.kind==='function'&&x.name==='runDaemon'));
});
test('generated report is deterministic against the current source trees',()=>{
  assert.equal(report.summary.sourceTree,execFileSync('git',['rev-parse','HEAD:src'],{cwd:root,encoding:'utf8'}).trim());
  assert.equal(report.summary.rustTree,execFileSync('git',['rev-parse','HEAD:rust/src'],{cwd:root,encoding:'utf8'}).trim());
  assert.equal(report.summary.unmappedRuntimeSymbols,report.files.reduce((sum,f)=>sum+f.unmappedRuntime.length,0));
  execFileSync('node',['scripts/rust2-api-parity-audit.mjs','--check'],{cwd:root,stdio:'pipe',timeout:30000});
});
