import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,writeFileSync,existsSync,readFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {e2eProjectionFault} from '../dist/e2e-projection-fault.js';
test('projection transport injection is isolated to repo and job and consumed before failure',()=>{
 const dir=mkdtempSync(join(tmpdir(),'e2e-projection-'));const prev={E2E_PROJECTION_FAULT_DIR:process.env.E2E_PROJECTION_FAULT_DIR,E2E_REPO:process.env.E2E_REPO};
 try{process.env.E2E_PROJECTION_FAULT_DIR=dir;process.env.E2E_REPO='lalalic/agents-relay-e2e';writeFileSync(join(dir,'job-1.pending'),'x');
 e2eProjectionFault('lalalic/agents-relay','job-1');e2eProjectionFault('lalalic/agents-relay-e2e','job-2');assert.equal(existsSync(join(dir,'job-1.pending')),true);
 assert.throws(()=>e2eProjectionFault('lalalic/agents-relay-e2e','job-1'),/transient GitHub projection/);
 assert.equal(existsSync(join(dir,'job-1.pending')),false);assert.equal(JSON.parse(readFileSync(join(dir,'job-1.failed'),'utf8')).jobId,'job-1');e2eProjectionFault('lalalic/agents-relay-e2e','job-1');
 }finally{for(const [key,val]of Object.entries(prev)){if(val===undefined)delete process.env[key];else process.env[key]=val}rmSync(dir,{recursive:true,force:true})}
});
