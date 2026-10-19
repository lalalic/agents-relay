import type { DurableStore } from './store.js';
import type { ReconcileOptions } from './reconciler-runtime.js';
/** Propagate transport failures. Pending SQLite events replay after restart. */
export async function drainProductionWorkflowOutbox(store:DurableStore,options:ReconcileOptions):Promise<number>{
 if (!store.drainWorkflowEvents || (!options.eventBus&&!options.emit)) return 0;
 return store.drainWorkflowEvents(async event=>{
   if(options.eventBus)await options.eventBus.publish(event);
   if(options.emit)await options.emit(event);
 });
}
