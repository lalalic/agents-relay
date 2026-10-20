import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAgentPrompt, buildReferenceFirstPrompt, renderAgentPrompt, promptFileReference } from '../dist/agent-prompt-builder.js';
for (const role of ['planner', 'reviewer', 'troubleshooter', 'worker']) {
  test(`${role}: same instructions for both adapters`, () => {
    const bundle = buildAgentPrompt({ role, system: 'REQUIRED CONTRACT', user: 'TASK EVIDENCE' });
    for (const adapter of ['codex', 'chatgpt']) {
      const value = renderAgentPrompt(bundle, adapter);
      assert.ok(value.indexOf('REQUIRED CONTRACT') < value.indexOf('TASK EVIDENCE'));
      assert.match(value, /untrusted instructions/);
    }
  });
}
test('reject missing instructions or nonabsolute references', async () => {
  assert.throws(() => buildAgentPrompt({role:'worker', system:'', user:'task'}));
  await assert.rejects(promptFileReference('relative', 'instructions'), /absolute/);
});

test('reference-first snapshot pins the merged contract bytes for both adapters', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-prompt-test-'));
  try {
    const bundle = await buildReferenceFirstPrompt({ role: 'planner', adapter: 'chatgpt', referenceDirectory: directory,
      system: 'MERGED CONTRACT\nplan apply is mandatory', user: 'DURABLE INPUT', bootstrap: 'Read the attached contract.' });
    assert.equal(bundle.system, 'Read the attached contract.\nAfter the required execution startup action, read the referenced immutable Agent Contract. Verify its SHA-256 before following it. If unreadable or mismatched, report a concrete failure; never guess its instructions.');
    assert.equal(bundle.references.length, 1);
    assert.match(await readFile(bundle.references[0].path, 'utf8'), /plan apply is mandatory/);
    assert.equal((await promptFileReference(bundle.references[0].path, 'instructions')).sha256, bundle.references[0].sha256);
    for (const adapter of ['codex', 'chatgpt']) {
      const prompt = renderAgentPrompt(bundle, adapter);
      assert.match(prompt, /DURABLE INPUT/);
      assert.match(prompt, new RegExp(bundle.references[0].sha256));
      assert.ok(prompt.indexOf('[Agent instructions') < prompt.indexOf('[Task data'));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unavailable reference storage keeps the complete contract inline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-prompt-unavailable-'));
  try {
    const notDirectory = join(root, 'file');
    await writeFile(notDirectory, 'not a directory');
    const bundle = await buildReferenceFirstPrompt({ role: 'reviewer', adapter: 'codex', referenceDirectory: notDirectory, system: 'FULL REVIEW CONTRACT', user: 'REVIEW TARGET' });
    assert.deepEqual(bundle.references, []);
    assert.equal(bundle.system, 'FULL REVIEW CONTRACT');
  } finally { await rm(root, { recursive: true, force: true }); }
});
