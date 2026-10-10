import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';

const root=new URL('../e2e/scenarios/',import.meta.url);

test('all ten scenarios define an extractable canonical planner contract',async()=>{
 const files=(await readdir(root)).filter(name=>/^0(?:0[1-9]|10)-.*\.md$/.test(name));
 assert.equal(files.length,10);
 for(const file of files){
  const source=await readFile(new URL(file,root),'utf8');
  const match=source.match(/<!-- PLANNER-CONTRACT:START -->([\s\S]*?)<!-- PLANNER-CONTRACT:END -->/);
  assert.ok(match,`${file} must define planner contract`);
  assert.match(match[1],/Planner|Task|implementation/i);
 }
});
test('method-level injection contracts are structured and passed by the runner',async()=>{
 const prepare=await readFile(new URL('../e2e/runner/prepare-round.mjs',import.meta.url),'utf8');
 assert.match(prepare,/plannerContract\(\)/);
 assert.match(prepare,/repositoryBoundary\(scenario\)\+plannerContract\(\)/);
 for(const [scenario,method] of [['006-provider-quota-reroute.md','worker.codex.launch'],['007-projection-isolation-retry.md','github.projectLocalMerge']]){
  const source=await readFile(new URL(scenario,root),'utf8');
  assert.ok(source.includes('"--test-injection":{'));
  assert.ok(source.includes(`"method":"${method}"`));
 }
});
