import assert from 'node:assert/strict';
import test from './test-runtime.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateArtifact } from '../dist/cli-artifact.js';

test('artifact validation is explicit, read-only and reports schema errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-artifact-'));
  const artifact = join(dir, 'artifact.json');
  const schema = join(dir, 'schema.json');
  try {
    await writeFile(schema, JSON.stringify({
      type: 'object', required: ['title'], additionalProperties: false,
      properties: { title: { type: 'string', minLength: 1 } },
    }));
    await writeFile(artifact, JSON.stringify({ title: 'Episode' }));
    assert.deepEqual(await validateArtifact(artifact, schema), { valid: true, errors: [] });
    let result = spawnSync(process.execPath, ['dist/cli.js', 'artifact', 'validate', '--artifact', artifact, '--schema', schema], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).valid, true);

    await writeFile(artifact, JSON.stringify({ title: 42, unexpected: true }));
    const invalid = await validateArtifact(artifact, schema);
    assert.equal(invalid.valid, false);
    assert.equal(invalid.errors.length, 2);
    result = spawnSync(process.execPath, ['dist/cli.js', 'artifact', 'validate', '--artifact', artifact, '--schema', schema], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).valid, false);

    await writeFile(artifact, '{not-json');
    await assert.rejects(validateArtifact(artifact, schema), SyntaxError);
    await writeFile(artifact, '{}');
    await writeFile(schema, '{bad-schema');
    await assert.rejects(validateArtifact(artifact, schema), SyntaxError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
