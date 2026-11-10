import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { escalationCommand, escalationExecutorArgs, runConfiguredEscalation } from '../dist/cli-escalation.js';
import {mkdtemp,rm,writeFile,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import { escalationGraph, runEscalationGraph } from '../dist/workflow/escalation.js';

const request = { intent: 'finish release', blockedOn: 'identity prompt', context: 'browser authenticated' };

test('canonical escalation graph has no version suffix and owns all three result branches', async () => {
  assert.ok(escalationGraph.graph);
  for (const [status, expectedState, expectedAction] of [
    ['resolved', 'resolved', 'escalation.resume_recovery'],
    ['failed', 'technical_failure', 'escalation.technical_failure'],
    ['needs_user', 'needs_user', 'escalation.block_for_user'],
  ]) {
    const actions = [];
    const outcome = await runEscalationGraph(request, {
      invoke: async () => ({ status, summary: status }),
      resumeRecovery: () => actions.push('escalation.resume_recovery'),
      technicalFailure: () => actions.push('escalation.technical_failure'),
      blockForUser: () => actions.push('escalation.block_for_user'),
    });
    assert.equal(outcome.state, expectedState);
    assert.deepEqual(actions, [expectedAction]);
    assert.equal(outcome.requestDecision.actions[0]?.id, 'escalation.invoke');
    assert.equal(outcome.resultDecision.actions[0]?.id, expectedAction);
  }
});

test('needs_user is the only graph path selecting block_for_user', async () => {
  for (const status of ['resolved', 'failed']) {
    let blocked = false;
    await runEscalationGraph(request, {
      invoke: async () => ({ status, summary: status }),
      blockForUser: () => { blocked = true; },
    });
    assert.equal(blocked, false);
  }
  let blocked = false;
  await runEscalationGraph(request, {
    invoke: async () => ({ status: 'needs_user', summary: 'MFA', user_action: 'Approve MFA' }),
    blockForUser: () => { blocked = true; },
  });
  assert.equal(blocked, true);
});

test('generic escalation executor uses handoff files instead of legacy split options', () => {
  const args = escalationExecutorArgs('/tmp/handoff.md', '/tmp/policy.md', '/tmp/work');
  assert.deepEqual(args, [
    '--handoff-file', '/tmp/handoff.md',
    '--on-needs-user-file', '/tmp/policy.md',
    '--cwd', '/tmp/work',
  ]);
  assert.equal(args.includes('--intent'), false);
  assert.equal(args.includes('--blocked-on'), false);
  assert.equal(args.includes('--context'), false);
  assert.equal(args.includes('--on-needs-user'), false);
});


test('escalation command is one trusted environment value, never interpreted by a shell',()=>{
  assert.equal(escalationCommand({}),null);
  assert.deepEqual(escalationCommand({AGENTS_RELAY_ESCALATION_COMMAND:'/usr/bin/env'}),
    {executable:'/usr/bin/env',prefixArgs:[]});
  assert.deepEqual(escalationCommand({AGENTS_RELAY_ESCALATION_COMMAND:'["/usr/bin/env","true"]'}),
    {executable:'/usr/bin/env',prefixArgs:['true']});
  for(const value of ['neo escalation','echo hi; touch /tmp/untrusted','["neo","escalation"]',
      '["/usr/bin/env",1]','["/usr/bin/env","bad\narg"]','[]','[invalid]']){
    assert.throws(()=>escalationCommand({AGENTS_RELAY_ESCALATION_COMMAND:value}),/AGENTS_RELAY_ESCALATION_COMMAND/);
  }
});

test('unconfigured escalation fails through technical_failure, not resolved or needs_user',async()=>{
  const outcome=await runEscalationGraph(request,{invoke: r=>runConfiguredEscalation(r,{})});
  assert.equal(outcome.state,'technical_failure');
  assert.equal(outcome.result.status,'failed');
  assert.match(outcome.result.summary,/AGENTS_RELAY_ESCALATION_COMMAND/);
});

test('configured executable delivers handoff/policy/cwd without Neo installed',async t=>{
  const dir=await realpath(await mkdtemp(join(tmpdir(),'relay-escalation-contract-')));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const script=join(dir,'provider.mjs');
  await writeFile(script,`import {readFileSync} from 'node:fs';
const args=process.argv.slice(2);
const flag=name=>args[args.indexOf(name)+1];
const handoff=readFileSync(flag('--handoff-file'),'utf8');
const policy=readFileSync(flag('--on-needs-user-file'),'utf8');
if(!handoff.includes('finish release')||!handoff.includes('browser authenticated')||
   !policy.includes('ask owner')||flag('--cwd')!==process.cwd())process.exit(15);
console.log(JSON.stringify({status:'resolved',summary:'Independent provider completed',evidence:['isolated fixture']}));
`);
  const configured={AGENTS_RELAY_ESCALATION_COMMAND:JSON.stringify([process.execPath,script])};
  const outcome=await runEscalationGraph({...request,cwd:dir,onNeedsUser:'ask owner'},
    {invoke:r=>runConfiguredEscalation(r,configured)});
  assert.equal(outcome.state,'resolved');
  assert.equal(outcome.result.summary,'Independent provider completed');
  assert.deepEqual(outcome.result.evidence,['isolated fixture']);
});

test('configured executor rejects invalid results and non-zero exits without treating them as success',async t=>{
  const dir=await realpath(await mkdtemp(join(tmpdir(),'relay-escalation-invalid-')));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const script=join(dir,'provider.mjs');
  for(const [output,exit] of [
    ['broken-json',0],
    [JSON.stringify({status:'resolved',summary:'should not pass'}),9],
    [JSON.stringify({status:'resolved'}),0],
  ]) {
    await writeFile(script,`process.stdout.write(${JSON.stringify(output)});process.exit(${exit});`);
    const result=await runConfiguredEscalation({...request,cwd:dir},
      {AGENTS_RELAY_ESCALATION_COMMAND:JSON.stringify([process.execPath,script])});
    assert.equal(result.status,'failed');
  }
  const missing=await runConfiguredEscalation(request,{AGENTS_RELAY_ESCALATION_COMMAND:'/tmp/nonexistent-relay-executor-9'});
  assert.equal(missing.status,'failed');
});
