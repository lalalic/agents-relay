/** Isolated Replay of raw provider events into actual Relay ingress + SQLite. */
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {SQLiteRelayStore} from '../../../dist/relay-store.js';
import {LocalAuthorityDurableStore} from '../../../dist/local-authority-store.js';
import {InMemoryStore} from '../../../dist/store.js';
import {Reconciler} from '../../../dist/reconciler.js';
import {MemoryEventBus} from '../../../dist/events.js';
export async function relayAcceptProviderEvents({work,jobId,taskId,executionId,role,events,expectedState='SUCCEEDED',expectedVerdict='approved',reviewHeadSha='l2-immutable-fixture'}) {
 const sqlite=new SQLiteRelayStore(join(work,'stores','relay.sqlite'),jobId);
 const store=new LocalAuthorityDurableStore(sqlite,new InMemoryStore(),undefined,true);
 const bus=new MemoryEventBus();
 const timestamp=new Date().toISOString();
 const output={kind:'task_pr'};
 const task={jobId,id:taskId,kind:'work',agentName:role,adapter:'codex',output,input:'isolated L2',parentTaskId:null,dependencies:[],capabilities:[],state:'QUEUED',attempt:1,maxAttempts:3,leaseOwner:'isolated-l2',leaseExpiresAt:'2099-01-01T00:00:00.000Z',executionId,executionHistory:[{id:executionId,attempt:1,startedAt:timestamp}],threadId:null,result:null,error:null,timeoutMs:900000,createdAt:timestamp,updatedAt:timestamp,...(role==='reviewer'?{reviewHeadSha}:{})};
 const job={id:jobId,title:'real provider L2',repository:'local/isolated',prNumber:0,state:'ACTIVE',autoMerge:false,reviewEnabled:role==='reviewer',headSha:reviewHeadSha,createdAt:timestamp,updatedAt:timestamp,tasks:[task]};
 if(role==='reviewer')job.review={taskId,outcome:'pending',headSha:reviewHeadSha};
 const runtime=new Reconciler(store,{owner:'isolated-l2',adapters:[],eventBus:bus,maxConcurrent:0,noGitHub:true});
 let stop;
 try {
   await store.saveJob(job);
   await store.reserveWorkflowLaunch({jobId,taskId,executionId,attempt:1,leaseOwner:'isolated-l2'});
   stop=await runtime.watch(jobId);
   const progress=[];
   for(const raw of events) {
     const event={event_id:`l2-${randomUUID()}`,job_id:jobId,task_id:taskId,type:raw.type,
       source:{id:raw.source.id,agent:role},status:raw.type==='task.started'?'running':raw.type==='task.failed'?'failed':'succeeded',message:raw.type,
       visibility:'orchestrator',data:raw.data??{},timestamp:new Date().toISOString()};
     await bus.publish(event);
     await runtime.idle();
     const observed=await sqlite.loadJob(jobId);
     progress.push({type:raw.type,state:observed.tasks.find(t=>t.id===taskId)?.state,reviewOutcome:observed.review?.outcome??null});
   }
   const observed=await sqlite.loadJob(jobId);
   const terminal=observed.tasks.find(t=>t.id===taskId);
   const accepted=terminal?.state===expectedState&&(role!=='reviewer'||expectedState==='FAILED'||observed.review?.outcome===(expectedVerdict==='changes-required'?'changes_required':expectedVerdict));
   return {accepted,progress,jobState:observed.state,taskState:terminal?.state,reviewOutcome:observed.review?.outcome??null};
 }finally{await stop?.();await runtime.close();sqlite.close();}
}
