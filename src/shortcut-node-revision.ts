import {pathToFileURL} from 'node:url';

type Revision = {status:'approved'|'changes_requested';revision:string;invocationId:string;feedback?:string;comments?:readonly unknown[]};
type ModelNode = {id:string;agent:string;predecessorOutputs:Record<string,unknown>;executionId:string;signal:AbortSignal;
 reviewDecision?: {status:'changes_requested';revision:string;invocationId:string;feedback?:string;comments?:readonly unknown[]}};
type ShortcutWorker = (node:ModelNode)=>Promise<unknown>;

/** Preserve Script determinism: semantic owner feedback is resolved by its
 * existing Agent Worker before the Script validates and requests re-review. */
export async function runShortcutRevisionNode(options:{path:string;input:Record<string,unknown>;signal:AbortSignal;
 runCommand:(args:string[],cwd:string)=>Promise<{stdout:string;stderr:string;code:number}>;
 modelNode:Omit<ModelNode,'reviewDecision'>;review:Revision|null;
 runModelNode?:ShortcutWorker;validOutput:(value:unknown)=>boolean}):Promise<unknown>{
 const {review}=options;
 const module=await import(pathToFileURL(options.path).href) as {run:(ctx:{input:Record<string,unknown>;signal:AbortSignal;runCommand:typeof options.runCommand})=>Promise<unknown>};
 let revisionWork:unknown;
 if(review?.status==='changes_requested'){
   if(!options.runModelNode)throw Error('Request Changes requires a bound Agent Worker; Shortcut script cannot perform a semantic revision');
   revisionWork=await options.runModelNode({...options.modelNode,reviewDecision:{status:'changes_requested',
     revision:review.revision,invocationId:review.invocationId,feedback:review.feedback,comments:review.comments}});
   if(!options.validOutput(revisionWork))throw Error('Revision Worker did not return a completed Artifact result');
 }
 return module.run({input:{...options.input,
    ...(review?{reviewDecision:{status:review.status,revision:review.revision,invocationId:review.invocationId,
      feedback:review.feedback,comments:review.comments}}:{}),
    ...(revisionWork?{reviewRevision:revisionWork}:{})},
    signal:options.signal,runCommand:options.runCommand});
}
