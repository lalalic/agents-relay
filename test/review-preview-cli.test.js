import test from './test-runtime.js';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,readFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const cli=fileURLToPath(new URL('../dist/cli.js',import.meta.url));
const run=(args,env={})=>spawnSync(process.execPath,[cli,'review','interactive',...args],
  {encoding:'utf8',timeout:7000,env:{...process.env,...env}});

test('Worker CLI requests exactly one Neo review.preview with execution identity; no Git SHA or invocation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'review-cli-'));
 try{
  const media=join(dir,'draft.mp4'),output=join(dir,'captured.json'),binary=join(dir,'neo');
  await writeFile(media,'file exists, no Git repository');
  await writeFile(binary,`#!/usr/bin/env node\nimport {readFileSync,writeFileSync} from 'node:fs';\nconst x=process.argv.slice(2);if(x[0]!=='mcp'||x[1]!=='call'||x[2]!=='review.preview'||x[3]!=='--args-file')process.exit(3);\nconst data=JSON.parse(readFileSync(x[4],'utf8'));writeFileSync(process.env.REVIEW_TEST_CAPTURE,JSON.stringify(data));\nconsole.log(JSON.stringify({status:'review_requested',operationId:'op123'}));\n`);await chmod(binary,0o755);
  const result=run(['--path',media,'--id','612','--task-id','director','--execution-id','exec-2'],
   {PATH:dir+':'+process.env.PATH,REVIEW_TEST_CAPTURE:output});
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(JSON.parse(await readFile(output,'utf8')),{path:media,relay:{jobId:'612',taskId:'director',executionId:'exec-2'}});
  assert.equal(JSON.parse(result.stdout).status,'review_requested');
  assert.equal((await readFile(media,'utf8')),'file exists, no Git repository');
 }finally{await rm(dir,{recursive:true,force:true})}
});

test('Worker CLI fails closed without absolute path and current Task identity',()=>{
 const relative=run(['--path','draft.md','--id','612','--task-id','director','--execution-id','exec-2']);
 assert.notEqual(relative.status,0);assert.match(relative.stderr,/--path ABS/);
 const missing=run(['--path','/tmp/draft.md','--id','612','--task-id','director']);
 assert.notEqual(missing.status,0);assert.match(missing.stderr,/--execution-id/);
});
