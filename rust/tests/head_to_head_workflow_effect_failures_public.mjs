// Exact public Node src/workflow-effect-failures.ts vs Rust reducers with the
// original Task/Job lifecycle Graph. No live credentials or external effects.
// All transitions are authoritative Graph APIs, not a mocked transition result.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {applyJobEffectOutcomes,applyTaskEffectOutcomes}
  from '../../dist/workflow-effect-failures.js';
const root=resolve(import.meta.dirname,'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');
let seed=0x72a6c;
function rnd(){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;}
const pick=items=>items[rnd()%items.length];
const effects=['effect.launchTask','effect.cancelActiveTasks',
  'effect.mergePullRequest','effect.cleanupJobWorktree','effect.deliverLocalMerge'];
const fixtures=[];
for(let i=0;i<95;i++){
  const job={id:'17',repository:'isolated',state:pick(['ACTIVE','DRAFT','COMPLETED','CANCELLED']),
    tasks:[],plans:[],updatedAt:'2026-11-18T00:00:00.000Z'};
  const task={id:'2',jobId:'17',kind:'work',agentName:'developer',adapter:'script',
    state:pick(['QUEUED','RUNNING','FAILED','SUCCEEDED','DRAFT']),
    attempt:pick([0,1,2]),maxAttempts:2,dependencies:[],
    parentTaskId:pick([null,'1']),updatedAt:'2026-11-18T00:00:00.000Z'};
  const outcomes=Array.from({length:rnd()%4},(_,idx)=>({
    effect:pick(effects),key:'fix-'+i+'-'+idx,
    status:pick(['failed','succeeded','skipped','failed']),
    ...(rnd()%3===0?{}:{error:pick(['provider declined','retry blocked','','中文 error'])}),
  }));
  fixtures.push({op:'certWorkflowEffectFailures',
    method:pick(['job','task']),job,task,outcomes});
}
for(const method of ['job','task'])for(const effect of effects){
 for(const state of ['QUEUED','FAILED','RUNNING']){
  fixtures.push({op:'certWorkflowEffectFailures',method,
    job:{id:'17',state:'ACTIVE',tasks:[],plans:[]},
    task:{id:'2',jobId:'17',state,kind:'work',updatedAt:'2026-11-18T00:00:00.000Z'},
    outcomes:[{effect,status:'failed',key:'edge-'+effect+'-'+state,error:'edge failed'}]});
 }
}
function normalize(value){
 const output=JSON.parse(JSON.stringify(value));
 const scrub=v=>{
   if(Array.isArray(v))return v.map(scrub);
   if(v&&typeof v==='object'){
     for(const [k,item] of Object.entries(v)){
       if(k==='event_id'&&typeof item==='string')v[k]='<uuid>';
       else if((k==='timestamp'||k==='updatedAt')&&typeof item==='string'
           &&item.startsWith('2026-11-19'))v[k]='<time>';
       else v[k]=scrub(item);
     }
   }
   return v;
 };
 return scrub(output);
}
async function original(fixture){
  const job=structuredClone(fixture.job),task=structuredClone(fixture.task);
  const saved=[],events=[];
  const store={
    saveJob:async j=>saved.push(structuredClone(j)),
    saveTask:async t=>saved.push(structuredClone(t)),
  };
  const emit=async event=>{events.push(structuredClone(event));};
  try{
    if(fixture.method==='job'){
      await applyJobEffectOutcomes(store,emit,job,fixture.outcomes);
      return {ok:true,value:normalize({job,saved,events})};
    }
    await applyTaskEffectOutcomes(store,emit,job,task,fixture.outcomes);
    return {ok:true,value:normalize({task,saved,events})};
  }catch(error){return {ok:false,error:error.message};}
}
test('125 public original Node/Rust Workflow Effect Failure Graph cases',async()=>{
  const expected=[];for(const f of fixtures)expected.push(await original(f));
  const proc=spawnSync(binary,[],{cwd:root,
    input:fixtures.map(JSON.stringify).join('\n')+'\n',encoding:'utf8',
    timeout:120000,maxBuffer:14*1024*1024});
  assert.equal(proc.status,0,proc.stderr||proc.error?.message);
  const rows=proc.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(rows.length,expected.length);
  const differences=[];
  for(let i=0;i<rows.length;i++){
    const actual=rows[i].ok?{ok:true,value:normalize(rows[i].value)}:rows[i];
    try{assert.deepEqual(actual,expected[i]);}
    catch{differences.push({index:i,fixture:fixtures[i],
      node:expected[i],rust:actual});}
  }
  assert.deepEqual(differences.slice(0,3),[],
    `${differences.length} original Node/Rust effect failure mismatches`);
  console.log('Verified',fixtures.length,'original Node/Rust Workflow Effect Failure scenarios');
});
