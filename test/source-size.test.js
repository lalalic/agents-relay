import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.isFile() && /\.(?:ts|js)$/.test(entry.name)) files.push(path);
  }
  return files;
}

test('production source files stay at or below 500 lines', async () => {
  const oversized = [];
  for (const path of await sourceFiles(new URL('../src', import.meta.url).pathname)) {
    const content = await readFile(path, 'utf8');
    const lines = content.split(/\r?\n/).length;
    if (lines > 500) oversized.push({ path, lines });
  }
  assert.deepEqual(oversized, []);
});


test('all test cases use the shared TestRuntime and lifecycle resources use managed helpers', async () => {
  const root = new URL('.', import.meta.url).pathname;
  const files = (await readdir(root)).filter(name => name.endsWith('.test.js'));
  const violations = [];
  for (const name of files) {
    const content = await readFile(join(root, name), 'utf8');
    if (!content.includes("from './test-runtime.js'")) violations.push(name + ': bypasses shared TestRuntime');
    if (/new\s+Reconciler\s*\(/.test(content)) violations.push(name + ': constructs Reconciler directly');
    if (/\bserveDashboard\s*\(/.test(content)) violations.push(name + ': constructs dashboard server directly');
  }
  assert.deepEqual(violations, []);
});
