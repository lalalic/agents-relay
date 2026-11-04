import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { ZAdapter, ZCodeThreadContinuation, zExecutionSource, zDesktopPrompt, zTaskBrief } from '../dist/z-adapter.js';

const source='job/27/task/html-e2e/execution/123e4567-e89b-12d3-a456-426614174000';
const prompt='# Role\nYou are implementation with responsibility at /tmp/example.md.\n\n## Bootstrap\nZCode Desktop with connected Neo MCP.\n\n## Task\nJob: 27\nTask: html-e2e\nExecution: 123e4567-e89b-12d3-a456-426614174000';
const routing={provider:'z',model:'glm-5.3'};
const task=(extra={})=>({
  id:'html-e2e',jobId:'27',state:'QUEUED',kind:'work',input:prompt,attempt:0,
  routing,threadId:null,executionId:'123e4567-e89b-12d3-a456-426614174000',...extra
});

test('ZCode Desktop preserves Graph prompt unchanged without OAuth token injection',()=>{
  assert.equal(zExecutionSource(prompt),source);
  assert.throws(()=>zExecutionSource('No source'),/Graph-issued/);
  assert.equal(zDesktopPrompt(prompt),prompt);
  assert.equal(zTaskBrief(prompt),prompt);
  assert.equal(new ZAdapter({submit:async()=>{throw Error('unused')}}).id,'zcode/desktop');
  assert.ok(!new ZAdapter({submit:async()=>{throw Error('unused')}}).capabilities.includes('webhelm'));
});

test('ZCode launches a new native session, records its ID, waits for Relay terminal',async()=>{
  let release;
  const terminal=new Promise(resolve=>{release=resolve});
  const calls=[];
  const adapter=new ZAdapter({submit:async(text,options)=>{
    calls.push({text,options});
    return {sessionId:'sess_aa-test',mode:'new-thread',delivery:'started',verifiedBy:'composer-cleared-session-bound'};
  }});
  const execution=adapter.launch(task(),new AbortController().signal,{waitForTerminal:terminal});
  await execution.launched;
  assert.equal(execution.threadId,'sess_aa-test');
  assert.equal(execution.deliveryReceipt?.status,'submitted');
  assert.equal(execution.deliveryReceipt?.thread_id,'sess_aa-test');
  assert.equal(calls[0].text,prompt);
  assert.equal(calls[0].options.sessionId,undefined);
  assert.equal(calls[0].options.model,'glm-5.3');
  release();
  assert.match((await execution.promise).summary,/terminal task state/);
});

test('ZCode new turn uses existing session and records V4 queued receipt',async()=>{
  const calls=[];
  const adapter=new ZAdapter({submit:async(text,options)=>{
    calls.push(options.sessionId);
    return {sessionId:options.sessionId,mode:'new-turn',delivery:'queued',queueItemId:'q1',verifiedBy:'v4-queue-projection'};
  },stop:async()=>{}});
  const execution=adapter.launch(task({chatgptThreadDelivery:{threadId:'sess_old'}}),new AbortController().signal);
  await execution.launched;
  assert.deepEqual(calls,['sess_old']);
  assert.equal(execution.deliveryReceipt?.delivery,'queued');
  assert.equal(execution.deliveryReceipt?.queue_item_id,'q1');
  assert.equal((await execution.promise).data.queueItemId,'q1');
});

test('ZCode new turn reuses durable native session identity with attempt 0',async()=>{
  const sessions=[];
  const adapter=new ZAdapter({submit:async(_text,opts)=>{
    sessions.push(opts.sessionId);
    return {sessionId:'sess_saved',mode:'new-turn',delivery:'queued',queueItemId:'q20',verifiedBy:'v4-queue-projection'};
  }});
  const exec=adapter.launch(task({threadId:'sess_saved'}),new AbortController().signal);
  await exec.launched;
  assert.deepEqual(sessions,['sess_saved']);
  assert.equal(exec.deliveryReceipt.thread_id,'sess_saved');
  await exec.promise;
});

test('A ZCode crash with a previously submitted session fails closed rather than sending a duplicate',async()=>{
  let calls=0;
  const adapter=new ZAdapter({submit:async()=>{calls++;throw Error('should not submit')}});
  await assert.rejects(adapter.launch(task({threadId:'sess_old',attempt:1}),new AbortController().signal).promise,/not replay-safe/);
  assert.equal(calls,0);
});

test('ZCode cancellation removes only the confirmed queued input',async()=>{
  const stops=[];
  const adapter=new ZAdapter({submit:async()=>({
    sessionId:'sess_a',mode:'new-thread',delivery:'queued',queueItemId:'queue-9',verifiedBy:'v4-queue-projection'
  }),stop:async(id,q)=>stops.push([id,q])});
  const execution=adapter.launch(task(),new AbortController().signal);
  await execution.launched;
  execution.cancel();
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(stops,[['sess_a','queue-9']]);
});

test('ZCode continuation is a same-session new turn and allows queued admission',async()=>{
  const calls=[];
  const continuation=new ZCodeThreadContinuation({submit:async(_,opts)=>{
    calls.push(opts);
    return {sessionId:'sess_a',mode:'new-turn',delivery:'queued',queueItemId:'q12',verifiedBy:'v4-queue-projection'};
  }});
  await continuation.continue('Fix review', {kind:'zcode-thread',target:'sess_a'});
  assert.equal(calls.length,1);
  assert.equal(calls[0].sessionId,'sess_a');
  await assert.rejects(continuation.continue('bad',{kind:'zcode-thread',target:'bad'}),/Invalid ZCode/);
});
