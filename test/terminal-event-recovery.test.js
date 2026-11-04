import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terminalRecoveryEligible, terminalRecoveryPrompt } from '../dist/terminal-event-recovery.js';

test('shared recovery requires a live resumable original execution and at most one send', () => {
  const ready={hasSession:true,hasThread:true,terminalObserved:false,recoveryAttempts:0,outcomeUncertain:false,cancelled:false};
  assert.equal(terminalRecoveryEligible(ready),true);
  for(const change of [{hasSession:false},{hasThread:false},{terminalObserved:true},{recoveryAttempts:1},{outcomeUncertain:true},{cancelled:true}])
    assert.equal(terminalRecoveryEligible({...ready,...change}),false);
});
test('shared prompt preserves original identity and does not fabricate terminal proof', () => {
  const prompt=terminalRecoveryPrompt('exec-original');
  assert.match(prompt,/exec-original/);
  assert.match(prompt,/ORIGINAL execution identity/);
  assert.match(prompt,/task.completed/);
  assert.match(prompt,/task.failed/);
  assert.match(prompt,/do not publish a duplicate/);
});
