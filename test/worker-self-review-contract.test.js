import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedWorkerInput } from '../dist/managed-worker-input.js';

test('mandatory self-review is delivered to both worker adapters even with no named agent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-self-review-'));
  const previous = process.env.AGENTS_RELAY_PROMPT_REFERENCE_DIR;
  process.env.AGENTS_RELAY_PROMPT_REFERENCE_DIR = dir;
  try {
    for (const adapter of ['codex', 'chatgpt']) {
      for (const [agentName, review, shouldReview] of [
        [undefined, undefined, true],
        ['implementation', undefined, true],
        ['custom-editor', undefined, true],
        ['review-chair', { role: 'chair' }, false],
        ['review-chair', undefined, false],
        ['specialist', { role: 'specialist' }, false],
        ['reviewer', undefined, false],
        ['planner', undefined, false],
        ['troubleshooter', undefined, false],
      ]) {
        const task = {
          id: 'task', jobId: 'test-job', agentName, review, adapter,
          state: 'QUEUED', kind: 'work', input: 'Do the task',
          output: { kind: 'task_pr' }, executionId: 'test-exec',
          attempt: 1, maxAttempts: 3, dependencies: [],
        };
        // No resolved execution context: prove that a producer need not explicitly
        // select the implementation agent or its bundled Markdown.
        const prompt = await managedWorkerInput({
          id: 'test-job', repository: 'example/repo', title: 'Test',
          objective: 'Implement and verify', state: 'ACTIVE',
          localMerge: { sourceRef: 'main' }, tasks: [task], plans: [],
        }, task);
        const match = prompt.match(/^- instructions: (.+) \(sha256:([a-f0-9]{64})\)$/m);
        assert.ok(match, `${adapter}/${agentName ?? 'unnamed'} must have a pinned prompt`);
        const instructions = await readFile(match[1], 'utf8');
        if (shouldReview) {
          assert.match(instructions, /Mandatory worker self-review/);
          assert.match(instructions, /latest complete self-review finds \*\*no changes required\*\*/);
          assert.match(instructions, /does not replace.*independent SHA-bound final Reviewer/);
          assert.match(instructions, /durable Task result/);
        } else {
          assert.doesNotMatch(instructions, /Mandatory worker self-review/);
        }
      }
    }
  } finally {
    if (previous === undefined) delete process.env.AGENTS_RELAY_PROMPT_REFERENCE_DIR;
    else process.env.AGENTS_RELAY_PROMPT_REFERENCE_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
