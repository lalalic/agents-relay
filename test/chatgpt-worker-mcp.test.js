import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatGptAdapter, parseDriverJson } from '../dist/adapters.js';
import {fakeWebHelmDaemon} from './fake-webhelm-daemon.mjs';

test('new ChatGPT worker uses a Neo daemon Session and includes file references',async()=>{
  const root=await mkdtemp(join(tmpdir(),'relay-new-thread-mcp-'));
  const command=join(root,'fake-webhelm');
  await writeFile(command,[
    '#!/bin/sh',
    'if [ "$1" = "platform" ] && [ "$2" = "profile" ]; then printf \'{"platform":"%s"}\\n\' "$3";',
    'elif [ "$1" = "ensure" ]; then echo \'{"ok":true}\';',
    'else exit 12; fi',
  ].join('\n'),{mode:0o700});
  const old=process.env.AGENTS_RELAY_WEBHELM_COMMAND;
  process.env.AGENTS_RELAY_WEBHELM_COMMAND=command;
  const daemon=await fakeWebHelmDaemon(root,{onPlatformRun:req=>({
    status:'submitted',mode:'new-thread',temporary:false,
    thread_id:'6add12f0-ca3c-83e8-9457-0a6619057823',
    thread_url:'https://chatgpt.com/c/6add12f0-ca3c-83e8-9457-0a6619057823',verified_by:'send-button-disabled',
  })});
  try {
    const result=await new ChatGptAdapter().launch({id:'mcp-task',input:'Read the input through Neo',
      routing:{provider:'openai',model:'test'},attachments:['/tmp/evidence.txt'],
    },new AbortController().signal).promise;
    assert.equal(result.data.mode,'new-thread');
    assert.equal(result.data.submitted,true);
    assert.equal(result.data.threadId,'6add12f0-ca3c-83e8-9457-0a6619057823');
    const run=daemon.requests.find(r=>r.op==='platform-run');
    assert.equal(run.platform,'chatgpt');
    assert.equal(run.config.temporary,false);
    assert.match(run.config.message,/Read the input through Neo/);
    assert.match(run.config.message,/\/tmp\/evidence\.txt/);
    assert.equal(run.config.file,undefined);
    assert.equal(daemon.requests.filter(r=>r.op==='start'&&r.workspace==='Neo').length,1);
    assert.equal(daemon.requests.filter(r=>r.op==='stop').length,1);
  }finally{
    await daemon.close();
    if(old===undefined)delete process.env.AGENTS_RELAY_WEBHELM_COMMAND;
    else process.env.AGENTS_RELAY_WEBHELM_COMMAND=old;
    await rm(root,{recursive:true,force:true});
  }
});

test('normal-thread receipt rejects missing durable identity', async () => {
  assert.equal(parseDriverJson(JSON.stringify({ result: { stdout: JSON.stringify({
    status:'submitted',mode:'new-thread',temporary:false,thread_id:'6add12f0-ca3c-83e8-9457-0a6619057823',
    thread_url:'https://chatgpt.com/c/6add12f0-ca3c-83e8-9457-0a6619057823',verified_by:'send-button-disabled',
  }) } })).mode, 'new-thread');
  const adapter = new ChatGptAdapter({agentRunner:()=>({
    promise:Promise.resolve(JSON.stringify({status:'submitted',mode:'new-thread',temporary:false,verified_by:'composer-cleared'})),
    cancel(){},
  })});
  await assert.rejects(adapter.launch({
    id:'missing-thread',input:'text',routing:{provider:'openai',model:'test'},
  },new AbortController().signal).promise,/durable ChatGPT thread/);
});

test('existing-thread delivery holds its Neo session until terminal',async()=>{
  const root=await mkdtemp(join(tmpdir(),'relay-webhelm-sync-'));
  const command=join(root,'fake-webhelm');
  await writeFile(command,[
    '#!/bin/sh',
    'if [ "$1" = "platform" ] && [ "$2" = "profile" ]; then printf \'{"platform":"%s"}\\n\' "$3";',
    'elif [ "$1" = "ensure" ]; then echo \'{"ok":true}\';',
    'else exit 12; fi',
  ].join('\n'),{mode:0o700});
  const old=process.env.AGENTS_RELAY_WEBHELM_COMMAND;
  process.env.AGENTS_RELAY_WEBHELM_COMMAND=command;
  const daemon=await fakeWebHelmDaemon(root,{onPlatformRun:req=>({
    status:'submitted',mode:'new-turn',thread_id:'thread_12345678',
    thread_url:'https://chatgpt.com/c/thread_12345678',verified_by:'user-turn',
  })});
  try{
    const task={id:'thread-delivery',jobId:'job',executionId:'12345678-1234-1234-1234-123456789abc',
      input:'continue',timeoutMs:900000,routing:{provider:'openai',model:'test'},
      chatgptThreadDelivery:{threadId:'thread_12345678',requestId:'delivery-1'}};
    let resolveTerminal;const terminal=new Promise(resolve=>resolveTerminal=resolve);
    const execution=new ChatGptAdapter().launch(task,new AbortController().signal,{waitForTerminal:terminal});
    await execution.launched;
    assert.equal(daemon.requests.filter(r=>r.op==='stop').length,0);
    const run=daemon.requests.find(r=>r.op==='platform-run');
    assert.equal(run.action,'new-turn');
    assert.equal(run.config.mode,'sync');
    assert.equal(run.config.idempotency_key,'delivery-1');
    resolveTerminal();
    await execution.promise;
    assert.equal(daemon.requests.filter(r=>r.op==='stop').length,1);
  }finally{
    await daemon.close();
    if(old===undefined)delete process.env.AGENTS_RELAY_WEBHELM_COMMAND;
    else process.env.AGENTS_RELAY_WEBHELM_COMMAND=old;
    await rm(root,{recursive:true,force:true});
  }
});
