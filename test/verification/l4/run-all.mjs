#!/usr/bin/env node
// Real L4 = deterministic Prompt Builder contract checks followed by model behavior evals.
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const model=process.env.RELAY_L4_MODEL||'gpt-6-luna';
const report=process.env.RELAY_L4_REPORT||join(tmpdir(),'relay-l4-'+model+'-results.json');
const prompts=await mkdtemp(join(tmpdir(),'relay-l4-builder-'));
async function run(command,args,env) {
 return new Promise((done,reject)=>{
  const proc=spawn(command,args,{cwd:root,env:{...process.env,...env},stdio:'inherit'});
  proc.on('error',reject);
  proc.on('close',code=>code===0?done():reject(new Error(command+' exited '+code)));
 });
}
try {
 await run('npm',['run','build']);
 await run('node',['--test','test/verification/l4/prompt-evals.test.mjs'],{RELAY_L4_OUTPUT_DIR:prompts});
 await run('node',['test/verification/l4/run-model-evals.mjs','--model',model,'--prompt-dir',prompts,'--output',report]);
 console.log('L4 model report: '+report);
}finally{await rm(prompts,{recursive:true,force:true});}
