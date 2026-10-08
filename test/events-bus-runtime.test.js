import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { resolveEventsBusRuntime, eventsBusHistory } from '../dist/events-bus-runtime.js';

test('Relay discovers NATS and API endpoints from events-bus runtime config', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'relay-events-config-'));
  const configPath=path.join(dir,'runtime.json');
  await writeFile(configPath, JSON.stringify({natsUrl:'nats://127.0.0.1:5222',apiUrl:'http://127.0.0.1:5223',subjectPrefix:'test.events'}));
  const runtime=resolveEventsBusRuntime({NEO_EVENTS_BUS_CONFIG:configPath});
  assert.equal(runtime.natsUrl,'nats://127.0.0.1:5222');
  assert.equal(runtime.apiUrl,'http://127.0.0.1:5223');
  assert.equal(runtime.subjectPrefix,'test.events');
});

test('Relay history client reads events-bus API and returns newest requested events', async () => {
  const rows=Array.from({length:4},(_,i)=>({cursor:i+1,subject:`x.${i+1}`,event:{version:1,event_id:`e${i+1}`,job_id:'job1',task_id:'task1',parent_task_id:null,type:'progress',status:'running',timestamp:new Date(1000+i).toISOString(),visibility:'orchestrator',level:'info',message:`m${i+1}`}}));
  const server=http.createServer((req,res)=>{const url=new URL(req.url,'http://127.0.0.1'); assert.equal(url.searchParams.get('order'),'desc'); assert.equal(url.searchParams.get('limit'),'2'); res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({job_id:'job1',events:[rows[3],rows[2]],next_cursor:4,order:'desc'}));});
  server.listen(0,'127.0.0.1'); await once(server,'listening'); const address=server.address(); assert.ok(address&&typeof address==='object');
  try {
    const events=await eventsBusHistory('job1','task1',2,{NEO_EVENTS_API_URL:`http://127.0.0.1:${address.port}`,NEO_EVENTS_BUS_CONFIG:path.join(os.tmpdir(),'missing-events-config.json')});
    assert.deepEqual(events.map(e=>e.event_id),['e4','e3']);
  } finally { await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())); }
});

test('worker reported timestamp is preserved and dashboard history uses trusted receive time', async () => {
  const { markEventReceived } = await import('../dist/event-received-time.js');
  const original = {version:1,event_id:'received-at-test',job_id:'j',task_id:'review',parent_task_id:null,type:'task.started',status:'running',timestamp:'2026-10-08T04:00:00Z',visibility:'user',level:'info',message:'start'};
  const received = markEventReceived(original,'2026-10-08T17:20:07Z');
  assert.equal(received.receivedAt,'2026-10-08T17:20:07Z');
  assert.equal(received.reportedAt,'2026-10-08T04:00:00Z');
  assert.equal(received.timestamp,original.timestamp);
  const again = markEventReceived(original,'2026-10-08T19:00:00Z');
  assert.equal(again.receivedAt,received.receivedAt);
});
