// Wave4 Worker C direct original compiled Node versus real native Rust transports.
// Only disposable processes, stage projects, audit paths and fake identities.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync,mkdirSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CommandContinuation,CodexThreadContinuation} from '../../dist/continuation.js';
import {dagCompletionError} from '../../dist/dag-result-contract.js';
import {recordTerminalRouteOutcome,recordLaunchRouteOutcome,recordWatchdogRouteOutcome} from '../../dist/route-outcome-recording.js';
import {JsonlDecisionAuditStore} from '../../dist/decision-audit.js';

const root=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const bin=join(root,'rust/target/debug/relay-rust2-parity');
const base=mkdtempSync(join(tmpdir(),'rust2-wave4-delivery-'));
const store=join(base,'isolated-store');
const result=(fn)=>Promise.resolve().then(fn).then(()=>({ok:true}), e=>({ok:false,error:e.message}));
const native=request=>{
  const p=spawnSync(bin,[],{
    input:JSON.stringify(request)+'\n',cwd:root,encoding:'utf8',timeout:10000,
    env:{...process.env,AGENTS_RELAY_STORE_DIR:store},
  });
  assert.equal(p.status,0,p.stderr || p.error?.message);
  return JSON.parse(p.stdout.trim());
};
const stripIds=record=>{
  const obj=structuredClone(record);
  if(obj){delete obj.outcome_id;delete obj.timestamp}
  return obj;
};
let seed=0x7b6af1e3;
const random=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0};
test.after(()=>rmSync(base,{recursive:true,force:true}));

test('Wave4 continuation: 125 original Node/Rust owned command and mismatched-kind cases',async()=>{
  const inputs=['literal','中文 字符','; rm -rf /','hello\nworld','', '🔍', '--version'];
  const targets=['/usr/bin/true','/usr/bin/false'];
  for(let i=0;i<125;i++){
    const kind=i%4===0?'codex-thread':'command';
    const continuationKind=i%7===0?(kind==='command'?'codex-thread':'command'):kind;
    const target=targets[random()%targets.length];
    const input=inputs[random()%inputs.length];
    const commandOverride=target;
    const node=await result(async()=>{
      const continuation=kind==='command'
        ? new CommandContinuation()
        : new CodexThreadContinuation(commandOverride);
      await continuation.continue(input,{kind:continuationKind,target});
    });
    const rust=native({op:'wave4Continuation',kind,continuationKind,
      target,input,commandOverride});
    assert.deepEqual({ok:rust.ok,...rust.ok?{}:{error:rust.error}},node,
      'Node/Rust continuation '+i);
  }
  console.log('PASS Rust2 Wave4 continuation 125 direct original Node vs native owned processes');
});

test('Wave4 DAG: 42 real Node/Rust stage verifier process and contract cases',async()=>{
  const project=join(base,'stage-project');
  const work=join(project,'runs','session','task');
  mkdirSync(work,{recursive:true});
  mkdirSync(join(project,'scripts'),{recursive:true});
  writeFileSync(join(project,'project.run.json'),JSON.stringify({
    stageValidation:{agents:{builder:'unit'},script:'scripts/check.mjs'},
  }));
  const output=join(work,'result.json');
  const variations=[
    "console.log(JSON.stringify({stage:'unit',status:'PASS',errors:[]}))",
    "console.log(JSON.stringify({stage:'unit',status:'FAIL',errors:['bad stage']}))",
    "console.log('not-json')",
    "console.error('broken'); process.exit(4)",
    "console.log(JSON.stringify({stage:'wrong',status:'PASS',errors:[]}))",
    "console.log(JSON.stringify({stage:'unit',status:'PASS',errors:['bad']}))",
  ];
  for(let i=0;i<42;i++){
    const script=variations[random()%variations.length];
    writeFileSync(join(project,'scripts/check.mjs'),script+'\n');
    const payload=i%9===0?{status:'FAILED',output:{},artifacts:[]}:
      {status:'COMPLETED',output:{},artifacts:i%8===0?{}:[]};
    writeFileSync(output,JSON.stringify(payload));
    const task={dagNode:{nodeId:'stage'},agentName:i%11===0?'unknown':'builder',
      output:{kind:'file',path:output}};
    const original=await dagCompletionError(task,project);
    const rust=native({op:'wave4DagOwned',task,projectPath:project,interpreter:process.execPath});
    assert.equal(rust.ok,true,rust.error);
    assert.equal(rust.value,original,'DAG stage '+i);
  }
  console.log('PASS Rust2 Wave4 DAG 42 actual process original Node vs Rust stage validations');
});

test('Wave4 route: 180 Node DecisionAuditStore/Rust JSONL effects with redaction',async()=>{
  const eventTypes=['task.completed','task.failed','task.cancelled','task.blocked'];
  const messages=['ok','deadline exceeded','invalid public key','stream disconnected',
    'Bearer secret-token', 'authorization failed','model not found','ordinary error', '中文 🔍'];
  for(let i=0;i<180;i++){
    const kind=['terminal','launch','watchdog'][i%3];
    const pathNode=join(base,'audit-node-'+i,'audit.jsonl');
    const pathRust=join(base,'audit-rust-'+i,'audit.jsonl');
    const task={id:String(i+1),jobId:'x',adapter:'chatgpt',attempt:1,state:'RUNNING',
      routing:i%13===0?undefined:{decisionId:'d-'+i,provider:'fake',model:'unit',
        profile:null,reasoning:null},
      workerSelection:{workerId:'worker-1'}};
    const event={type:eventTypes[random()%eventTypes.length],
      message:messages[random()%messages.length],data:{reason:messages[random()%messages.length]}};
    const phase=['launch','delivery','start-ack'][random()%3];
    const message=messages[random()%messages.length];
    const unknownOutcome=i%9===0;
    const watchdog={executionId:'e-'+i,failedExit:i%3===0,
      rawError:message,failureReason:i%5===0?undefined:'watchdog_failed',
      failureMessage:event.message,exitCode:i%4===0?null:1};
    const auditStore=new JsonlDecisionAuditStore(pathNode);
    if(kind==='terminal')await recordTerminalRouteOutcome(auditStore,task,event,'e-'+i);
    if(kind==='launch')await recordLaunchRouteOutcome(auditStore,task,message,phase,'e-'+i,unknownOutcome);
    if(kind==='watchdog')await recordWatchdogRouteOutcome(auditStore,task,watchdog);
    const rust=native({op:'wave4RouteJsonl',path:pathRust,task,kind,
      event,phase,message,unknownOutcome,watchdog,executionId:'e-'+i});
    assert.equal(rust.ok,true,rust.error);
    assert.equal(rust.value,!!task.routing?.decisionId);
    assert.equal(existsSync(pathNode),existsSync(pathRust),'audit file presence');
    if(existsSync(pathNode)){
      const node=JSON.parse(readFileSync(pathNode,'utf8'));
      const nativeRecord=JSON.parse(readFileSync(pathRust,'utf8'));
      assert.deepEqual(stripIds(nativeRecord),stripIds(node),'audit record '+i);
      assert.equal(readFileSync(pathRust,'utf8').split('\n').length,2,'one append');
    }
  }
  console.log('PASS Rust2 Wave4 route 180 Node vs Rust real JSONL append/redaction effects');
});
