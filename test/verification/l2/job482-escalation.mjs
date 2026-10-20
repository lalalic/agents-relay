/** Replays the contradictory Job482 evidence through production Graph/SQLite escalation actions. */
import {join} from 'node:path';
import {SQLiteRelayStore} from '../../../dist/relay-store.js';
import {requestTroubleshooterEscalation,resumeTroubleshooter} from '../../../dist/task-recovery.js';
import {dispatchTaskAction} from '../../../dist/task-actions.js';

const requireText=(value,name)=> {
  if(typeof value!=='string'||!value.trim())throw Error(`Job482 recommendation requires ${name}`);
  return value.trim();
};

export async function verifyJob482EscalationLoop({work,recommendation,originalExecutionId,recoveryExecutionId}) {
  if(recommendation?.path!=='escalation_gate')throw Error('Job482 evidence must select escalation_gate');
  const request={
    requiredAction:requireText(recommendation.requiredAction,'requiredAction'),
    resolutionCondition:requireText(recommendation.resolutionCondition,'resolutionCondition'),
    context:requireText(recommendation.context,'context'),
  };
  const recommendationText=JSON.stringify(recommendation);
  if(!/connected=true/i.test(request.resolutionCondition)||!/permissions=true/i.test(request.resolutionCondition))
    throw Error('Job482 resolution condition must require authoritative connected=true and permissions=true');
  if(!/connected=false/i.test(recommendationText)||!/permissions=false/i.test(recommendationText))
    throw Error('Job482 recommendation must preserve authoritative contradictory status');
  const jobId='job482-contradictory-mcp';
  const originalId='review-fix-acfa2a5a';
  const recoveryId='troubleshoot-review-fix-acfa2a5a';
  const at=new Date().toISOString();
  const task=(id,state,extra={})=>({jobId,id,kind:'work',agentName:id===recoveryId?'troubleshooter':'implementation',adapter:'codex',output:{kind:'task_pr'},
    input:'Resolve contradictory Neo MCP evidence before retry',parentTaskId:id===recoveryId?originalId:null,dependencies:[],capabilities:[],
    state,attempt:id===recoveryId?1:5,maxAttempts:12,leaseOwner:id===recoveryId?'isolated-l2':null,leaseExpiresAt:id===recoveryId?'2099-01-01T00:00:00.000Z':null,
    executionId:id===recoveryId?recoveryExecutionId:(state==='FAILED'?originalExecutionId:null),
    executionHistory:id===recoveryId?[{id:recoveryExecutionId,attempt:1,startedAt:at}]:[{id:originalExecutionId,attempt:5,startedAt:at}],
    threadId:null,result:null,error:state==='FAILED'?'Repeated implementation execution failed before durable completion.':null,
    timeoutMs:900000,createdAt:at,updatedAt:at,...extra});
  const job={id:jobId,title:'Job482 contradictory MCP evidence L2',repository:'local/isolated',prNumber:0,state:'ACTIVE',executionMode:'fixed',
    autoMerge:false,reviewEnabled:false,headSha:'acfa2a5abbce2e55f85afab2fefd0b5fba1739ab',createdAt:at,updatedAt:at,
    tasks:[task(originalId,'FAILED'),task(recoveryId,'RUNNING')]};
  const database=join(work,'stores','job482-escalation.sqlite');
  let escalationId;
  let store=new SQLiteRelayStore(database,jobId);
  try {
    await store.saveJob(job);
    const requested=await requestTroubleshooterEscalation(store,jobId,recoveryId,request);
    if(requested.duplicate!==false||requested.task.state!=='BLOCKED'||requested.escalation.status!=='pending')throw Error('First Job482 escalation was not durably blocked');
    const repeated=await requestTroubleshooterEscalation(store,jobId,recoveryId,request);
    if(repeated.duplicate!==true||repeated.escalation.id!==requested.escalation.id)throw Error('Repeated identical Job482 escalation created a second request');
    escalationId=requested.escalation.id;
  } finally { store.close(); }

  store=new SQLiteRelayStore(database,jobId);
  try {
    const replayed=await store.loadJob(jobId);
    const blocked=replayed.tasks.find(item=>item.id===recoveryId);
    if(blocked?.state!=='BLOCKED'||blocked.escalation?.status!=='pending')throw Error('Job482 escalation did not survive SQLite restart');
    const resumed=await resumeTroubleshooter(store,jobId,recoveryId,'Human reports Neo app authorization completed; worker must independently verify status.');
    if(resumed.task.state!=='QUEUED'||resumed.task.escalation.status!=='responded')throw Error('Authorized human response did not resume the same Troubleshooter');
    const recovered=await dispatchTaskAction(store,{id:'task.recover',jobId,taskId:originalId,recoveryTaskId:recoveryId,
      recoveryDiagnosis:{failureKind:'task_failure',reason:'Contradictory MCP evidence made prior attempts semantically incomplete.',evidence:'Authoritative capture reported connected=false and permissions=false; human authorization now requires independent worker verification.',reroute:false}});
    const after=await store.loadJob(jobId);
    const original=after.tasks.find(item=>item.id===originalId);
    const recovery=after.tasks.find(item=>item.id===recoveryId);
    if(original?.state!=='QUEUED'||original.executionId!==null||recovery?.state!=='QUEUED')
      throw Error(`Job482 exact-original recovery postcondition failed: original=${original?.state}/${original?.executionId}, recovery=${recovery?.state}`);
    return {accepted:true,escalationId,duplicate:true,states:{original:original.state,recovery:recovery.state},
      recoveryExecution:{original:original.executionId,recovery:recovery.executionId},
      comments:{original:original.comments?.length??0,recovery:recovery.comments?.length??0}};
  } finally { store.close(); }
}
