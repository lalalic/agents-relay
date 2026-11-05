import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { reconcileDependencyRevisionFacts } from '../dist/dependency-revision-execution.js';
import { decideDependencyRevision } from '../dist/workflow/dependency-revision-v2.js';

const at = () => new Date().toISOString();
const task = (id,deps=[])=>({jobId:'job',id,kind:'work',agentName:'implementation',parentTaskId:null,dependencies:deps,capabilities:[],adapter:'codex',input:'implement '+id,output:{kind:'task_pr'},state:'SUCCEEDED',attempt:1,maxAttempts:3,leaseOwner:null,leaseExpiresAt:null,executionId:null,threadId:null,result:{summary:'done'},error:null,timeoutMs:1000,createdAt:at(),updatedAt:at()});
const revised = (name,owner)=>({...task(name),revision:{kind:'targeted',originalTaskId:owner,requestIds:['req'],reviewTaskId:'review',basedOnHeadSha:'head'}});
const fixture=()=>({id:'job',title:'depend',repository:'test/test',state:'ACTIVE',prNumber:0,headSha:'head',tasks:[],createdAt:at(),updatedAt:at()});

test('dependency Graph authorizes only complete explicit and changed semantic input evidence',()=>{
 const facts={upstreamEvidenceChanged:true,explicitValidityPolicy:true,allInputsSettled:true,notAlreadyRecorded:true};
 assert.equal(decideDependencyRevision('dependency.reconcile',facts).target,'PROPOSED');
 for(const key of Object.keys(facts)) assert.notEqual(decideDependencyRevision('dependency.reconcile',{...facts,[key]:false}).target,'PROPOSED');
});

test('fan-in waits for all upstream changes and revalidate/rerun result is unique per vector',()=>{
 const j=fixture(); const a=task('A'),b=task('B'),c=task('C',['A','B']), d=task('D',['C']);
 c.dependencyValidity={A:'revalidate',B:'rerun'};d.dependencyValidity={C:'revalidate'};
 const aNew=revised('A-new','A'), bNew=revised('B-new','B');bNew.state='RUNNING';
 j.tasks=[a,b,c,d,aNew,bNew];
 assert.deepEqual(reconcileDependencyRevisionFacts(j),[], 'partial input revision cannot be consumed');
 bNew.state='SUCCEEDED';
 const added=reconcileDependencyRevisionFacts(j);
 assert.equal(added.length,1,'first downstream created, transitive dependent waits');
 assert.equal(j.tasks.find(t=>t.id===added[0]).revision.kind,'rerun');
 assert.deepEqual(j.tasks.find(t=>t.id===added[0]).revision.dependencyVector,{A:'A-new:1',B:'B-new:1'});
 assert.deepEqual(reconcileDependencyRevisionFacts(j),[],'pending downstream prevents duplicate or premature transitive schedule');
 const changedC=j.tasks.find(t=>t.id===added[0]);changedC.state='SUCCEEDED';
 const next=reconcileDependencyRevisionFacts(j);
 assert.equal(next.length,1);
 assert.equal(j.tasks.find(t=>t.id===next[0]).revision.kind,'revalidate');
 assert.deepEqual(j.tasks.find(t=>t.id===next[0]).revision.dependencyVector,{C:changedC.id+':0'});
 assert.deepEqual(reconcileDependencyRevisionFacts(j),[],'same evidence vector is not rescheduled');
});

test('legacy order-only dependency never triggers revalidation',()=>{
 const j=fixture();const a=task('A'),b=task('B',['A']);j.tasks=[a,b,revised('A-new','A')];
 assert.deepEqual(reconcileDependencyRevisionFacts(j),[]);
});
