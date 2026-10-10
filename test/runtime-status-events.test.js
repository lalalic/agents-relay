import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntimeStatusPublisher} from '../dist/runtime-status-events.js';
const base={repository:'owner/repo',id:'job-1',state:'ACTIVE',executionMode:'autonomous',prNumber:0,continuation:null,tasks:[],createdAt:'2026-10-10T00:00:00Z',updatedAt:'2026-10-10T00:00:00Z'};
test('publish computed runtime status transitions once, with no persisted status',async()=>{
 const events=[];const publish=createRuntimeStatusPublisher({publish:async e=>{events.push(e)}});
 publish({...base});publish({...base});
 publish({...base,tasks:[{id:'t',kind:'work',agentName:'implementation',state:'QUEUED'}]});
 publish({...base,tasks:[{id:'t',kind:'work',agentName:'implementation',state:'QUEUED'}]});
 publish({...base,tasks:[{id:'t',kind:'work',agentName:'implementation',state:'RUNNING'}]});
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(events.map(e=>[e.type,e.data.from,e.data.to]),[['job.runtime_status.changed','IDLE','QUEUED'],['job.runtime_status.changed','QUEUED','RUNNING']]);
 assert.ok(!('runtimeStatus' in base));
});
