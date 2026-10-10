import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { createDashboardActions } from '../dist/relayd-dashboard-actions.js';

test('dashboard actions resolve Jobs from refreshed inventory rather than boot-time snapshot', () => {
  let current = [];
  const actions = createDashboardActions({ getOverviews: () => current });
  assert.equal(actions.dashboardOverview('new-job'), undefined);
  current = [{ job: { id: 'new-job', repository: 'owner/repo', prNumber: 0 } }];
  assert.equal(actions.dashboardOverview('new-job')?.job.id, 'new-job');
  current = [];
  assert.equal(actions.dashboardOverview('new-job'), undefined);
});
