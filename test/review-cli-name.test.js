import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { helpText } from '../dist/cli-help.js';
import { runReviewCommand } from '../dist/cli-review.js';

test('review CLI exposes job and run, not request', () => {
  assert.match(helpText('root'), /review job\s+Request graph-owned review/);
  assert.match(helpText('review'), /review job --repo OWNER\/REPO/);
  assert.match(helpText('review job'), /Required: --repo OWNER\/REPO/);
  assert.match(helpText('review run'), /--prompt TEXT/);
  assert.doesNotMatch(helpText('root'), /review request\s/);
});

test('review job is accepted as the CLI action; old request action is rejected', async () => {
  await assert.rejects(runReviewCommand('job', []), /review job requires --repo and --id/);
  await assert.rejects(runReviewCommand('request', []), /review supports: job \| run/);
});

test('built CLI help and dispatch follow the renamed command', () => {
  const isolatedStore = mkdtempSync(join(tmpdir(), 'relay-review-job-cli-'));
  try {
    const env = { ...process.env, AGENTS_RELAY_STORE_DIR: isolatedStore };
    const run = args => spawnSync(process.execPath, [resolve('dist/cli.js'), ...args], { env, encoding: 'utf8' });
    const help = run(['review', '--help']);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /review job --repo OWNER\/REPO/);
    const jobHelp = run(['review', 'job', '--help']);
    assert.equal(jobHelp.status, 0, jobHelp.stderr);
    assert.match(jobHelp.stdout, /review job --repo OWNER\/REPO/);
    const newCommand = run(['review', 'job']);
    assert.notEqual(newCommand.status, 0);
    assert.match(newCommand.stderr, /review job requires --repo and --id/);
    const oldCommand = run(['review', 'request']);
    assert.notEqual(oldCommand.status, 0);
    assert.match(oldCommand.stderr, /review supports: job \| run/);
  } finally {
    rmSync(isolatedStore, { recursive: true, force: true });
  }
});
