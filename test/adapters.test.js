import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildCodexArgs, CodexAdapter } from '../dist/adapters.js';

test('buildCodexArgs applies provider, model, reasoning, cwd, and profile in order', () => {
  const args = buildCodexArgs({
    provider: 'zai',
    model: 'glm-5.3-flash',
    reasoning: 'medium',
    cwd: '/workspace/project',
    profile: 'relay',
  }, 'inspect runtime');
  assert.deepEqual(args, [
    'exec',
    '--json',
    '-p', 'relay',
    '-m', 'glm-5.3-flash',
    '-c', 'model_provider=zai',
    '-c', 'model_reasoning_effort=medium',
    '-C', '/workspace/project',
    '--', 'inspect runtime',
  ]);
});

test('buildCodexArgs omits absent optional routing fields', () => {
  const args = buildCodexArgs({ provider: 'zai', model: 'glm-5.3-flash' }, 'prompt');
  assert.deepEqual(args, [
    'exec',
    '--json',
    '-m', 'glm-5.3-flash',
    '-c', 'model_provider=zai',
    '--', 'prompt',
  ]);
});

test('CodexAdapter buffers a thread id emitted before callback attachment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-relay-codex-'));
  try {
    const command = join(root, 'codex');
    await writeFile(command, [
      '#!/bin/sh',
      `printf '%s\\n' '${JSON.stringify({ type: 'thread.started', thread_id: 'early-thread' })}'`,
      'while true; do sleep 0.1; done',
    ].join('\n'), { mode: 0o700 });
    await chmod(command, 0o700);
    const adapter = new CodexAdapter(command);
    const execution = adapter.launch({
      id: 'task',
      input: 'prompt',
      routing: { provider: 'zai', model: 'glm-5.3-flash' },
    }, new AbortController().signal);
    let observedThreadId;
    execution.onThreadStarted = threadId => { observedThreadId = threadId; };
    execution.promise.catch(() => {});
    for (let attempts = 0; attempts < 100 && observedThreadId === undefined; attempts += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(execution.threadId, 'early-thread');
    assert.equal(observedThreadId, 'early-thread');
    execution.cancel();
    await execution.promise.catch(() => {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ChatGptAdapter treats configured MacBridge URL as an origin', async () => {
  let requestedUrl = '';
  const root = await mkdtemp(join(tmpdir(), 'agents-relay-origin-'));
  const tokenFile = join(root, 'token'); await writeFile(tokenFile, 'test-token');
  const { ChatGptAdapter } = await import('../dist/adapters.js');
  const adapter = new ChatGptAdapter({
    endpoint: 'http://127.0.0.1:8788/v1/responses',
    tokenFile,
    fetch: async input => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ complete: true, conversation_id: 'conv-origin', assistant_text: 'ok' }), { status: 200 });
    },
  });
  const task = { id: 'origin', input: 'test', routing: { provider: 'openai', model: 'gpt-5.6-sol' } };
  await adapter.launch(task, new AbortController().signal).promise;
  assert.equal(requestedUrl, 'http://127.0.0.1:8788/experimental/chatgpt/conversation');
  await rm(root, { recursive: true, force: true });
});

test('ChatGptAdapter launches through MacBridge and exposes conversation id as thread id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-relay-chatgpt-'));
  try {
    const tokenFile = join(root, 'http-token');
    await writeFile(tokenFile, 'secret-token\n', { mode: 0o600 });
    let request;
    const adapter = new (await import('../dist/adapters.js')).ChatGptAdapter({
      endpoint: 'http://127.0.0.1:9999',
      tokenFile,
      fetch: async (input, init) => {
        request = { input: String(input), init };
        return new Response(JSON.stringify({ complete: true, conversation_id: 'chat-thread-1', assistant_text: 'finished work' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const execution = adapter.launch({
      id: 'chat-task',
      input: 'build the feature',
      timeoutMs: 120000,
      threadId: null,
      routing: { provider: 'openai', model: 'gpt-5-6-pro', reasoning: 'high', projectId: 'g-p-12345678' },
    }, new AbortController().signal);
    let observedThreadId;
    execution.onThreadStarted = threadId => { observedThreadId = threadId; };
    const result = await execution.promise;
    assert.equal(request.input, 'http://127.0.0.1:9999/experimental/chatgpt/conversation');
    assert.equal(request.init.headers.authorization, 'Bearer secret-token');
    const body = JSON.parse(request.init.body);
    assert.deepEqual(body, {
      prompt: 'build the feature',
      model: 'gpt-5-6-pro',
      thinking_effort: 'high',
      max_runtime_seconds: 120,
      project_id: 'g-p-12345678',
    });
    assert.equal(execution.threadId, 'chat-thread-1');
    assert.equal(observedThreadId, 'chat-thread-1');
    assert.equal(result.summary, 'finished work');
    assert.equal(result.data.conversationId, 'chat-thread-1');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ChatGptAdapter continues an existing conversation on retry and normalizes medium reasoning', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-relay-chatgpt-retry-'));
  try {
    const tokenFile = join(root, 'http-token');
    await writeFile(tokenFile, 'token', { mode: 0o600 });
    let body;
    const { ChatGptAdapter } = await import('../dist/adapters.js');
    const adapter = new ChatGptAdapter({
      endpoint: 'http://127.0.0.1:9999/experimental/chatgpt/conversation',
      tokenFile,
      fetch: async (_input, init) => {
        body = JSON.parse(init.body);
        return new Response(JSON.stringify({ complete: true, conversation_id: 'existing-thread', assistant_text: 'continued' }), { status: 200 });
      },
    });
    const result = await adapter.launch({
      id: 'retry-task', input: 'continue', timeoutMs: 10000, threadId: 'existing-thread',
      routing: { provider: 'openai', model: 'gpt-5-6', reasoning: 'medium' },
    }, new AbortController().signal).promise;
    assert.equal(body.conversation_id, 'existing-thread');
    assert.equal(body.thinking_effort, 'standard');
    assert.equal(body.max_runtime_seconds, 30);
    assert.equal(result.summary, 'continued');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ChatGptAdapter exposes conversation id before the response body completes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-relay-chatgpt-early-thread-'));
  try {
    const tokenFile = join(root, 'http-token');
    await writeFile(tokenFile, 'token', { mode: 0o600 });
    let finishResponse;
    const { ChatGptAdapter } = await import('../dist/adapters.js');
    const adapter = new ChatGptAdapter({
      endpoint: 'http://127.0.0.1:9999',
      tokenFile,
      fetch: async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"conversation_id":"early-chat-thread","complete":'));
          finishResponse = () => {
            controller.enqueue(new TextEncoder().encode('true,"assistant_text":"done"}'));
            controller.close();
          };
        },
      }), { status: 200 }),
    });
    const execution = adapter.launch({
      id: 'early-chat-task', input: 'work', timeoutMs: 10000, threadId: null,
      routing: { provider: 'openai', model: 'gpt-5-6' },
    }, new AbortController().signal);
    let observedThreadId;
    execution.onThreadStarted = threadId => { observedThreadId = threadId; };
    for (let attempts = 0; attempts < 100 && observedThreadId === undefined; attempts += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(execution.threadId, 'early-chat-thread');
    assert.equal(observedThreadId, 'early-chat-thread');
    assert.equal(typeof finishResponse, 'function');
    finishResponse();
    assert.equal((await execution.promise).summary, 'done');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ChatGptAdapter keeps an exposed conversation id when response transport fails later', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-relay-chatgpt-transport-fail-'));
  try {
    const tokenFile = join(root, 'http-token');
    await writeFile(tokenFile, 'token', { mode: 0o600 });
    let failResponse;
    const { ChatGptAdapter } = await import('../dist/adapters.js');
    const adapter = new ChatGptAdapter({
      endpoint: 'http://127.0.0.1:9999',
      tokenFile,
      fetch: async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"conversation_id":"durable-chat-thread","complete":'));
          failResponse = () => controller.error(new Error('transport lost after thread creation'));
        },
      }), { status: 200 }),
    });
    const execution = adapter.launch({
      id: 'failed-chat-task', input: 'work', timeoutMs: 10000, threadId: null,
      routing: { provider: 'openai', model: 'gpt-5-6' },
    }, new AbortController().signal);
    let observedThreadId;
    execution.onThreadStarted = threadId => { observedThreadId = threadId; };
    for (let attempts = 0; attempts < 100 && observedThreadId === undefined; attempts += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(observedThreadId, 'durable-chat-thread');
    assert.equal(typeof failResponse, 'function');
    failResponse();
    await assert.rejects(execution.promise, /transport lost after thread creation/);
    assert.equal(execution.threadId, 'durable-chat-thread');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ChatGptAdapter deletes a durable conversation through the MacBridge wrapper', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-relay-chatgpt-delete-'));
  try {
    const tokenFile = join(root, 'http-token');
    await writeFile(tokenFile, 'delete-token', { mode: 0o600 });
    let request;
    const { ChatGptAdapter } = await import('../dist/adapters.js');
    const adapter = new ChatGptAdapter({
      endpoint: 'http://127.0.0.1:9999', tokenFile,
      fetch: async (input, init) => { request={input:String(input),init}; return new Response(JSON.stringify({ deleted: true }), { status: 200 }); },
    });
    await adapter.deleteThread('chat-thread-delete');
    assert.equal(request.input,'http://127.0.0.1:9999/experimental/chatgpt/conversation');
    assert.equal(request.init.method,'DELETE');
    assert.equal(request.init.headers.authorization,'Bearer delete-token');
    assert.deepEqual(JSON.parse(request.init.body),{conversation_id:'chat-thread-delete'});
  } finally { await rm(root,{recursive:true,force:true}); }
});
