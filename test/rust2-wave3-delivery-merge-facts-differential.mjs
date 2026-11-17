// Deterministic randomized Node/Rust diff of public localMergeFacts, including
// non-ready/gated/review/head-stale branches. No Git mutation or provider.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
const {localMergeFacts}=await import('../dist/local-git-merge.js');
const bin=resolve('rust/target/debug/relay-rust2-parity');
const store=mkdtempSync(join(tmpdir(),'rust2-wave3-merge-facts-'));
let seed=20261117,total=0;
const rnd=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0};
const pick=a=>a[rnd()%a.length];
function rust(req){
 const p=spawnSync(bin,[],{input:JSON.stringify({op:'deliveryWave2',case:'localMergeFactsBound',...req})+'\n',
  encoding:'utf8',timeout:30000,env:{...process.env,AGENTS_RELAY_STORE_DIR:store}});
 assert.equal(p.status,0,p.stderr);
 const result=JSON.parse(p.stdout);if(!result.ok)throw Error(result.error);return result.value;
}
const nowMs=Date.parse('2026-11-17T14:00:00.000Z');
try { for(let i=0;i<270;i++){
 const reviewEnabled=pick([true,false]);
 const status=pick(['PENDING','SUCCEEDED','FAILED','RUNNING']);
 const plan=pick([null,{id:'plan',round:1,status:pick(['SUCCEEDED','FAILED','PLANNING']),
   objectiveStatus:pick(['satisfied','incomplete'])}]);
 const tasks=[{id:'1',state:pick(['SUCCEEDED','FAILED','QUEUED','RUNNING']),
   adapter:'chatgpt',kind:'work',output:{kind:'task_pr'}}];
 if(!plan)tasks.push({id:'2',kind:'planner',adapter:'chatgpt',state:status,
   plannerResult:{objective_status:pick(['satisfied','incomplete'])}});
 const localMerge=pick([null,{status:pick(['pending','failed','succeeded']),
  sourceRef:'refs/heads/relay/job-1',targetRef:'refs/heads/main',
  nextAttemptAt:pick([null,'2026-11-16T00:00:00.000Z','2026-11-19T00:00:00.000Z','bad'])}]);
 const headSha=pick([null,'abc','def']);
 const job={id:'9',state:pick(['ACTIVE','DRAFT','COMPLETED']),
  reviewEnabled,review:{outcome:pick(['approved','rejected','pending']),headSha:pick(['abc','def',null])},
  autoMerge:pick([true,false]),tasks,plans:plan?[plan]:[],localMerge};
 const n=localMergeFacts(job,headSha,()=>nowMs);
 const r=rust({job,headSha,nowMs});
 assert.deepEqual(r,n,'random case '+i+' '+JSON.stringify(job));total++;
}
console.log('PASS Rust2 Wave3 local Git completion facts direct Node/Rust random '+total);
}finally{rmSync(store,{recursive:true,force:true});}
