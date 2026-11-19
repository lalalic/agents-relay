// Both original Node src/blockers.ts public cross-Job registration / resolution
// operations, compared with native Rust Graph candidate results. All Durable
// stores are in-memory fixtures; no live cross-Job state is touched.
import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';import {resolve} from 'node:path';
import {registerBlockerDependency,resolveBlockerDependencies} from '../../dist/blockers.js';
const root=resolve(import.meta.dirname,'../..'),bin=resolve(root,'rust/target/debug/relay-rust2-parity');
const now='2026-11-18T20:00:00.000Z';
const job=(id,state='ACTIVE',tasks=[])=>({id,repository:id==='10'?'blocker':'dependent',
 prNumber:0,projectRoot:'/tmp/isolated',state,title:'fixture',tasks,plans:[],
 createdAt:now,updatedAt:now});
const task=(state,attempt=1)=>({id:'2',jobId:'20',kind:'work',adapter:'script',
 agentName:'implementation',state,attempt,maxAttempts:3,dependencies:[],
 input:'waiting',createdAt:now,updatedAt:now});
const fixtures=[];
for(const state of ['DRAFT','FAILED','BLOCKED','QUEUED','SUCCEEDED'])
 for(const attempt of [0,1,2])for(const expectedAttempt of [null,1,2])
 for(const resolutionMode of ['merge','verified']){
  const blocker=job('10','ACTIVE'),dependent=job('20','ACTIVE',[task(state,attempt)]);
  fixtures.push({op:'certBlockerPublic',action:'register',blocker,dependent,
   taskId:'2',now,resolutionMode,...(expectedAttempt===null?{}:{expectedAttempt})});
 }
for(const status of ['ACTIVE','COMPLETED'])for(const state of ['DRAFT','BLOCKED','FAILED','QUEUED','SUCCEEDED'])
 for(const relationState of ['waiting','resumed'])for(const resolutionMode of ['merge','verified']){
  const blocker=job('10',status),dependent=job('20','ACTIVE',[task(state,1)]);
  const relation={repository:'dependent',prNumber:0,jobId:'20',taskId:'2',blockedAttempt:1,registeredAt:now,state:relationState};
  blocker.unblocks=[relation];blocker.blockerResolutionMode=resolutionMode;
  if(state==='BLOCKED')dependent.tasks[0].blockedBy={repository:'blocker',prNumber:0,jobId:'10',blockedAttempt:1,registeredAt:now};
  fixtures.push({op:'certBlockerPublic',action:'resolve',blocker,dependent,resolution:resolutionMode,now});
 }
function rust(){const p=spawnSync(bin,[],{cwd:root,input:fixtures.map(JSON.stringify).join('\n')+'\n',encoding:'utf8',timeout:80000,maxBuffer:12e6});assert.equal(p.status,0,p.stderr);return p.stdout.trim().split('\n').map(JSON.parse);}
function store(initial){let value=structuredClone(initial);return {
 async load(){return structuredClone(value);},
 async saveJob(job){value=structuredClone(job);},
 async saveTask(task){const found=value.tasks.findIndex(v=>v.id===task.id);if(found<0)throw Error('Task missing');value.tasks[found]=structuredClone(task);},
 async mutateJob(_id,mutate){value=structuredClone(await mutate(structuredClone(value)));return structuredClone(value);},
 get value(){return value;},
};}
async function node(f){const blocker=store(f.blocker),dependent=store(f.dependent);
 try{
 let value;if(f.action==='register'){
  const relation=await registerBlockerDependency({blockerStore:blocker,blockerJobId:'10',
   dependentStore:dependent,dependentJobId:'20',dependentTaskId:f.taskId,
   expectedAttempt:f.expectedAttempt,resolutionMode:f.resolutionMode,now:f.now});
  value={relation,blocker:blocker.value,dependent:dependent.value,existing:false};
 }else{
  const result=await resolveBlockerDependencies({blockerStore:blocker,blockerJobId:'10',
   dependentStore:()=>dependent,resolution:f.resolution,now:f.now});
  value={...result,blocker:blocker.value,dependent:dependent.value};
 }
 return {ok:true,value:JSON.parse(JSON.stringify(value))};
 }catch(error){return {ok:false,error:error.message};}
}
test('original Node/Rust Blocker Graph registration and release, 130 scenarios',async()=>{
 const expected=[];for(const f of fixtures)expected.push(await node(f));
 const actual=rust();assert.equal(actual.length,expected.length);
 for(let i=0;i<fixtures.length;i++){
  assert.deepEqual(actual[i],expected[i],`Blocker Graph fixture ${i}: ${JSON.stringify(fixtures[i]).slice(0,340)}`);
 }
 console.log(`${fixtures.length} original Node/Rust blocker candidate mutations validated`);
});
