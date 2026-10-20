import type {DurableStore} from './store.js';
import type {TaskEscalation} from './types.js';
import {recordEscalationNotificationDelivery} from './task-recovery.js';

export type EscalationNotification = Readonly<{
  jobId:string; taskId:string; escalationId:string; idempotencyKey:string;
  requiredAction:string; resolutionCondition:string; context:string;
}>;
export type NotificationReceipt = Readonly<{channel:string;deliveryId:string;deliveredAt:string}>;
export type EscalationNotifier = (request:EscalationNotification)=>Promise<NotificationReceipt>;

function receiptValid(value:NotificationReceipt):boolean {
  return typeof value.channel==='string'&&value.channel.trim().length>0
    &&typeof value.deliveryId==='string'&&value.deliveryId.trim().length>0
    &&typeof value.deliveredAt==='string'&&Number.isFinite(Date.parse(value.deliveredAt));
}

/** Configured trusted downstream notifier. HTTP success alone is never a delivery receipt. */
export function escalationNotifierFromEnvironment(env:NodeJS.ProcessEnv=process.env):EscalationNotifier|undefined {
  const raw=env.AGENTS_RELAY_ESCALATION_NOTIFY_URL?.trim();
  if(!raw)return undefined;
  const url=new URL(raw);
  if(url.username||url.password||url.hash||!(
    url.protocol==='https:' || (url.protocol==='http:'&&['localhost','127.0.0.1','::1','[::1]'].includes(url.hostname))
  ))throw Error('Escalation notifier requires HTTPS or a loopback HTTP endpoint without URL credentials');
  const token=env.AGENTS_RELAY_ESCALATION_NOTIFY_TOKEN?.trim();
  return async request=>{
    const response=await fetch(url,{method:'POST',redirect:'error',
      signal:AbortSignal.timeout(10000),
      headers:{'Content-Type':'application/json','Idempotency-Key':request.idempotencyKey,
        ...(token?{'Authorization':`Bearer ${token}`}:{})},
      body:JSON.stringify(request),
    });
    if(!response.ok)throw Error(`Notification endpoint HTTP ${response.status}`);
    const body=await response.json() as Partial<NotificationReceipt>&{delivered?:boolean};
    if(body.delivered!==true||!receiptValid(body as NotificationReceipt))
      throw Error('Notification endpoint did not provide a verified delivery ID');
    return {channel:body.channel!,deliveryId:body.deliveryId!,deliveredAt:body.deliveredAt!};
  };
}

const retryDelayMs=(attempts:number):number=>Math.min(3600000,60000*2**Math.min(6,Math.max(0,attempts-1)));
function pending(notification:TaskEscalation):boolean {
  return notification.status==='pending'&&notification.notification?.status!=='delivered';
}

/** Durable delivery-attempt ledger; a transport ACK without provider receipt leaves status pending. */
export async function deliverPendingEscalations(
  store:DurableStore,jobId:string,notifier:EscalationNotifier|undefined,now=new Date(),
):Promise<{delivered:number;pending:number;failed:number}> {
  const job=await store.load(jobId);
  const result={delivered:0,pending:0,failed:0};
  const candidates=job.tasks.filter(t=>t.agentName==='troubleshooter'&&t.escalation&&pending(t.escalation));
  if(candidates.length>0&&!store.mutateJob){
    if(notifier)throw Error('Escalation delivery with an actual notifier requires atomic SQLite mutation');
    return {delivered:0,pending:candidates.length,failed:0};
  }
  for(const task of candidates){
    const escalation=task.escalation!;
    const details=escalation.notification??{};
    if(typeof details.nextAttemptAt==='string'&&Date.parse(details.nextAttemptAt)>now.getTime()){result.pending++;continue;}
    if(!notifier){
      if(details.lastError!=='Notification delivery channel is not configured'){
        await store.mutateJob!(jobId,current=>{
          const candidate=current.tasks.find(t=>t.id===task.id);
          if(candidate?.escalation?.id===escalation.id&&pending(candidate.escalation))
            candidate.escalation.notification={...candidate.escalation.notification,status:'pending',lastError:'Notification delivery channel is not configured'};
          return current;
        });
      }
      result.pending++;continue;
    }
    const request:EscalationNotification={
      jobId,taskId:task.id,escalationId:escalation.id,
      idempotencyKey:`escalation/${escalation.id}`,
      requiredAction:escalation.requiredAction,resolutionCondition:escalation.resolutionCondition,context:escalation.context,
    };
    try{
      const receipt=await notifier(request);
      if(!receiptValid(receipt))throw Error('Notifier returned no verifiable delivery receipt');
      await recordEscalationNotificationDelivery(store,jobId,task.id,escalation.id,receipt);
      result.delivered++;
    }catch(error){
      const message=error instanceof Error?error.message:String(error);
      await store.mutateJob!(jobId,current=>{
        const candidate=current.tasks.find(t=>t.id===task.id);
        if(candidate?.escalation?.id!==escalation.id||!pending(candidate.escalation))return current;
        const previous=candidate.escalation.notification??{};
        const attempts=(typeof previous.attempts==='number'?previous.attempts:0)+1;
        candidate.escalation.notification={...previous,status:'pending',attempts,lastError:message,
          lastAttemptAt:now.toISOString(),nextAttemptAt:new Date(now.getTime()+retryDelayMs(attempts)).toISOString()};
        return current;
      });
      result.failed++;
    }
  }
  return result;
}
