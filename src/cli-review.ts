import { arg, hasArg, relayControlCommand } from './cli-support.js';
import { normalizeThreadId } from './reviewer-thread.js';
import { runOutcomeReview } from './outcome-review.js';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,isAbsolute} from 'node:path';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
const execFileAsync=promisify(execFile);

export function reviewRequestThreadOverride(args: readonly string[]): string | undefined {
  const values = [...args];
  return hasArg(values, '--thread-id')
    ? normalizeThreadId(arg(values, '--thread-id'), '--thread-id')
    : undefined;
}

/** Stable local CLI contract for a caller-supplied single-call interactive review tool. */
export async function runInteractiveReviewCommand(argv: string[]): Promise<void> {
  const [action,...args]=argv;
  const commands=['begin','wait','fail','abort'];
  if(action==='request' || action==='--path'){
    const options=action==='--path'?argv:['request',...args];
    const flags=action==='--path'?options:options.slice(1);
    const path=arg(flags,'--path'),jobId=arg(flags,'--id'),taskId=arg(flags,'--task-id'),executionId=arg(flags,'--execution-id');
    if(!path||!isAbsolute(path)||!jobId||!taskId||!executionId)throw new Error('review interactive requires --path ABS --id JOB --task-id TASK --execution-id EXEC');
    const dir=await mkdtemp(join(tmpdir(),'relay-review-'));
    try{
      const file=join(dir,'request.json');
      await writeFile(file,JSON.stringify({path,relay:{jobId,taskId,executionId}}),{mode:0o600});
      const {stdout}=await execFileAsync('neo',['mcp','call','review.preview','--args-file',file],{timeout:120000,maxBuffer:1024*1024});
      const receipt=JSON.parse(stdout);
      if(receipt?.isError===true||receipt?.result?.isError===true)throw Error('Neo review.preview rejected: '+JSON.stringify(receipt).slice(0,600));
      console.log(JSON.stringify(receipt));
    }finally{await rm(dir,{recursive:true,force:true});}
    return;
  }
  if(!action||!commands.includes(action))throw new Error('review interactive requires --path or begin|wait|fail|abort');
  const jobId=arg(args,'--id');
  const taskId=arg(args,'--task-id');
  const executionId=arg(args,'--execution-id');
  if(!jobId||!taskId||!executionId)throw new Error('review interactive requires --id --task-id --execution-id');
  if(action==='fail'&&!arg(args,'--reason').trim())throw new Error('review interactive fail requires --reason');
  const body:Record<string,unknown>={command:`review.interactive.${action}`,jobId,taskId,executionId};
  if(action==='fail')body.reason=arg(args,'--reason');
  console.log(JSON.stringify(await relayControlCommand(args,body)));
}

export async function runReviewCommand(action: string, reviewArgs: string[]): Promise<void> {
  if (action === 'run') return runOutcomeReview(reviewArgs);
  if (action === 'interactive') return runInteractiveReviewCommand(reviewArgs);
  if (action !== 'job') throw new Error('review supports: job | run | interactive');
  const jobId = arg(reviewArgs, '--id');
  if (!arg(reviewArgs, '--repo') || !jobId) throw new Error('review job requires --repo and --id');
  const threadId = reviewRequestThreadOverride(reviewArgs);
  const job = await relayControlCommand<any>(reviewArgs, { command: 'review.request', jobId, ...(threadId !== undefined ? { threadId } : {}) });
  console.log(JSON.stringify({ jobId: job.id, pr: job.prNumber ?? 0, reviewerThreadId: job.reviewerThreadId ?? null, status: 'requested', note: 'Relay graph will create the review Task once eligible; this is not a delivery receipt.' }, null, 2));
}
