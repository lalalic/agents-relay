import test from 'node:test';
import assert from 'node:assert/strict';
import { createJobBody, getJson, postJson, startGateway } from './gateway-fake.js';

test('create_job schema rejects malformed and oversized requests without touching GitHub', async () => {
  const gateway = await startGateway();
  try {
    const cases = [
      { label: 'missing intent', body: { project: 'agents-relay', idempotency_key: 'k' }, code: 'invalid_request' },
      { label: 'empty project', body: { intent: 'x', project: '', idempotency_key: 'k' }, code: 'invalid_request' },
      { label: 'unknown project field instead of project', body: { intent: 'x', project: 'agents relay', idempotency_key: 'k' }, code: 'invalid_request' },
      { label: 'bad idempotency key', body: { intent: 'x', project: 'agents-relay', idempotency_key: 'has space' }, code: 'invalid_request' },
      { label: 'too many requirements', body: { intent: 'x', project: 'agents-relay', idempotency_key: 'k', requirements: Array.from({ length: 33 }, (_, index) => `r${index}`) }, code: 'invalid_request' },
      { label: 'extra repository field', body: { ...createJobBody(), repository: 'evil/repo' }, code: 'unknown_field' },
      { label: 'extra parent.task_id array shape', body: { ...createJobBody(), parent: { task_id: 7 } }, code: 'invalid_request' }
    ];
    for (const item of cases) {
      const response = await postJson(gateway.url, item.body);
      assert.equal(response.status, 400, item.label);
      assert.equal(response.body.error.code, item.code, item.label);
      assert.equal(response.body.error.retryable, false, item.label);
    }

    const oversized = await postJson(gateway.url, JSON.stringify({ ...createJobBody(), intent: 'x'.repeat(70000) }));
    assert.equal(oversized.status, 413);
    assert.equal(oversized.body.error.code, 'payload_too_large');

    const wrongType = await postJson(gateway.url, createJobBody(), { contentType: 'text/plain' });
    assert.equal(wrongType.status, 415);
    assert.equal(wrongType.body.error.code, 'unsupported_media_type');

    const notJson = await postJson(gateway.url, '{not json');
    assert.equal(notJson.status, 400);
    assert.equal(notJson.body.error.code, 'invalid_request');

    assert.equal(gateway.fake.counters.calls, 0);
    assert.equal(gateway.fake.counters.writes, 0);
  } finally {
    await gateway.close();
  }
});

test('every route except /healthz requires the bearer token before any GitHub call', async () => {
  const gateway = await startGateway();
  try {
    const health = await fetch(`${gateway.url}/healthz`);
    assert.equal(health.status, 204);
    assert.equal(await health.text(), '');

    const noToken = await postJson(gateway.url, createJobBody(), { token: null });
    assert.equal(noToken.status, 401);
    assert.equal(noToken.body.error.code, 'unauthorized');

    const wrongToken = await postJson(gateway.url, createJobBody(), { token: 'not-the-token' });
    assert.equal(wrongToken.status, 401);
    assert.equal(wrongToken.body.error.message.length > 0, true);

    const readWithoutToken = await getJson(gateway.url, '/v1/jobs/agents-relay-0123456789abcdef', { token: null });
    assert.equal(readWithoutToken.status, 401);

    const openApiWithoutToken = await getJson(gateway.url, '/v1/openapi.json', { token: null });
    assert.equal(openApiWithoutToken.status, 401);

    const unknownRoute = await getJson(gateway.url, '/v1/unknown', { token: null });
    assert.equal(unknownRoute.status, 401);

    assert.equal(gateway.fake.counters.calls, 0);
  } finally {
    await gateway.close();
  }
});

test('the served OpenAPI document exposes create_job, get_job, and the data-handling warning', async () => {
  const gateway = await startGateway();
  try {
    const response = await getJson(gateway.url, '/v1/openapi.json');
    assert.equal(response.status, 200);
    assert.equal(response.body.openapi, '3.1.0');
    const create = response.body.paths['/v1/jobs'].post;
    assert.equal(create.operationId, 'create_job');
    assert.ok(create.description.includes('become durable GitHub PR content'));
    assert.ok(create.description.includes('must not send secrets, credentials, tokens, or private data'));
    assert.equal(create.requestBody.content['application/json'].schema.additionalProperties, false);
    assert.deepEqual(create.requestBody.content['application/json'].schema.required, ['intent', 'project', 'idempotency_key']);
    assert.deepEqual(Object.keys(create.requestBody.content['application/json'].schema.properties).sort(), ['agent', 'context', 'idempotency_key', 'intent', 'parent', 'project', 'requirements']);
    assert.equal(response.body.paths['/v1/jobs/{job_id}'].get.operationId, 'get_job');
    assert.equal(response.body.paths['/healthz'].get.security.length, 0);
    assert.equal(response.body.paths['/v1/jobs/{job_id}'].get.responses['200'].content['application/json'].schema.properties.tasks.description.includes('never returned'), true);
  } finally {
    await gateway.close();
  }
});

test('unknown routes and methods return 404 after authentication', async () => {
  const gateway = await startGateway();
  try {
    const unknownPath = await getJson(gateway.url, '/v1/nope');
    assert.equal(unknownPath.status, 404);
    assert.equal(unknownPath.body.error.code, 'not_found');

    const wrongMethod = await getJson(gateway.url, '/v1/jobs');
    assert.equal(wrongMethod.status, 404);

    const nestedId = await getJson(gateway.url, '/v1/jobs/a/b');
    assert.equal(nestedId.status, 404);

    assert.equal(gateway.fake.counters.calls, 0);
  } finally {
    await gateway.close();
  }
});
