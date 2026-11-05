import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedWorkerInput } from '../dist/managed-worker-input.js';
import { resolveExecutionContext } from '../dist/execution-context.js';

test('mandatory self-review is delivered to both worker adapters even with no named agent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-self-review-'));
  const previous = process.env.AGENTS_RELAY_PROMPT_REFERENCE_DIR;
  process.env.AGENTS_RELAY_PROMPT_REFERENCE_DIR = dir;
  try {
    const project=process.cwd();
    const cx=await resolveExecutionContext(project,'worker');
    for (const adapter of ['codex', 'chatgpt']) {
      for (const [agentName, review, shouldReview] of [
        [undefined, undefined, true],
        ['implementation', undefined, true],

        ['review-chair', { role: 'chair' }, false],
        ['review-chair', undefined, false],
        ['reviewer', undefined, false],
        ['job-acceptance-reviewer', undefined, false],
        ['planner', undefined, false],
        ['troubleshooter', undefined, false],
      ]) {
        if(adapter==='chatgpt' && ['review-chair','planner','troubleshooter'].includes(agentName)) continue;
        const task = {
          id: 'task', jobId: 'test-job', agentName, review, adapter,
          state: 'QUEUED', kind: 'work', input: 'Do the task',
          output: { kind: 'task_pr' }, executionId: 'test-exec',
          attempt: 1, maxAttempts: 3, dependencies: [],
        };
        // Resolve the project once; the unnamed worker falls back to implementation.
        const prompt = await managedWorkerInput({
          id: 'test-job', repository: 'example/repo', title: 'Test',
          objective: 'Implement and verify', state: 'ACTIVE',
          localMerge: { sourceRef: 'main' }, tasks: [task], plans: [],projectPath:project,
        }, task,cx);
        assert.match(prompt,/^# Role\n/);
        if (shouldReview) {
          assert.match(prompt,/worker-self-review\.md/,'worker must receive pinned self-review contract');
          const link=prompt.match(/(\/[^\s]+\/worker-self-review\.md)/);
          assert.ok(link,'Missing independent self-review reference');
          const instructions=await readFile(link[1],'utf8');
          assert.match(instructions,/latest complete self-review finds \*\*no changes required\*\*/);
          assert.match(instructions,/does not replace.*independent SHA-bound final Reviewer/);
        } else {
          assert.doesNotMatch(prompt,/worker-self-review\.md/);
        }
      }
    }
  } finally {
    if (previous === undefined) delete process.env.AGENTS_RELAY_PROMPT_REFERENCE_DIR;
    else process.env.AGENTS_RELAY_PROMPT_REFERENCE_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
