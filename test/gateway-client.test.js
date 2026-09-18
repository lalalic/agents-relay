import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GhCliClient, GitHubRequestError, isConflict, isNotFound } from '../dist/gateway/github.js';

/**
 * Fake `gh` executable: records its argv and stdin, then answers with canned `--include` output.
 * The gateway must keep the HTTP status so it can tell "branch missing" (404) from "branch exists" (422).
 */
const FAKE_GH = `#!/bin/sh
printf '%s' "$*" > "$0.args"
cat > "$0.stdin"
case "$2" in
  */missing) printf 'HTTP/2.0 404\\r\\n\\r\\n{"message":"Not Found"}'; exit 0 ;;
  */taken) printf 'HTTP/2.0 422\\r\\n\\r\\n{"message":"Reference already exists"}'; exit 0 ;;
  */empty) printf 'HTTP/2.0 204\\r\\n\\r\\n'; exit 0 ;;
esac
printf 'HTTP/2.0 200\\r\\ncontent-type: application/json\\r\\n\\r\\n{"ok":true}'
`;

const CRASHING_GH = `#!/bin/sh
printf 'gh: not logged in\\n' >&2
exit 3
`;

async function withFakeGh(script, run) {
  const directory = await mkdtemp(join(tmpdir(), 'agents-relay-gh-'));
  const path = join(directory, 'gh');
  await writeFile(path, script);
  await chmod(path, 0o755);
  try {
    return await run(path, `${path}.args`, `${path}.stdin`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('the gh client keeps HTTP status, parses bodies, and forwards method and stdin', async () => {
  await withFakeGh(FAKE_GH, async (command, argsPath, stdinPath) => {
    const client = new GhCliClient(command);

    const ok = await client.request('/repos/lalalic/agents-relay/pulls', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"probe":true}' });
    assert.deepEqual(ok, { ok: true });
    assert.equal(await readFile(argsPath, 'utf8'), 'api /repos/lalalic/agents-relay/pulls --include --method POST --input -');
    assert.equal(await readFile(stdinPath, 'utf8'), '{"probe":true}');

    const get = await client.request('/repos/lalalic/agents-relay/branches/main');
    assert.deepEqual(get, { ok: true });
    assert.equal(await readFile(argsPath, 'utf8'), 'api /repos/lalalic/agents-relay/branches/main --include');

    const empty = await client.request('/repos/lalalic/agents-relay/empty');
    assert.equal(empty, null);

    await assert.rejects(() => client.request('/repos/lalalic/agents-relay/missing'), error => {
      assert.ok(error instanceof GitHubRequestError);
      assert.equal(error.status, 404);
      assert.equal(isNotFound(error), true);
      assert.equal(isConflict(error), false);
      return true;
    });

    await assert.rejects(() => client.request('/repos/lalalic/agents-relay/taken'), error => {
      assert.ok(error instanceof GitHubRequestError);
      assert.equal(error.status, 422);
      assert.equal(isConflict(error), true);
      return true;
    });
  });
});

test('the gh client reports an unavailable transport instead of a fake success', async () => {
  await withFakeGh(CRASHING_GH, async command => {
    const client = new GhCliClient(command);
    await assert.rejects(() => client.request('/repos/lalalic/agents-relay/branches/main'), /not logged in/);
  });
});
