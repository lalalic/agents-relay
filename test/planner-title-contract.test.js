import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { parsePlannerResult } from '../dist/planner.js';

const make = title => ({
  objective_status: 'in_progress',
  assessment: 'One meaningful work milestone',
  next_tasks: [{ id: 'task-1', ...(title === undefined ? {} : { title }), input: 'Durable implementation detail', output: { kind: 'task_pr' }, storySize: 'M' }],
});

test('planner requires a nonempty standalone Task title', () => {
  assert.throws(() => parsePlannerResult(make(undefined)), /next_tasks\[0\]\.title is required/);
  assert.throws(() => parsePlannerResult(make('  ')), /next_tasks\[0\]\.title is required/);
});

test('planner requires five to eight words in each new Task title', () => {
  assert.throws(() => parsePlannerResult(make('Only four title words')), /title must contain 5–8 words/);
  assert.throws(() => parsePlannerResult(make('This title contains too many separate words for the contract')), /title must contain 5–8 words/);
  assert.equal(parsePlannerResult(make('Implement reliable task recovery and verification')).next_tasks[0].title, 'Implement reliable task recovery and verification');
  assert.equal(parsePlannerResult(make('Implement and verify task recovery through graph transitions')).next_tasks[0].title, 'Implement and verify task recovery through graph transitions');
});

test('legacy stored plan title fallback is not used by new planner parse', () => {
  assert.throws(() => parsePlannerResult(make(undefined)), /title is required/);
});
