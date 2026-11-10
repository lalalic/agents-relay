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
  const runtime=resolveEventsBusRuntime({EVENTS_BUS_CONFIG:configPath});
  assert.equal(runtime.natsUrl,'nats://127.0.0.1:5222');
  assert.equal(runtime.apiUrl,'http://127.0.0.1:5223');
  assert.equal(runtime.subjectPrefix,'test.events');
});

test('Relay history client reads events-bus API and returns newest requested events', async () => {
  const rows=Array.from({length:4},(_,i)=>({cursor:i+1,subject:`x.${i+1}`,event:{version:1,event_id:`e${i+1}`,job_id:'job1',task_id:'task1',parent_task_id:null,type:'progress',status:'running',timestamp:new Date(1000+i).toISOString(),visibility:'orchestrator',level:'info',message:`m${i+1}`}}));
  const server=http.createServer((req,res)=>{const url=new URL(req.url,'http://127.0.0.1'); assert.equal(url.searchParams.get('order'),'desc'); assert.equal(url.searchParams.get('limit'),'2'); res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({job_id:'job1',events:[rows[3],rows[2]],next_cursor:4,order:'desc'}));});
  server.listen(0,'127.0.0.1'); await once(server,'listening'); const address=server.address(); assert.ok(address&&typeof address==='object');
  try {
    const events=await eventsBusHistory('job1','task1',2,{EVENTS_BUS_API_URL:`http://127.0.0.1:${address.port}`,EVENTS_BUS_CONFIG:path.join(os.tmpdir(),'missing-events-config.json')});
    assert.deepEqual(events.map(e=>e.event_id),['e4','e3']);
  } finally { await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())); }
});

test('Relay fails closed on mismatched or malformed Task history pages', async () => {
  const { eventsBusHistoryPage } = await import('../dist/events-bus-runtime.js');
  const event = { version: 1, event_id:'e1', job_id:'job1', task_id:'task1',
    parent_task_id:null, type:'task.failed', status:'failed', timestamp:'2026-11-01T17:00:00Z',
    visibility:'orchestrator',level:'error',message:'failed' };
  const valid = { job_id:'job1', order:'asc', events:[{cursor:10,event}], next_cursor:10 };
  let responseBody=valid;
  const server=http.createServer((req,res)=>{
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify(responseBody));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const addr=server.address(); assert.ok(addr && typeof addr==='object');
  const env={EVENTS_BUS_API_URL:`http://127.0.0.1:${addr.port}`,
    EVENTS_BUS_CONFIG:path.join(os.tmpdir(),'missing-events-config.json')};
  try {
    const read=()=>eventsBusHistoryPage('job1','task1',60,{order:'asc',after:0},env);
    assert.deepEqual((await read()).events.map(e=>e.event_id),['e1']);
    responseBody={...valid,events:[{cursor:9,event},{cursor:10,event}]};
    await assert.rejects(eventsBusHistoryPage('job1','task1',1,{order:'asc',after:0},env),
      /unexpected Job, order, or events payload/);
    responseBody=valid;
    for (const bad of [
      null,
      [],
      {...valid,job_id:'other'},
      {...valid,order:'desc'},
      {...valid,events:[{cursor:10,event:{...event,task_id:'task2'}}]},
      {...valid,events:[{cursor:10,event:{...event,job_id:'other'}}]},
      {...valid,events:[{cursor:10,event},{cursor:9,event}]},
      {...valid,events:[{cursor:10,event}],next_cursor:9},
      {...valid,events:[{cursor:10,event}],next_cursor:0},
      {...valid,events:[{event}]},
      {...valid,events:[{cursor:10}]},
    ]) {
      responseBody=bad;
      await assert.rejects(read(),/events-bus history returned/,JSON.stringify(bad));
    }
  }finally{
    await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  }
});

test('event history enforces a bounded deadline for a stalled Events Bus connection',async()=>{
  const {eventsBusHistoryPage}=await import('../dist/events-bus-runtime.js');
  const server=http.createServer((_req,_res)=>{/* deliberate stalled HTTP response */});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const addr=server.address();assert.ok(addr&&typeof addr==='object');
  const env={EVENTS_BUS_API_URL:`http://127.0.0.1:${addr.port}`,
    EVENTS_BUS_CONFIG:path.join(os.tmpdir(),'missing-events-config.json')};
  try{
    await assert.rejects(eventsBusHistoryPage('job1','task1',10,{order:'asc',timeoutMs:100},env),
      /events-bus history unavailable:.*(timed|aborted|Timeout|timeout)/i);
    await assert.rejects(eventsBusHistoryPage('job1','task1',NaN,{order:'asc'},env),/Invalid event history page limit/);
    await assert.rejects(eventsBusHistoryPage('job1','task1',10,{timeoutMs:0},env),/Invalid event history timeout/);
  }finally{
    server.closeAllConnections();
    await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  }
});

test('saved legacy event subject fails closed unless operator explicitly selects cutover subject', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'relay-events-legacy-subject-'));
  try {
    const file=path.join(root,'runtime.json');
    await writeFile(file,JSON.stringify({natsUrl:'nats://127.0.0.1:4222',subjectPrefix:'neo.events.job'}));
    assert.throws(()=>resolveEventsBusRuntime({EVENTS_BUS_CONFIG:file}),/coordinate migration to relay.events.job/);
    const configured=resolveEventsBusRuntime({EVENTS_BUS_CONFIG:file,EVENTS_BUS_SUBJECT_PREFIX:'relay.events.job'});
    assert.equal(configured.subjectPrefix,'relay.events.job');
    assert.equal(resolveEventsBusRuntime({EVENTS_BUS_CONFIG:path.join(root,'absent')}).subjectPrefix,'relay.events.job');
    assert.equal(resolveEventsBusRuntime({EVENTS_BUS_CONFIG:path.join(root,'absent'),NEO_EVENTS_SUBJECT_PREFIX:'ignored.old'}).subjectPrefix,'relay.events.job');
  } finally { await (await import('node:fs/promises')).rm(root,{recursive:true,force:true}); }
});


test('Relay refuses corrupt Events Bus runtime config rather than silently switching event namespace',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'relay-events-corrupt-'));
  const file=path.join(dir,'runtime.json');
  for (const payload of ['{corrupt','[]','null']) {
    await writeFile(file,payload);
    assert.throws(()=>resolveEventsBusRuntime({EVENTS_BUS_CONFIG:file}),/Invalid Events Bus runtime config/);
  }
});
