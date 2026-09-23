import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveJobRuntimeStatus } from '../dist/runtime-status.js';

const now=()=>new Date().toISOString();
const task=(id,state='QUEUED',agentName)=>({jobId:'j',id,kind:'work',agentName,parentTaskId:null,dependencies:[],capabilities:[],adapter:'orchestrator',input:'x',state,attempt:0,maxAttempts:3,leaseOwner:null,leaseExpiresAt:null,executionId:null,threadId:null,result:null,error:null,timeoutMs:0,createdAt:now(),updatedAt:now(),continuation:null,continuationDeliveredAt:null});
const job=(tasks=[],overrides={})=>({id:'j',title:'x',executionMode:'fixed',reviewEnabled:false,prNumber:1,repository:'owner/repo',state:'ACTIVE',continuation:null,createdAt:now(),updatedAt:now(),tasks,...overrides});

test('job runtime status is derived independently from lifecycle state',()=>{
  assert.equal(deriveJobRuntimeStatus(job([],{state:'DRAFT'})),'IDLE');
  assert.equal(deriveJobRuntimeStatus(job([task('blocked','BLOCKED'),task('failed','FAILED'),task('running','RUNNING')])),'RUNNING');
  assert.equal(deriveJobRuntimeStatus(job([task('blocked','BLOCKED'),task('failed','FAILED'),task('queued','QUEUED')])),'QUEUED');
  assert.equal(deriveJobRuntimeStatus(job([task('blocked','BLOCKED')])),'BLOCKED');
  assert.equal(deriveJobRuntimeStatus(job([task('failed','FAILED')])),'FAILED');
  assert.equal(deriveJobRuntimeStatus(job([task('held','DRAFT')])),'WAITING');
});

test('schedule, review and PR facts project to runtime status',()=>{
  const scheduled=job([],{executionMode:'autonomous',schedule:{cron:'0 23 * * *',timezone:'America/Toronto',nextRunAt:'2026-09-24T03:00:00.000Z',missedRunPolicy:'skip',concurrencyPolicy:'skip',lastScheduledSlot:null,currentRunSlot:null,lastRunAt:null}});
  assert.equal(deriveJobRuntimeStatus(scheduled),'WAITING');
  assert.equal(deriveJobRuntimeStatus({...scheduled,tasks:[task('failed','FAILED'),task('running','RUNNING')]}),'RUNNING');
  assert.equal(deriveJobRuntimeStatus({...scheduled,tasks:[task('failed','FAILED'),task('queued','QUEUED')]}),'QUEUED');
  const reviewing=job([task('work','SUCCEEDED')],{reviewEnabled:true});
  assert.equal(deriveJobRuntimeStatus(reviewing),'REVIEWING');
  const activeReview=job([task('work','SUCCEEDED'),task('review','QUEUED','reviewer')],{reviewEnabled:true,review:{taskId:'review',headSha:'abc',outcome:'started',updatedAt:now()}});
  assert.equal(deriveJobRuntimeStatus(activeReview),'REVIEWING');
  const approved={...reviewing,review:{taskId:'review',headSha:'abc',outcome:'approved',updatedAt:now()}};
  assert.equal(deriveJobRuntimeStatus(approved),'MERGE_PENDING');
  assert.equal(deriveJobRuntimeStatus(job([]),'MERGED'),'MERGED');
  assert.equal(deriveJobRuntimeStatus(job([]),'CLOSED'),'CANCELLED');
});
