import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardHtml, githubPrUrl } from '../dist/dashboard.js';

test('dashboard exposes the operations-console structure safely', () => {
  assert.match(dashboardHtml, /data-dashboard-contract="safe-dom,named-relay-events,snapshot-events,bounded-event-history"/);
  assert.match(dashboardHtml, /Account usage/);
  assert.match(dashboardHtml, /id="events-panel"/);
  assert.match(dashboardHtml, /function taskNode\(/);
  assert.match(dashboardHtml, /function renderTaskDetail\(/);
  assert.match(dashboardHtml, /sessionStorage\.setItem\('agents-relay:selected-job'/);
  assert.match(dashboardHtml, /sessionStorage\.setItem\('agents-relay:selected-task'/);
  assert.doesNotMatch(dashboardHtml, /innerHTML|document\.write/);
});

test('selected job title appears in the panel heading', () => {
  assert.match(dashboardHtml, /id="selected-job-title"/);
  assert.match(dashboardHtml, /selectedJobTitle\.textContent='— '\+value\(job\.title\|\|job\.id\)/);
  assert.doesNotMatch(dashboardHtml, /field\('Title'/);
  assert.doesNotMatch(dashboardHtml, /field\('Description'/);
  assert.match(dashboardHtml, /field\('GitHub state',job\.githubState/);
  assert.match(dashboardHtml, /field\('Durable state',job\.state\)/);
});

test('account usage is limited to two real rate-limit percentage bars', () => {
  assert.match(dashboardHtml, /5-hour/);
  assert.match(dashboardHtml, /Weekly/);
  assert.match(dashboardHtml, /function usageProvider\(provider\)/);
  assert.match(dashboardHtml, /overview\.providers/);
  assert.match(dashboardHtml, /progressbar/);
  assert.match(dashboardHtml, /provider\.id==='openai'\?'available':'used'/);
  assert.match(dashboardHtml, /% available/);
  assert.match(dashboardHtml, /% used/);
  assert.match(dashboardHtml, /Real account telemetry when available/);
  assert.doesNotMatch(dashboardHtml, /Quota \/ balance|Current durable job|requests ·|tokens ·/i);
});

test('GitHub PR links accept only validated durable repository and PR values', () => {
  assert.equal(githubPrUrl('lalalic/agents-relay', 4), 'https://github.com/lalalic/agents-relay/pull/4');
  for (const repository of ['', 'lalalic', '../evil', 'owner/.', 'owner/..', 'owner/repo?x=1']) {
    assert.equal(githubPrUrl(repository, 1), null);
  }
  for (const prNumber of [0, -1, 1.5, '1', Number.NaN]) {
    assert.equal(githubPrUrl('lalalic/agents-relay', prNumber), null);
  }
});
