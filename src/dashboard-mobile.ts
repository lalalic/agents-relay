/** Owner-safe Relay REST projections. The Neo edge controls authentication;
 * Relay remains the sole authority for live Job/Task state and cancellation.
 * Never expose objective, prompts, artifacts, private paths or raw event data. */
const ID=/^[A-Za-z0-9_.-]{1,100}$/;
// Repository identities may be scoped (e.g. neo/toyalive-3d or local/vlog).
// Each path component must start alphanumeric; disallow traversal, empty
// components, escapes, query delimiters and unbounded nesting.
const REPO=/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}){0,3}$/;
const STATE=/^[A-Z_]{2,40}$/;
const clip=(s:unknown,max:number)=>typeof s==='string'?s.slice(0,max):'';
export const validMobileIdentity=(id:unknown,repository:unknown):id is string=>
  typeof id==='string'&&ID.test(id)&&typeof repository==='string'&&repository.length<=200&&REPO.test(repository);

export function projectMobileJob(row:unknown){
  if(!row||typeof row!=='object')return null;
  const r=row as Record<string,unknown>;
  if(!validMobileIdentity(r.id,r.repository))return null;
  const state=clip(r.state,40),runtime=clip(r.runtimeStatus,40);
  if(!STATE.test(state))return null;
  const status=STATE.test(runtime)?runtime:state;
  return {id:r.id,repository:r.repository,title:clip(r.title,120),status,
    createdAt:clip(r.createdAt,40),updatedAt:clip(r.updatedAt,40),
    cancellable:state==='DRAFT'||state==='ACTIVE'};
}
export function projectMobileJobs(rows:unknown,offset:number,limit:number){
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>20)throw Error('Invalid paging');
  const jobs=(Array.isArray(rows)?rows:[]).map(projectMobileJob).filter(x=>x!==null);
  const active=(s:string)=>!['CANCELLED','COMPLETED','FAILED','MERGED'].includes(s);
  jobs.sort((a,b)=>Number(active(b.status))-Number(active(a.status))||
    b.updatedAt.localeCompare(a.updatedAt)||String(a.id).localeCompare(String(b.id)));
  return {jobs:jobs.slice(offset,offset+limit),total:jobs.length,
    nextOffset:offset+limit<jobs.length?offset+limit:null,hasMore:offset+limit<jobs.length};
}
export function projectMobileTasks(row:unknown,id:string,repository:string){
  if(!row||typeof row!=='object')throw Error('Job unavailable');
  const r=row as Record<string,unknown>;
  if(r.id!==id||r.repository!==repository||!Array.isArray(r.tasks))throw Error('Job identity mismatch');
  const tasks=r.tasks.slice(0,500).flatMap((v:unknown)=>{
    if(!v||typeof v!=='object')return [];
    const task=v as Record<string,unknown>;
    const title=clip(task.title,160).trim();
    return typeof task.id==='string'&&ID.test(task.id)&&title?[{id:task.id,title}]:[];
  });
  return {jobId:id,repository,tasks};
}
export function projectMobileActivity(rows:unknown){
  return (Array.isArray(rows)?rows:[]).slice(-100).flatMap((entry:unknown)=>{
    if(!entry||typeof entry!=='object')return [];
    const v=entry as Record<string,unknown>;
    const type=clip(v.type,80),timestamp=clip(v.timestamp,40);
    if(!/^(job|task|review|planner)\.[a-z_]+$/.test(type)||!/^\d{4}-\d\d-\d\dT/.test(timestamp))return [];
    return [{type,timestamp,...(typeof v.task_id==='string'&&ID.test(v.task_id)?{taskId:v.task_id}:{})}];
  });
}
