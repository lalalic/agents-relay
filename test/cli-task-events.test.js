import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

test('task events CLI returns only Task-scoped history through the supported command', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-cli-task-events-'));
  const fixture = join(dir, 'job.json');
  const event = { version: 1, event_id: 'ev1', job_id: 'job1', task_id: 't1',
    parent_task_id: null, type: 'task.failed', status: 'failed',
    timestamp: '2026-11-01T17:00:00Z', visibility: 'orchestrator',
    level: 'error', message: 'test failure' };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    assert.equal(url.pathname, '/events');
    assert.equal(url.searchParams.get('job'), 'job1');
    assert.equal(url.searchParams.get('task'), 't1');
    assert.equal(url.searchParams.get('limit'), '2');
    res.writeHead(200, {'content-type':'application/json'});
    res.end(JSON.stringify({events:[{event},{event:{...event,job_id:'other'}}]}));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    await writeFile(fixture, JSON.stringify({
      id:'job1',repository:'example/repo',title:'test',objective:'test',state:'ACTIVE',
      prNumber:0,continuation:null,tasks:[{id:'t1',jobId:'job1',title:'failed task',
        kind:'work',state:'FAILED',parentTaskId:null,dependencies:[],output:{kind:'task_pr'},
        attempt:1,maxAttempts:1}],plans:[],
    }));
    const args=['dist/cli.js','task','events','--file',fixture,'--id','job1',
      '--task-id','t1','--limit','2'];
    const result=await run(process.execPath,args,{cwd:process.cwd(),
      env:{...process.env, NEO_EVENTS_API_URL:`http://127.0.0.1:${address.port}`},
      timeout:10000});
    const output=JSON.parse(result.stdout);
    assert.equal(output.jobId,'job1');
    assert.equal(output.taskId,'t1');
    assert.equal(output.order,'newest-first');
    assert.deepEqual(output.events.map(e=>e.event_id),['ev1']);
    await assert.rejects(run(process.execPath,
      args.map(a=>a==='t1'?'missing':a),{cwd:process.cwd(),timeout:10000}),
      /Task missing not found/);
    await assert.rejects(run(process.execPath,
      args.map(a=>a==='2'?'100':a),{cwd:process.cwd(),timeout:10000}),
      /task events --limit must be an integer/);
  } finally {
    await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
    await rm(dir,{recursive:true,force:true});
  }
});
