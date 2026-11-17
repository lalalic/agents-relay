import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {SQLiteWorkflowOperations} from '../../dist/relay-workflow-operations.js';
import {DurableWorkflowPublication} from '../../dist/workflow/durable-publication.js';
const root=resolve(import.meta.dirname,'../..');
const binary=resolve(root,'rust/target/debug/relay-rust2-parity');
const directory=resolve(root,'workflow');
let seed=0x34f129ac;
const rand=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n};
const pick=x=>x[rand(x.length)];
const clone=x=>x===undefined?undefined:JSON.parse(JSON.stringify(x));
function task(state='QUEUED') {
 return {id:'1',jobId:'123',state,kind:'implementation',agentName:'worker',
 attempt:1,maxAttempts:3,executionId:'e1',leaseOwner:'worker-1',
 leaseExpiresAt:'2034-11-17T00:00:00.000Z',
 executionHistory:[{id:'e1',attempt:1,startedAt:'2026-11-17T09:00:00Z'}],dependencies:[],
 updatedAt:'2026-11-17T08:00:00.000Z'};
}
function job(state='ACTIVE',taskState='QUEUED') {
 return {id:'123',repository:'test',projectRoot:'/tmp/fixture',state,
 updatedAt:'2026-11-17T08:00:00.000Z',createdAt:'2026-11-17T07:00:00.000Z',
 reviewEnabled:false,prNumber:0,plans:[],tasks:[task(taskState)]};
}
const all=[];
for(let i=0;i<340;i++){
 const base=job(pick(['ACTIVE','COMPLETED','CANCELLED']),pick(['QUEUED','RUNNING','FAILED']));
 const next=clone(base);
 if(i%3===0)next.id='changed';
 if(i%5===0)next.projectRoot='/other';
 if(i%7===0)next.repository='different';
 if(i%11===0)next.state='ACTIVE';
 if(i%13===0)next.updatedAt='2026-11-16T00:00:00Z';
 if(i%17===0)next.tasks[0].resolution={state:'waiting',owner:'troubleshooter',path:'escalation_gate'};
 const action=pick(['mutateJob','commitWorkflowMutationAndEvents','commitWorkflowMutationWithEvents']);
 const events=pick([[],[{key:'event-1',event:{type:'task.updated',event_id:'event-1'}}],
  [{key:'',event:{type:'task.updated',event_id:'event-1'}}],
  [{key:'event-1',event:{type:'task.updated',event_id:'event-1'}},
   {key:'event-1',event:{type:'task.updated',event_id:'different'}}]]);
 all.push({op:'wave2Operations',action,directory,jobId:pick(['123','missing']),job:base,newJob:next,events});
}
for(let i=0;i<140;i++){
 const t=task(pick(['QUEUED','RUNNING','FAILED']));
 if(i%4===0)t.executionId='other';
 if(i%5===0)t.leaseExpiresAt='2020-01-01T00:00:00Z';
 if(i%7===0)t.leaseOwner=null;
 if(i%11===0)t.executionHistory=[];
 const base=job('ACTIVE',t.state);base.tasks=[t];
 all.push({op:'wave2Operations',action:'reserveWorkflowLaunch',jobId:'123',job:base,directory,
   identity:{jobId:'123',taskId:pick(['1','missing']),executionId:'e1',leaseOwner:'worker-1',attempt:1}});
 all.push({op:'wave2Operations',action:'verifyWorkflowLaunch',jobId:'123',job:base,directory,taskId:'1',executionId:'e1'});
}
for(let i=0;i<80;i++){
 const eventKey='e-'+i;
 all.push({op:'wave2Operations',action:'drainWorkflowEvents',jobId:'123',job:job(),directory,
 failPublish:rand(4)===0,events:pick([[],
   [{key:eventKey,eventId:'job.updated',payload:{event_id:eventKey,type:'job.updated',jobId:'123'}}],
   [{key:eventKey,eventId:'job.updated',payload:{event_id:'wrong',type:'job.updated'}}]])});
}
async function node(req){
 const db=new DatabaseSync(':memory:');
 try{
  db.exec('CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT)');
  if(req.job)db.prepare('INSERT INTO job_snapshot VALUES (?,?)').run(req.jobId,JSON.stringify(req.job));
  const write=(job)=>db.prepare('INSERT OR REPLACE INTO job_snapshot VALUES (?,?)').run(req.jobId,JSON.stringify(job));
  const ops=new SQLiteWorkflowOperations(db,write);
  const action=req.action;
  const events=req.events||[];
  let result;
  try{
   let value;
   switch(action){
    case 'mutateJob':await ops.mutateJob(req.jobId,()=>clone(req.newJob));value=null;break;
    case 'commitWorkflowMutationAndEvents':await ops.commitWorkflowMutationAndEvents(req.jobId,()=>clone(req.newJob),events);value=null;break;
    case 'commitWorkflowMutationWithEvents':await ops.commitWorkflowMutationWithEvents(req.jobId,()=>({next:clone(req.newJob),events}));value=null;break;
    case 'reserveWorkflowLaunch':value=await ops.reserveWorkflowLaunch(req.identity);break;
    case 'verifyWorkflowLaunch':value=await ops.verifyWorkflowLaunch(req.jobId,req.taskId,req.executionId);break;
    case 'drainWorkflowEvents':{
      const pub=new DurableWorkflowPublication(db);
      for(const e of events)pub.enqueue(e.key,e.eventId,e.payload);
      const published=[];
      const count=await ops.drainWorkflowEvents(async event=>{
        if(req.failPublish)throw new Error('fixture publisher failed');published.push(event)
      });
      value={count,published};break;
    }
    default:throw new Error('invalid action');
   }
   result={ok:true,value};
  }catch(error){result={ok:false,error:error.message}}
  const stored=db.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get(req.jobId);
  const pending=new DurableWorkflowPublication(db).pending();
  return {result,job:stored?JSON.parse(stored.json):null,pending};
 }finally{db.close()}
}
function normalize(output){
 const v=clone(output);
 if(v?.job){
  delete v.job.updatedAt;delete v.job.createdAt;
  for(const t of v.job.tasks||[]){
   delete t.updatedAt;
   for(const comment of t.comments||[]){delete comment.id;delete comment.idempotencyKey;delete comment.createdAt}
  }
 }
 // Comments keyed by UUID are nondeterministic; compare only durable lifecycle,
 // not random audit identifiers. Separate native test checks comment count.
 v.pending?.sort((a,b)=>a.key.localeCompare(b.key));
 return v;
}
function rust(reqs){
 const p=spawnSync(binary,[],{cwd:root,input:reqs.map(r=>JSON.stringify(r)).join('\n')+'\n',
  encoding:'utf8',timeout:120000,maxBuffer:20*1024*1024});
 assert.equal(p.status,0,p.stderr||String(p.error));
 return p.stdout.trim().split('\n').map(line=>JSON.parse(line).value);
}
test('SQLite operations: Node/Rust isolated rollback, immutable identity, event dedupe, launch fencing and outbox replay',async()=>{
 const got=rust(all);
 for(let i=0;i<all.length;i++){
  const expected=normalize(await node(all[i]));
  const actual=normalize(got[i]);
  assert.deepEqual(actual,expected,'case '+i+' '+JSON.stringify(all[i]).slice(0,540));
 }
 console.log('Workflow operations '+all.length+' Node/Rust in-memory SQLite transaction and dispatch equivalences');
});
