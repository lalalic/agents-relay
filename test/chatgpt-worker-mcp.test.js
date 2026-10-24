import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatGptAdapter, parseDriverJson } from '../dist/adapters.js';

test('new ChatGPT worker uses durable regular thread with Neo-accessible file paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-new-thread-mcp-'));
  const executable = join(root, 'fake-webhelm');
  const trace = join(root, 'trace.jsonl');
  const script = [
    '#!/usr/bin/env node',
    "const fs=require('node:fs');",
    "const args=process.argv.slice(2);",
    "const config=args.includes('--config')?JSON.parse(fs.readFileSync(args[args.indexOf('--config')+1],'utf8')):null;",
    "fs.appendFileSync(process.env.RELAY_MCP_PROBE_TRACE,JSON.stringify({args,config})+'\\n');",
    "if(args[0]==='session'&&args[1]==='start')console.log(JSON.stringify({session_id:'owned-one'}));",
    "else if(args[0]==='session'&&args[1]==='stop')console.log(JSON.stringify({stopped:true}));",
    "else if(args[0]==='platform'&&args[3]==='new-thread')console.log(JSON.stringify({result:{ok:true,stdout:JSON.stringify({status:'submitted',mode:'new-thread',temporary:false,thread_id:'6add12f0-ca3c-83e8-9457-0a6619057823',thread_url:'https://chatgpt.com/c/6add12f0-ca3c-83e8-9457-0a6619057823',verified_by:'send-button-disabled'})}}));",
    "else process.exit(12);",
  ].join('\n');
  await writeFile(executable, script, { mode: 0o700 });
  const previousCommand = process.env.AGENTS_RELAY_WEBHELM_COMMAND;
  const previousTrace = process.env.RELAY_MCP_PROBE_TRACE;
  process.env.AGENTS_RELAY_WEBHELM_COMMAND = executable;
  process.env.RELAY_MCP_PROBE_TRACE = trace;
  try {
    const adapter = new ChatGptAdapter();
    const result = await adapter.launch({
      id:'mcp-task', input:'Read the input through Neo', routing:{ provider:'openai', model:'test' },
      attachments:['/tmp/evidence.txt'],
    }, new AbortController().signal).promise;
    assert.equal(result.data.mode, 'new-thread');
    assert.equal(result.data.submitted, true);
    assert.equal(result.data.threadId, '6add12f0-ca3c-83e8-9457-0a6619057823');
    const entries = (await readFile(trace,'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(entries.length, 3);
    assert.deepEqual(entries[1].args.slice(0,4), ['platform','run','chatgpt','new-thread']);
    assert.equal(entries[1].config.temporary, false);
    assert.match(entries[1].config.message, /Read the input through Neo/);
    assert.match(entries[1].config.message, /\/tmp\/evidence\.txt/);
    assert.equal(entries[1].config.file, undefined);
    assert.deepEqual(entries[2].args.slice(0,3), ['session','stop','owned-one']);
  } finally {
    if (previousCommand === undefined) delete process.env.AGENTS_RELAY_WEBHELM_COMMAND; else process.env.AGENTS_RELAY_WEBHELM_COMMAND = previousCommand;
    if (previousTrace === undefined) delete process.env.RELAY_MCP_PROBE_TRACE; else process.env.RELAY_MCP_PROBE_TRACE = previousTrace;
    await rm(root, {recursive:true,force:true});
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
