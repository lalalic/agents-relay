import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('./dashboard.js',import.meta.url),'utf8');
const code=source.match(/async function refreshVersion\(\)\{[^\n]+\}/)[0];
test('release revision changes reload even with the same semver; same identity does not',async()=>{
  for(const [live,expected] of [
    [{version:'2.0.259',sourceRef:'a'.repeat(40)},0],
    [{version:'2.0.259',sourceRef:'b'.repeat(40)},1],
    [{version:'2.0.260',sourceRef:'a'.repeat(40)},1],
    [{version:'2.0.259'},0]
  ]){
    let reloads=0;
    const context={loadJSON:async()=>live,RELAY_PREFIX:'',DASHBOARD_VERSION:'2.0.259',
      WORKFLOW_SOURCE_REF:'a'.repeat(40),location:{reload(){reloads++}}};
    await vm.runInNewContext(code+';refreshVersion()',context);
    assert.equal(reloads,expected);
  }
});
