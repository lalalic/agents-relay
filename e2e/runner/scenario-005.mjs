import {existsSync,readFileSync} from 'node:fs';

/** Pure decision logic: one controller action per observed lifecycle stage. */
export function scenario005Decision(job,events,receiptPath,stalePath){
  const tasks=job.tasks||[];
  const work=tasks.find(t=>t.agentName==='implementation');
  const terminated=existsSync(receiptPath)?JSON.parse(readFileSync(receiptPath,'utf8')):null;
  const stale=existsSync(stalePath)?JSON.parse(readFileSync(stalePath,'utf8')):null;
  if(!terminated){
    const launch=events.map(x=>x.event||x).find(e=>e.type==='task.process.launched'&&e.task_id===work?.id&&Number(e.data?.pid)>1&&e.data?.executionId);
    if(launch)return {action:'terminate',event:launch};
    const uninjectable=events.map(x=>x.event||x).find(e=>e.type==='task.process.launched'&&e.task_id===work?.id&&e.data?.executionId&&!Number(e.data?.pid));
    if(uninjectable)return {issue:{type:'UNINJECTABLE_WORKER',message:'selected worker has no local process PID; scenario 005 requires workerRequirements.runtime=codex'}};
    if(work?.state==='SUCCEEDED')return {issue:{type:'INJECTION_MISSED',message:'implementation succeeded without mandatory worker process termination'}};
    return {action:'observe'};
  }
  if(!stale){
    if(work?.executionId&&work.executionId!==terminated.executionId)return {action:'replay'};
    if(work?.state==='SUCCEEDED')return {issue:{type:'RECOVERY_NOT_PROVEN',message:'implementation succeeded without a newer execution generation'}};
    return {action:'observe'};
  }
  if(terminated.executionId===stale.currentExecutionId)return {issue:{type:'STALE_REPLAY_INVALID',message:'stale terminal replay used the original execution generation'}};
  if(job.state==='COMPLETED'&&!(Number(work?.attempt)>=2&&work?.state==='SUCCEEDED'))return {issue:{type:'RECOVERY_NOT_PROVEN',message:'completed without original task recovery on a later attempt'}};
  return {action:'observe'};
}
export function scenario005PassEligible(receiptPath,stalePath){return existsSync(receiptPath)&&existsSync(stalePath)}
