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
import { SQLiteRelayStore } from '../dist/relay-store.js';

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
    res.end(JSON.stringify({job_id:'job1',order:'desc',next_cursor:1,events:[{cursor:1,event}]}));
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

test('task events CLI pages through full history without skipping or duplicating task events', async () => {
  const dir=await mkdtemp(join(tmpdir(),'relay-cli-events-pages-'));
  const fixture=join(dir,'job.json');
  const events=Array.from({length:135},(_,i)=>({cursor:i+1,event:{
    version:1,event_id:`ev${i+1}`,job_id:'job1',task_id:'t1',
    type:i===0?'task.started':'task.progress',status:'running',
    timestamp:'2026-11-01T17:00:00Z',visibility:'orchestrator',level:'info',message:'progress'}}));
  const requested=[];
  const server=createServer((req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1');
    const after=Number(url.searchParams.get('after')??'0'),limit=Number(url.searchParams.get('limit'));
    requested.push({after,limit,order:url.searchParams.get('order'),task:url.searchParams.get('task')});
    const page=events.filter(row=>row.cursor>after).slice(0,limit);
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({job_id:'job1',order:'asc',events:page,next_cursor:page.at(-1)?.cursor??after}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const addr=server.address();assert.ok(addr && typeof addr==='object');
  try {
    await writeFile(fixture,JSON.stringify({id:'job1',repository:'example/repo',title:'test',objective:'test',state:'ACTIVE',
      prNumber:0,tasks:[{id:'t1',jobId:'job1',state:'FAILED',kind:'work',title:'failed',dependencies:[],output:{kind:'task_pr'},attempt:1,maxAttempts:1}],plans:[]}));
    const base=['dist/cli.js','task','events','--file',fixture,'--id','job1','--task-id','t1','--limit','60','--order','asc'];
    const env={...process.env,NEO_EVENTS_API_URL:`http://127.0.0.1:${addr.port}`};
    let after=0;const all=[];
    for(let i=0;i<4;i++){
      const {stdout}=await run(process.execPath,[...base,'--after',String(after)],{cwd:process.cwd(),env,timeout:10000});
      const result=JSON.parse(stdout);
      assert.equal(result.order,'oldest-first');assert.ok(result.nextCursor>=after);
      all.push(...result.events.map(e=>e.event_id));after=result.nextCursor;
      if(!result.morePossible)break;
    }
    assert.equal(all.length,135);assert.equal(new Set(all).size,135);
    assert.equal(all[0],'ev1');assert.equal(all.at(-1),'ev135');
    assert.deepEqual(requested.map(r=>r.after),[0,60,120]);
    assert.ok(requested.every(r=>r.order==='asc'&&r.task==='t1'));
    await assert.rejects(run(process.execPath,[...base,'--after','bad'],{cwd:process.cwd(),env}),/non-negative integer cursor/);
    await assert.rejects(run(process.execPath,[...base.slice(0,-2),'--order','desc','--after','2'],{cwd:process.cwd(),env}),/--after requires --order asc/);
  }finally{await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));await rm(dir,{recursive:true,force:true});}
});

test('read-only Task show/comments support explicit local --file input',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'relay-cli-show-id-'));
  const fixture=join(dir,'job.json');
  try {
    await writeFile(fixture,JSON.stringify({id:'job1',repository:'example/repo',title:'test',objective:'test',state:'ACTIVE',
      prNumber:0,tasks:[{id:'t1',jobId:'job1',title:'found',state:'FAILED',kind:'work',dependencies:[],
        comments:[{text:'evidence'}],output:{kind:'task_pr'},attempt:1,maxAttempts:1}],plans:[]}));
    const base=['dist/cli.js','task'];
    const {stdout:show}=await run(process.execPath,[...base,'show','--file',fixture,'--id','job1','--task-id','t1'],{cwd:process.cwd(),timeout:10000});
    assert.equal(JSON.parse(show).title,'found');
    const {stdout:comments}=await run(process.execPath,[...base,'comments','--file',fixture,'--id','job1','--task-id','t1'],{cwd:process.cwd(),timeout:10000});
    assert.equal(JSON.parse(comments).length,1);
    await assert.rejects(run(process.execPath,[...base,'show','--file',fixture,'--id','job1','--task-id','missing'],{cwd:process.cwd(),timeout:10000}),/Task missing not found/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('read-only Task show/comments/events resolve a real isolated Job by ID without --repo or --file',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'relay-id-only-live-'));
  const store=new SQLiteRelayStore(join(dir,'relay.sqlite'),'job-id-only');
  const at='2026-11-01T17:00:00.000Z';
  const task={id:'t1',jobId:'job-id-only',title:'real ID only task',kind:'work',
    state:'FAILED',parentTaskId:null,dependencies:[],input:'private input',
    comments:[{id:'c1',message:'diagnostic note',createdAt:at}],
    output:{kind:'file',path:'result.txt'},attempt:1,maxAttempts:1,
    createdAt:at,updatedAt:at};
  const job={id:'job-id-only',repository:'example/repo',prNumber:0,title:'real isolated Job',
    objective:'Review Task events',state:'ACTIVE',continuation:null,
    createdAt:at,updatedAt:at,tasks:[task],plans:[]};
  const event={version:1,event_id:'e1',job_id:'job-id-only',task_id:'t1',
    parent_task_id:null,type:'task.failed',status:'failed',
    timestamp:at,visibility:'orchestrator',level:'error',message:'test'};
  const server=createServer((req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1');
    assert.equal(url.searchParams.get('job'),'job-id-only');
    assert.equal(url.searchParams.get('task'),'t1');
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({job_id:'job-id-only',order:'desc',
      events:[{cursor:1,event}],next_cursor:1}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const addr=server.address();assert.ok(addr&&typeof addr==='object');
  try {
    await store.saveJob(job);
    const env={...process.env,AGENTS_RELAY_STORE_DIR:join(dir,'stores'),
      NEO_EVENTS_API_URL:`http://127.0.0.1:${addr.port}`};
    const args=['dist/cli.js','task'];
    const runAction=async action=>(await run(process.execPath,
      [...args,action,'--id','job-id-only','--task-id','t1'],
      {cwd:process.cwd(),env,timeout:10000})).stdout;
    assert.equal(JSON.parse(await runAction('show')).title,'real ID only task');
    assert.equal(JSON.parse(await runAction('comments')).length,1);
    assert.deepEqual(JSON.parse(await runAction('events')).events.map(e=>e.event_id),['e1']);
    await assert.rejects(run(process.execPath,
      [...args,'show','--id','job-id-only','--task-id','t1','--repo','other/repo'],
      {cwd:process.cwd(),env,timeout:10000}),/Immutable local Job not found/);
  }finally{
    store.close();
    await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
    await rm(dir,{recursive:true,force:true});
  }
});
