import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../e2e/sentinel.mjs', import.meta.url), 'utf8');
const definition = source.slice(source.indexOf('function detect('), source.indexOf('\nlet working=false;'));
function detect(job, ageMs) {
  const state = { lastEventAt: new Date(Date.now()-ageMs).toISOString() };
  return runInNewContext(`${definition}\ndetect(job,{state:'OPEN'})`, { job, state, staleMs: 240000, Date, Math, Number, JSON });
}
test('E2E watcher does not call an active 15-minute review stalled after four minutes', () => {
  const job={state:'ACTIVE',tasks:[{id:'review',state:'RUNNING',timeoutMs:900000,updatedAt:new Date(Date.now()-300000).toISOString()}]};
  assert.equal(detect(job, 300000),null);
  job.tasks[0].updatedAt=new Date(Date.now()-950000).toISOString();
  assert.equal(detect(job, 950000).type,'STALLED');
});
