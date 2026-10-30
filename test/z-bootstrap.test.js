import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { zExecutionSource, zBootstrap, zTaskBrief, ZAdapter } from '../dist/z-adapter.js';

const source = 'job/27/task/html-e2e/execution/123e4567-e89b-12d3-a456-426614174000';
const managedPrompt = '[Agents Relay managed task]\nJob ID: 27\nTask ID: html-e2e\n[Required event contracts]\nExecution source: ' + source;
test('Z prompt must bind the one exact Relay execution source', () => {
  assert.equal(zExecutionSource(managedPrompt), source);
  assert.throws(() => zExecutionSource('No source'), /exactly one/);
  assert.throws(() => zExecutionSource(managedPrompt + '\nExecution source: ' + source), /exactly one/);
});
test('Z prompt prioritizes real started event before bootstrap and Task', () => {
  const prompt = zBootstrap('test-fake-token', managedPrompt);
  assert.ok(prompt.indexOf('EXECUTE NOW') < prompt.indexOf('THEN via'));
  assert.ok(prompt.indexOf('THEN via') < prompt.indexOf('Work on Neo Master'));
  for (const type of ['task.started', 'task.completed']) {
    const line = prompt.split('\n').find(l => l.includes('"type":"' + type + '"'));
    assert.ok(line, type);
    const envelope = line.startsWith('curl ') ? JSON.parse(line.match(/--data-binary '([^']+)'$/)?.[1]) : JSON.parse(line.slice('Completion JSON-RPC body: '.length));
    assert.equal(envelope.params.arguments.args.source, source);
  }
  assert.match(prompt,/Each Bash tool call has a fresh shell/);
  assert.match(prompt,/verify that exact literal with Neo fs read or shell grep -F/);
});


test('Local Relay Z brief keeps Task and output while preventing GitHub detours', () => {
  const prompt = [
    '[Relay agent: worker; adapter: z]',
    '[Agents Relay managed task]',
    'Treat the following durable task input as the authoritative work contract; do not query GitHub.',
    '',
    'Create test HTML MARKER',
    '',
    '[Authoritative execution context]',
    'Job objective: Verify real HTML',
    '[Output contract]',
    'file',
    'Path: /tmp/test-z.html',
    '[Required event contracts]',
    'Execution source: ' + source,
  ].join(String.fromCharCode(10));
  const brief = zTaskBrief(prompt);
  assert.match(brief, /Create test HTML MARKER/);
  assert.ok(brief.includes('Path: /tmp/test-z.html'));
  assert.match(brief, /Do NOT query GitHub/);
  assert.ok(brief.length < prompt.length + 300);
  assert.equal(zTaskBrief(prompt.replace('worker; adapter: z', 'reviewer; adapter: z')), prompt.replace('worker; adapter: z', 'reviewer; adapter: z'));
});

test('Z browser session remains leased until Relay terminal event', () => {
  assert.equal(new ZAdapter().tabClosePolicy, 'after-terminal');
});
