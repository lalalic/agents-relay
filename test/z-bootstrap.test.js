import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { zExecutionSource, zBootstrap, zTaskBrief, ZAdapter } from '../dist/z-adapter.js';
import { zWorkerMcpEndpoint } from '../dist/z-oauth.js';

const source='job/27/task/html-e2e/execution/123e4567-e89b-12d3-a456-426614174000';
const managedPrompt='# Role\nYou are implementation with responsibility at /tmp/example.md.\n\n## Bootstrap\nUse the Z interactive bootstrap.\n\n## Contracts\n1. /tmp/event-contract.md\n\n## Contexts\n1. /tmp/AGENTS.md\n\n## Task\nJob: 27\nTask: html-e2e\nExecution: 123e4567-e89b-12d3-a456-426614174000';
test('Z binds the Graph-issued execution identity',()=>{
  assert.equal(zExecutionSource(managedPrompt),source);
  assert.throws(()=>zExecutionSource('No source'),/Graph-issued/);
});
test('Z adds only its ephemeral token inside the one Graph Action Bootstrap section',()=>{
  const startup=zBootstrap('test-fake-token',managedPrompt);
  assert.match(startup,/^# Role\n/);
  assert.match(startup,/## Bootstrap\nOAuth access token: test-fake-token\n/);
  assert.equal(startup.split('OAuth access token:').length,2);
  assert.equal(startup.replace('OAuth access token: test-fake-token\n',''),managedPrompt);
  assert.doesNotMatch(startup,/Z\.ai Full-Stack worker|FIRST ACTION:|Completion JSON-RPC body:|\(sha256:/);
  assert.equal(zTaskBrief(managedPrompt),managedPrompt);
  assert.throws(()=>zBootstrap('bad\nsecret',managedPrompt),/Invalid Z worker credential/);
  assert.throws(()=>zBootstrap('test-fake-token','No source'),/Graph-issued/);
});

test('Z browser session remains leased until Relay terminal event', () => {
  assert.equal(new ZAdapter().tabClosePolicy, 'after-terminal');
});


test('Z transport adds a configured MCP endpoint without hardcoded Neo URLs', () => {
  const endpoint=zWorkerMcpEndpoint('https://gateway.example/');
  assert.equal(endpoint,'https://gateway.example/mcp');
  const startup=zBootstrap('ephemeral-test-token',managedPrompt,endpoint);
  assert.match(startup,/Configured MCP endpoint: https:\/\/gateway\.example\/mcp/);
  assert.match(startup,/Connect using the short-lived OAuth access token/);
  assert.equal(startup.split('OAuth access token:').length,2);
  assert.doesNotMatch(startup,/neoy\.qili2\.com|Neo MCP|https:\/\/undefined/);
  assert.throws(()=>zWorkerMcpEndpoint('http://untrusted.example'),/must be HTTPS/);
  assert.throws(()=>zWorkerMcpEndpoint(''),/must be HTTPS/);
});
