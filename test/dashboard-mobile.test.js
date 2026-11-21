import test from './test-runtime.js';
import assert from 'node:assert/strict';
import {projectMobileJob,projectMobileJobs,projectMobileTasks,projectMobileActivity,validMobileIdentity} from '../dist/dashboard-mobile.js';
const example=(id,status='ACTIVE')=>({id,repository:'vlog',state:status,runtimeStatus:status,
 title:'Title '+id,createdAt:'2026-11-20T09:00:00.000Z',updatedAt:'2026-11-20T10:00:00.000Z',
 prompt:'private conversation',objective:'secret task',token:'12345',tasks:[{id:'task1',title:'Named task',objective:'private'}]});
test('mobile Jobs sanitize sensitive raw fields and provide deterministic paging',()=>{
 const records=Array.from({length:21},(_,i)=>example('job'+i,i<2?'CANCELLED':'ACTIVE'));
 const first=projectMobileJobs(records,0,20);
 assert.equal(first.total,21);assert.equal(first.jobs.length,20);assert.equal(first.hasMore,true);
 assert.equal(first.nextOffset,20);
 assert.equal(projectMobileJobs(records,20,20).jobs.length,1);
 assert.equal(first.jobs.at(-1).status,'CANCELLED');
 assert.ok(!JSON.stringify(first).includes('private conversation'));
 assert.ok(!JSON.stringify(first).includes('objective'));
 assert.ok(!JSON.stringify(first).includes('12345'));
 assert.equal(projectMobileJob(example('bad/path')),null);
 for(const offset of [-1,1.5])assert.throws(()=>projectMobileJobs(records,offset,20),/paging/);
 assert.throws(()=>projectMobileJobs(records,0,21),/paging/);
});
test('mobile Job labels check repository identity and strip objectives',()=>{
 const job=example('abc');const result=projectMobileTasks(job,'abc','vlog');
 assert.deepEqual(result.tasks,[{id:'task1',title:'Named task'}]);
 assert.throws(()=>projectMobileTasks(job,'abc','wrong'),/identity/);
 assert.equal(validMobileIdentity('abc','vlog'),true);
 assert.equal(validMobileIdentity('abc','neo/toyalive-3d'),true);
 assert.equal(validMobileIdentity('abc','local/vlog'),true);
 for(const repository of ['neo//toyalive','neo/../toyalive','neo/%2e','neo/','/neo','neo?evil=1','neo/'+('a'.repeat(198))]) {
  assert.equal(validMobileIdentity('abc',repository),false,repository);
 }
 const scoped=projectMobileJobs([example('scoped'),{...example('scoped2'),repository:'neo/toyalive-3d'}],0,20);
 assert.equal(scoped.total,2,'Do not silently drop scoped real repository identities');
 assert.equal(scoped.jobs.some(job=>job.repository==='neo/toyalive-3d'),true);
 assert.equal(validMobileIdentity('../x','vlog'),false);
});
test('mobile activity strips user content and only allows lifecycle event labels',()=>{
 const projected=projectMobileActivity([{type:'task.completed',timestamp:'2026-11-20T09:00:00Z',task_id:'task1',message:'secret'},
   {type:'secret.exfiltration',timestamp:'2026-11-20T09:00:00Z',message:'secret'}]);
 assert.deepEqual(projected,[{type:'task.completed',timestamp:'2026-11-20T09:00:00Z',taskId:'task1'}]);
 assert.ok(!JSON.stringify(projected).includes('secret'));
});

test('real loopback Node HTTP mobile endpoints preserve scoped identity and redact job payload',async()=>{
 const {managedDashboard}=await import('./test-runtime.js');
 const {once}=await import('node:events');
 const {InMemoryStore}=await import('../dist/store.js');
 const createdAt='2026-11-20T09:00:00.000Z';
 const source={
   id:'job_12345',repository:'vlog',title:'Visible',state:'ACTIVE',
   runtimeStatus:'ACTIVE',createdAt,updatedAt:createdAt,
   objective:'SECRET_PROMPT',continuation:null,tasks:[{id:'task1',title:'Public task',objective:'SECRET_PROMPT'}],
 };
 const server=managedDashboard(new InMemoryStore(source),0,undefined,300000,'job_12345');
 await once(server,'listening');
 const base='http://127.0.0.1:'+server.address().port;
 const page=await fetch(base+'/api/mobile/jobs?offset=0&limit=20');
 assert.equal(page.status,200);
 assert.equal(page.headers.get('cache-control'),'no-store');
 const data=await page.json();
 assert.equal(data.jobs[0].id,'job_12345');
 assert.equal(data.jobs[0].repository,'vlog');
 assert.ok(!JSON.stringify(data).includes('SECRET_PROMPT'));
 const bad=await fetch(base+'/api/mobile/job-tasks?id=job_12345&repo=../other');
 assert.equal(bad.status,404);
 const negative=await fetch(base+'/api/mobile/jobs?offset=-1&limit=20');
 assert.equal(negative.status,409);
});


test('mobile HTTP refuses ambiguous cross-repository Job IDs before reading activity or cancelling',async()=>{
 const {managedDashboard}=await import('./test-runtime.js');
 const {once}=await import('node:events');
 const {InMemoryStore}=await import('../dist/store.js');
 const mk=(repository)=>({
   id:'shared_job_id',repository,title:'Visible',state:'ACTIVE',runtimeStatus:'ACTIVE',
   createdAt:'2026-11-20T09:00:00.000Z',updatedAt:'2026-11-20T09:00:00.000Z',
   tasks:[],objective:'SECRET_PROMPT',
 });
 const jobs=[mk('vlog'),mk('other')];
 let cancels=0;
 const overview=async()=>jobs.map(job=>({job,githubState:'OPEN',draft:false,mergedAt:null,closedAt:null}));
 const exact=async(id,target)=>jobs.find(job=>job.id===id&&job.repository===target?.repository)??null;
 const actions={cancel:async()=>{cancels++;return jobs[0];}};
 const server=managedDashboard(new InMemoryStore(jobs[0]),0,undefined,300000,undefined,
   undefined,overview,undefined,undefined,undefined,exact,actions);
 await once(server,'listening');
 const base='http://127.0.0.1:'+server.address().port;
 const activity=await fetch(base+'/api/mobile/job-activity?id=shared_job_id&repo=vlog');
 assert.equal(activity.status,409);
 assert.match((await activity.json()).error,/Ambiguous Job ID/);
 const cancellation=await fetch(base+'/api/mobile/job-cancel',{
   method:'POST',headers:{'content-type':'application/json'},
   body:JSON.stringify({id:'shared_job_id',repository:'vlog'}),
 });
 assert.equal(cancellation.status,409);
 assert.equal(cancels,0,'Must not call unscoped cancel action when IDs collide');
});


test('mobile HTTP cancel requires authoritative scoped CANCELLED readback',async()=>{
 const {managedDashboard}=await import('./test-runtime.js');
 const {once}=await import('node:events');
 const {InMemoryStore}=await import('../dist/store.js');
 const jobs=['cancel_success','cancel_unverified'].map(id=>({
   id,repository:'vlog',title:id,state:'ACTIVE',runtimeStatus:'ACTIVE',
   createdAt:'2026-11-20T09:00:00.000Z',updatedAt:'2026-11-20T09:00:00.000Z',
   tasks:[],objective:'SECRET_PROMPT',
 }));
 let calls=0;
 const overview=async()=>jobs.map(job=>({job,githubState:'OPEN',draft:false,mergedAt:null,closedAt:null}));
 const exact=async(id,target)=>jobs.find(job=>job.id===id&&job.repository===target?.repository)??null;
 const actions={cancel:async id=>{
   calls++;
   const job=jobs.find(job=>job.id===id);
   if(id==='cancel_success')job.state='CANCELLED';
   return job;
 }};
 const server=managedDashboard(new InMemoryStore(jobs[0]),0,undefined,300000,undefined,
   undefined,overview,undefined,undefined,undefined,exact,actions);
 await once(server,'listening');
 const base='http://127.0.0.1:'+server.address().port;
 const cancel=id=>fetch(base+'/api/mobile/job-cancel',{
   method:'POST',headers:{'content-type':'application/json'},
   body:JSON.stringify({id,repository:'vlog'}),
 });
 const accepted=await cancel('cancel_success');
 assert.equal(accepted.status,200);
 assert.deepEqual(await accepted.json(),{id:'cancel_success',repository:'vlog',status:'cancelled'});
 assert.equal(jobs[0].state,'CANCELLED');
 const unverified=await cancel('cancel_unverified');
 assert.equal(unverified.status,409);
 assert.match((await unverified.json()).error,/CANCELLED readback/);
 assert.equal(calls,2);
});
