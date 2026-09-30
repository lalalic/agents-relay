import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { decideScheduleCycle } from '../dist/workflow/schedule-cycle-v2.js';

test('Schedule Cycle v2 graph owns current-slot completion', () => {
  const noSlot=decideScheduleCycle({hasCurrentSlot:false,plannerSatisfied:true});
  assert.equal(noSlot.target,'waiting');
  assert.deepEqual(noSlot.actions,[]);

  const active=decideScheduleCycle({hasCurrentSlot:true,plannerSatisfied:false});
  assert.equal(active.target,'waiting');
  assert.deepEqual(active.actions,[]);

  const done=decideScheduleCycle({hasCurrentSlot:true,plannerSatisfied:true});
  assert.equal(done.target,'finished');
  assert.deepEqual(done.actions.map(action=>action.id),['schedule.finishSlot']);
});
