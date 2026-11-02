import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const cli=resolve(import.meta.dirname,'../dist/cli.js');
test('detached prompt eval builds production and safe evaluation prompts without durable Jobs',()=>{
 const base=mkdtempSync(join(tmpdir(),'relay-detached-eval-'));
 try {
  const workspace=join(base,'workspace'),neo=join(workspace,'neo'),project=join(neo,'story-lab');
  mkdirSync(join(project,'agents'),{recursive:true});
  mkdirSync(join(neo,'skills','events-bus','references'),{recursive:true});
  writeFileSync(join(neo,'AGENTS.md'),'# Neo canonical policy\n');
  writeFileSync(join(project,'AGENTS.md'),'# Story Lab project rules\n');
  writeFileSync(join(project,'agents','story-worker.agent.md'),'---\nname: story-worker\ndescription: Choose truthful story steps\ntype: worker\n---\n\n# Story Worker\nDo not invent source dialogue.');
  writeFileSync(join(neo,'skills','events-bus','references','protocol.md'),'# Event protocol\n');
  const input=join(base,'case.json');
  writeFileSync(input,JSON.stringify({projectPath:project,agentName:'story-worker',caseId:'no-fake-speech',taskInput:'An STT quote is unverified. Choose record_uncertainty.'}));
  const env={...process.env,AGENTS_RELAY_WORKSPACE_ROOT:workspace,AGENTS_HOME:join(base,'global'),AGENTS_RELAY_PROMPT_REFERENCE_DIR:join(base,'snapshots')};
  const run=spawnSync(process.execPath,[cli,'prompt','--eval-file',input,'--adapter','codex'],{env,encoding:'utf8',timeout:15000});
  assert.equal(run.status,0,run.stderr);
  const result=JSON.parse(run.stdout);
  assert.equal(result.builder,'managedWorkerInput');
  assert.equal(result.mode,'isolated-evaluation');
  assert.match(result.productionPrompt,/^# Role\nYou are story-worker/);
  assert.match(result.productionPrompt,/## Contracts[\s\S]*## Contexts[\s\S]*## Task/);
  assert.match(result.productionPrompt,/job\/EVAL_ONLY\/task\/eval-no-fake-speech\/execution\//);
  assert.doesNotMatch(result.productionPrompt,/An STT quote is unverified/);
  assert.match(result.evaluationPrompt,/Do not invent source dialogue/);
  assert.match(result.evaluationPrompt,/An STT quote is unverified/);
  assert.match(result.evaluationPrompt,/\[Read-only evaluation safety boundary\]/);
  const forbidden=spawnSync(process.execPath,[cli,'prompt','--eval-file',input,'--id','537'],{env,encoding:'utf8',timeout:15000});
  assert.notEqual(forbidden.status,0);
  assert.match(forbidden.stderr,/cannot bind a durable Job/);
  assert.equal(existsSync(join(base,'data.sqlite')),false);
 }finally{rmSync(base,{recursive:true,force:true});}
});
