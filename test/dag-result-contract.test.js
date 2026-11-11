import test from './test-runtime.js';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {dagCompletionError} from '../dist/dag-result-contract.js';

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'relay-dag-stage-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const run=join(root,'runs','2026-11-11-stage'),output=join(run,'.dag-node-results','dag-stage-a.json');
 await mkdir(join(run,'.dag-node-results'),{recursive:true});
 await mkdir(join(root,'scripts'),{recursive:true});
 const task={id:'dag-stage-a',jobId:'test',agentName:'test-visioner',dagNode:{nodeId:'a',parentTaskId:'stage',graphHash:'aa',executor:'script'},output:{kind:'file',path:output}};
 await writeFile(output,JSON.stringify({status:'COMPLETED',output:{stage:'test'},artifacts:[]}));
 await writeFile(join(root,'project.run.json'),JSON.stringify({stageValidation:{script:'scripts/validate.mjs',agents:{'test-visioner':'visioner'}}}));
 const validator=join(root,'scripts','validate.mjs');
 return {root,run,output,task,validator};
}
test('DAG Agent output must satisfy structured completion before Task success',async t=>{
 const f=await fixture(t);assert.equal(await dagCompletionError(f.task),null);
 await writeFile(f.output,JSON.stringify({status:'COMPLETED',output:null,artifacts:[]}));
 assert.match(await dagCompletionError(f.task),/output object/);
});
test('DAG Agent completion reuses the project Stage validator without extra recovery',async t=>{
 const f=await fixture(t);
 await writeFile(f.validator,`process.stdout.write(JSON.stringify({stage:process.argv[2],status:'PASS',errors:[]}))`);
 assert.equal(await dagCompletionError(f.task,f.root),null);
 await writeFile(f.validator,`process.stdout.write(JSON.stringify({stage:process.argv[2],status:'FAIL',errors:[{code:'MISSING_STAGE_EVIDENCE'}]}));process.exit(1)`);
 assert.match(await dagCompletionError(f.task,f.root),/STAGE_CONTRACT_FAILED.*MISSING_STAGE_EVIDENCE/);
});
