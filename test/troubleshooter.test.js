import test from 'node:test';
import assert from 'node:assert/strict';
import { pendingTroubleshooterTasks, troubleshooterTaskId } from '../dist/troubleshooter.js';
import { InMemoryStore } from '../dist/store.js';
import { Reconciler } from '../dist/reconciler.js';
import { MemoryEventBus } from '../dist/events.js';
import { resolveExecutionContext, executionContextPrompt } from '../dist/execution-context.js';

const now = () => new Date().toISOString();

function failedReview() {
  return {
    jobId: 'neo-pr40',
    id: 'final-review-3a941f98a1ad',
    kind: 'work',
    priority: 'P1',
    storySize: 'M',
    projectName: 'Neo PR 40',
    agentName: 'reviewer',
    parentTaskId: null,
    dependencies: ['implementation'],
    capabilities: ['review'],
    workerSelection: {
      workerId: 'chatgpt/browser-worker',
      adapter: 'chatgpt',
      capabilities: ['model', 'browser-harness'],
      selectedBy: 'test',
      selectedAt: now(),
    },
    adapter: 'chatgpt',
    input: 'review exact head',
    output: { kind: 'task_pr' },
    routing: { provider: 'chatgpt', model: 'account-defaults', decidedBy: 'test', decidedAt: now() },
    state: 'FAILED',
    attempt: 1,
    maxAttempts: 2,
    leaseOwner: null,
    leaseExpiresAt: null,
    executionId: null,
    threadId: null,
    result: null,
    error: 'Worker delivery failed: Temporary Chat toggle was not uniquely observed',
    timeoutMs: 900000,
    createdAt: now(),
    updatedAt: now(),
    continuation: null,
    continuationDeliveredAt: null,
  };
}

function job(tasks) {
  return {
    id: 'neo-pr40',
    title: 'Neo PR 40',
    objective: 'finish the original job',
    executionMode: 'fixed',
    reviewEnabled: true,
    autoMerge: true,
    prNumber: 40,
    repository: 'lalalic/neo',
    state: 'ACTIVE',
    continuation: null,
    createdAt: now(),
    updatedAt: now(),
    tasks,
  };
}

test('troubleshooter recovery is P0, evidence-rich, local-capable, and idempotent per failed attempt', () => {
  const failed = failedReview();
  const [recovery] = pendingTroubleshooterTasks(job([failed]));
  assert.equal(recovery.id, troubleshooterTaskId(failed));
  assert.equal(recovery.agentName, 'troubleshooter');
  assert.equal(recovery.priority, 'P0');
  assert.deepEqual(recovery.workerRequirements, {
    capabilities: ['model', 'local_repo', 'iterative_tools'],
    runtime: 'codex',
  });
  assert.match(recovery.input, /chatgpt\/browser-worker/);
  assert.match(recovery.input, /Temporary Chat toggle was not uniquely observed/);
  assert.match(recovery.input, /P0\/self-job/);
  assert.deepEqual(pendingTroubleshooterTasks(job([failed, recovery])), []);
});

test('reconcile automatically creates and routes one troubleshooter for failed work', async () => {
  const failed = failedReview();
  const store = new InMemoryStore(job([failed]));
  const events = [];
  const adapter = {
    name: 'codex',
    id: 'codex',
    capabilities: ['model', 'codex'],
    launch() { throw new Error('maxConcurrent=0 should prevent launch'); },
  };
  const reconciler = new Reconciler(store, {
    owner: 'test',
    adapters: [adapter],
    eventBus: new MemoryEventBus(),
    maxConcurrent: 0,
    emit: event => events.push(event),
  });

  await reconciler.reconcile('neo-pr40');
  await reconciler.reconcile('neo-pr40');

  const durable = await store.load('neo-pr40');
  const recovery = durable.tasks.filter(task => task.agentName === 'troubleshooter');
  assert.equal(recovery.length, 1);
  assert.equal(recovery[0].state, 'QUEUED');
  assert.equal(recovery[0].adapter, 'codex');
  assert.equal(recovery[0].workerSelection?.workerId, 'codex');
  assert.equal(recovery[0].routing?.provider, 'openai');
  assert.equal(events.filter(event => event.type === 'troubleshooter.created').length, 1);
});

test('troubleshooter is a discoverable orchestrator-side execution role', async () => {
  const context = await resolveExecutionContext(process.cwd(), 'troubleshooter');
  const agent = context.agents.find(item => item.name === 'troubleshooter');
  assert.ok(agent?.path);
  assert.ok(agent.capabilities.includes('recovery'));
  const prompt = executionContextPrompt(context);
  assert.match(prompt, /Role: troubleshooter/);
  assert.match(prompt, /orchestrator-side recovery role/);
  assert.match(prompt, /P0\/self-job repair authority/);
});
