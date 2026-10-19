import test from 'node:test';
import assert from 'node:assert/strict';
import {REQUIRED_RECOVERY_PATHS,recoveryEvidenceGate,evaluateRecoveryMatrix} from './full-recovery-gates.mjs';
test('all Job 481 required recovery branches are explicit and not falsely passed',()=>{
 assert.equal(REQUIRED_RECOVERY_PATHS.length,11);
 assert.ok(REQUIRED_RECOVERY_PATHS.some(p=>p.id==='sequential-complete-objective'));
 assert.ok(REQUIRED_RECOVERY_PATHS.some(p=>p.id==='human-escalation-resume'));
 assert.ok(REQUIRED_RECOVERY_PATHS.some(p=>p.id==='crash-after-persist-before-publish'));
 for(const result of evaluateRecoveryMatrix())assert.equal(result.outcome,'NOT_RUN');
});
test('forged SQLite-completed event trace cannot satisfy full recovery gate',()=>{
 const fake={events:REQUIRED_RECOVERY_PATHS[5].requires,sqliteState:'COMPLETED'};
 assert.equal(recoveryEvidenceGate(REQUIRED_RECOVERY_PATHS[5],fake).outcome,'NOT_RUN');
});
