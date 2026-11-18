import test, { managedDashboard } from './test-runtime.js';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { dashboardJelFunction } from '../dist/dashboard-html.js';
import { jobJelDiagram } from '../dist/dashboard-jel.js';
import { InMemoryStore } from '../dist/store.js';

const job = {
  id: 'pwa-job', title: 'PWA job', repository: 'local/repo', prNumber: 0,
  state: 'ACTIVE', continuation: null, createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(), tasks: [],
};
const asset = path => readFileSync(new URL('../dashboard/' + path, import.meta.url));

test('PWA frontend assets load independently and real-time API remains uncached', async () => {
  const server = managedDashboard(new InMemoryStore(job), 0, undefined, 300000, job.id);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = 'http://127.0.0.1:' + address.port;

  for (const [path, name, type] of [
    ['/dashboard.js', 'dashboard.js', 'text/javascript'],
    ['/vendor/markdown-it.min.js', 'vendor/markdown-it.min.js', 'text/javascript'],
    ['/dashboard.css', 'dashboard.css', 'text/css'],
    ['/pwa.js', 'pwa.js', 'text/javascript'],
    ['/service-worker.js', 'service-worker.js', 'text/javascript'],
    ['/manifest.webmanifest', 'manifest.webmanifest', 'application/manifest+json'],
    ['/icons/icon-180.png', 'icons/icon-180.png', 'image/png'],
    ['/icons/icon-192.png', 'icons/icon-192.png', 'image/png'],
    ['/icons/icon-512.png', 'icons/icon-512.png', 'image/png'],
  ]) {
    const res = await fetch(base + path);
    assert.equal(res.status, 200, path);
    assert.ok(res.headers.get('content-type').startsWith(type), path);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), asset(name), path);
  }
  const htmlRes = await fetch(base + '/');
  assert.equal(htmlRes.status, 200);
  assert.equal(htmlRes.headers.get('cache-control'), 'no-store');
  const html = await htmlRes.text();
  assert.match(html, /<link rel="manifest" href="\/manifest.webmanifest">/);
  assert.match(html, /<script src="\/dashboard-config.js" defer><\/script>/);
  assert.match(html, /<script src="\/dashboard.js" defer><\/script>/);
  assert.match(html, /<script src="\/pwa.js" defer><\/script>/);
  assert.doesNotMatch(html, /<script>\s*'use strict';/);
  const cfg = await fetch(base + '/dashboard-config.js');
  assert.equal(cfg.headers.get('cache-control'), 'no-store');
  const script = await cfg.text();
  assert.doesNotThrow(() => new Script(script));
  assert.match(script, /buildJelDiagram:function jobJelDiagram\(/);
  const manifest = JSON.parse(asset('manifest.webmanifest'));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/');

  const jobs = await fetch(base + '/api/jobs');
  assert.equal(jobs.headers.get('cache-control'), 'no-store');
  const sse = await fetch(base + '/events');
  assert.equal(sse.headers.get('content-type'), 'text/event-stream');
  sse.body.cancel();
});

test('PWA service worker excludes durable job data and SSE from caching', () => {
  const sw = asset('service-worker.js').toString();
  assert.match(sw, /new Set\(ASSETS\)/);
  assert.match(sw, /vendor\/markdown-it.min.js/);
  assert.match(sw, /ALLOWED\.has\(url\.pathname\)/);
  assert.doesNotMatch(sw, /['"]\/api\//);
  assert.doesNotMatch(sw, /['"]\/events['"]/);
  assert.doesNotMatch(sw, /['"]\/dashboard-config\.js['"]/);
  assert.equal(dashboardJelFunction, jobJelDiagram.toString(),
    'shared frontend JEL JS must be regenerated if its TypeScript source changes');
  const client = asset('dashboard.js').toString();
  assert.doesNotThrow(() => new Script(client));
  assert.match(client, /new EventSource\('\/events'\)/);
});

test('PWA asset routes reject non-GET methods and traversal', async () => {
  const server = managedDashboard(new InMemoryStore(job), 0, undefined, 300000, job.id);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = 'http://127.0.0.1:' + address.port;
  for (const [path, init] of [
    ['/dashboard.js', {method:'POST'}],
    ['/icons/unknown.png', {}],
    ['/dashboard/private-key', {}],
  ]) {
    const response = await fetch(base + path, init);
    assert.equal(response.status, 404, path);
  }
});
