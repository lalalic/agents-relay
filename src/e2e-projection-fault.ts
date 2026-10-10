/** E2E-only, job-scoped projection transport fixture; never changes Job lifecycle. */
import {existsSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
export function e2eProjectionFault(repo:string,jobId:string):void {
 const dir=process.env.E2E_PROJECTION_FAULT_DIR;
 if(!dir||!process.env.E2E_REPO||repo!==process.env.E2E_REPO) return;
 const pending=join(dir,`${jobId}.pending`), consumed=join(dir,`${jobId}.failed`);
 if(!existsSync(pending))return;
 renameSync(pending,consumed); // consume before fail, atomic within one filesystem
 writeFileSync(consumed,JSON.stringify({jobId,repository:repo,type:'transient_projection_transport_failure',at:new Date().toISOString()})+'\n');
 throw new Error(`E2E transient GitHub projection transport failure: ${jobId}`);
}
