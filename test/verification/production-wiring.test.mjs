import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(fileURLToPath(new URL('../../',import.meta.url)));
/** Read-only integration readiness. This check is NOT a runtime path PASS. */
export function productionWiring(rootDir=root){
 const paths=['src/reconciler.ts','src/scheduler.ts'];
 const texts=paths.map(p=>readFileSync(join(rootDir,p),'utf8'));
 const joined=texts.join('\n');
 const checks={
  reconcilerActionVerification:/actionVerification\s*:/.test(texts[0]),
  schedulerActionVerification:/actionVerification\s*:/.test(texts[1]),
  sqliteOutbox:/DurableWorkflowPublication|commitTransitionAndEvents/.test(joined),
  sqlitePostcondition:/WorkflowActionLedger|reserveForRunningTask/.test(joined),
  restartDrain:/\.replay\s*\(/.test(joined)
 };
 return {outcome:Object.values(checks).every(Boolean)?'INTEGRATION_PRESENT_UNVERIFIED':'NOT_RUN',checks};
}
test('production wiring probe cannot claim complete objective from isolated dispatcher tests',()=>{
 const result=productionWiring(process.env.RELAY_A_ROOT||root);
 assert.ok(['NOT_RUN','INTEGRATION_PRESENT_UNVERIFIED'].includes(result.outcome));
 assert.equal(typeof result.checks.reconcilerActionVerification,'boolean');
 // Only a real end-to-end SQLite objective observation may claim PASS.
 assert.notEqual(result.outcome,'PASS');
});
