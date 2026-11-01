import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { zExecutionSource, zBootstrap, zTaskBrief, ZAdapter } from '../dist/z-adapter.js';

const source='job/27/task/html-e2e/execution/123e4567-e89b-12d3-a456-426614174000';
const managedPrompt='# Role\nYou are implementation with responsibility at /tmp/example.md.\n\n## Contracts\n1. /tmp/event-contract.md\n\n## Contexts\n1. /tmp/AGENTS.md\n\n## Task\nJob: 27\nTask: html-e2e\nExecution: 123e4567-e89b-12d3-a456-426614174000';
test('Z binds the Graph-issued execution identity',()=>{
  assert.equal(zExecutionSource(managedPrompt),source);
  assert.throws(()=>zExecutionSource('No source'),/Graph-issued/);
});
test('Z worker uses the same manual bootstrap entry, keeping Graph Task Prompt byte-identical',()=>{
  const startup=zBootstrap('test-fake-token',managedPrompt);
  assert.match(startup,/https:\/\/neoy\.qili2\.com\/files\/z-chat\/bootstrap\.md/);
  assert.ok(startup.indexOf('FIRST ACTION') < startup.indexOf('Then follow the manual'));
  const posted=JSON.parse(startup.split('\n').find(line=>line.startsWith('curl ')).match(/--data-binary '([^']+)'$/)?.[1]);
  assert.equal(posted.params.arguments.args.source,source);
  assert.equal(posted.params.arguments.args.type,'task.started');
  assert.equal(zTaskBrief(managedPrompt),managedPrompt);
  assert.equal(startup+'\n'+zTaskBrief(managedPrompt),startup+'\n'+managedPrompt);
});

test('Z browser session remains leased until Relay terminal event', () => {
  assert.equal(new ZAdapter().tabClosePolicy, 'after-terminal');
});
