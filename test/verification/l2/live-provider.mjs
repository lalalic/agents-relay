#!/usr/bin/env node
/** Opt-in real Codex MCP/role contract probe. This never touches production Relay. */
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,existsSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {relayAcceptProviderEvents} from './relay-acceptance.mjs';
const here=dirname(fileURLToPath(import.meta.url));
const repo=resolve(here,'../../..');
const roles=['implementation','reviewer','troubleshooter','planner'];
const role=process.env.RELAY_L2_ROLE??'implementation';
const scenario=process.env.RELAY_L2_CASE??'success';
const cases=['success','failure','missing-input','changes-required'];
if(!cases.includes(scenario)||scenario==='changes-required'&&role!=='reviewer')
 throw Error('Unsupported L2 role/scenario combination');
const enabled=process.env.RELAY_L2_LIVE==='1';
const destination=resolve(process.env.RELAY_L2_OUTPUT??join(tmpdir(),'agents-relay-l2-report.json'));
if(!roles.includes(role))throw Error('Unknown L2 role');
if(!enabled){console.log(JSON.stringify({outcome:'NOT_RUN',reason:'RELAY_L2_LIVE=1 required',role}));process.exit(0)}
const work=mkdtempSync(join(tmpdir(),'relay-l2-provider-'));
const jobId=`l2-${randomUUID()}`;
const taskId=`${role}-test`;
const executionId=randomUUID();
const sourceId=`job/${jobId}/task/${taskId}/execution/${executionId}`;
const sink=join(work,'events.jsonl');
const agentContract=readFileSync(join(repo,'skills/agents-relay/agents',`${role}.agent.md`),'utf8');
const eventContract=readFileSync(join(repo,'skills/agents-relay/contracts/event-contract.md'),'utf8');
const expectedVerdict=role==='reviewer'?(scenario==='changes-required'?'changes-required':'approved'):null;
const isFailure=['failure','missing-input'].includes(scenario);
const scenarioInstructions=isFailure
 ? scenario==='missing-input'
   ? 'The only required input is a binary attachment required-input.bin, but no attachment was supplied. Do not invent it. You must emit task.failed with data containing phase:"input_validation", a specific reason and evidence. Never emit task.completed.'
   : 'The assigned validation requires proving the false statement 1+1=3 using standard integer arithmetic. Do not fabricate. You must emit task.failed with data containing phase:"validation", a specific reason and evidence. Never emit task.completed.'
 : scenario==='changes-required'
   ? 'Review the false assertion "1+1=3" and return a truthful changes-required verdict with immutable head_sha "l2-immutable-fixture" and actionable findings. Emit task.completed: defects found do not mean Reviewer execution failed.'
   : role==='reviewer'?'Review the statement "1+1=2" and report a truthful approved verdict with immutable head_sha "l2-immutable-fixture".'
   : role==='troubleshooter'?'Assess a simulated adapter timeout. State that you cannot restart a real worker; mark the diagnostic task completed only if you explain the evidence and safe recommended recovery.'
   : role==='planner'?'Plan a single isolated arithmetic verification step; do not create any actual Relay tasks.'
   : 'Return the verified arithmetic fact 1+1=2.';
const terminalInstructions=isFailure
 ? 'Emit exactly one task.failed with data.phase, data.reason and data.evidence.'
 : `Emit exactly one task.completed with data including ${role==='reviewer'?'verdict:"'+expectedVerdict+'", head_sha:"l2-immutable-fixture", findings:[] when approved or actionable findings otherwise':role==='troubleshooter'?'diagnosis, recoveryRecommendation, evidence':role==='planner'?'objective_status, next_tasks, assessment':'artifact:"1+1=2", evidence'}.`;
const prompt=`You are running a real L2 isolated contract evaluation. This is a test, NOT a real Relay task. Do not edit files, invoke shell, contact production endpoints or invent success. You must use ONLY the MCP tool relay_l2.publish to emit events; do not invoke other MCP servers. Your exact source.id is ${sourceId}. Emit task.started first. Then perform the tiny role test: ${scenarioInstructions} ${terminalInstructions} Never claim the original failed Task was recovered.\n## Role Contract\n${agentContract}\n## Event Contract\n${eventContract}`;
const config=[`mcp_servers.relay_l2.command="${process.execPath.replaceAll('\\','\\\\')}"`,`mcp_servers.relay_l2.args=${JSON.stringify([join(here,'event-server.mjs'),sink,jobId,taskId,executionId])}`];
const args=['exec','--ephemeral','--skip-git-repo-check','--approve-for-me',...config.flatMap(c=>['-c',c]),'-C',work,'--',prompt];
const timeoutMs=Math.min(240000,Math.max(20000,Number(process.env.RELAY_L2_TIMEOUT_MS??120000)));
const captured=[];
let exitCode=null,termination=null;
try{
 const child=spawn('codex',args,{cwd:work,env:{...process.env,AGENTS_RELAY_STORE_DIR:join(work,'stores'),AGENTS_RELAY_LOG_DIR:join(work,'logs')},stdio:['ignore','pipe','pipe']});
 mkdirSync(join(work,'stores'));mkdirSync(join(work,'logs'));
 for(const stream of [child.stdout,child.stderr])stream?.on('data',data=>{captured.push(String(data).slice(0,4000));if(captured.length>200)captured.shift()});
 const completed=await new Promise(resolve=>{
  const alarm=setTimeout(()=>{termination='timeout';child.kill('SIGTERM');},timeoutMs);
  child.on('error',error=>{termination=error.message;clearTimeout(alarm);resolve(null)});
  child.on('close',code=>{clearTimeout(alarm);resolve(code)});
 });
 exitCode=completed;
 const observed=existsSync(sink)?readFileSync(sink,'utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x)):[];
 const accepted=observed.filter(e=>e.validation.length===0).map(e=>e.raw);
 const started=accepted.filter(e=>e.type==='task.started');
 const terminals=accepted.filter(e=>['task.completed','task.failed'].includes(e.type));
 const completion=terminals[0];
 const payload=completion?.data??{};
 const roleChecks={
  implementation:typeof payload.artifact==='string'&&payload.artifact.includes('1+1=2')&&typeof payload.evidence==='string',
  reviewer:payload.verdict===expectedVerdict&&payload.head_sha==='l2-immutable-fixture'&&Array.isArray(payload.findings),
  troubleshooter:typeof payload.diagnosis==='string'&&typeof payload.recoveryRecommendation==='string'&&typeof payload.evidence==='string'&&/cannot|not|no real/i.test(payload.evidence),
  planner:typeof payload.assessment==='string'&&['in_progress','achieved','blocked'].includes(payload.objective_status)&&Array.isArray(payload.next_tasks)&&payload.next_tasks.every(t=>typeof t.id==='string'&&typeof t.input==='string'),
 };
 const correctRole=isFailure
   ? completion?.type==='task.failed'&&typeof payload.phase==='string'
     &&typeof payload.reason==='string'&&payload.reason.length>0
     &&typeof payload.evidence==='string'&&payload.evidence.length>0
   : scenario==='changes-required'
     ? completion?.type==='task.completed'&&payload.verdict==='changes-required'
       &&payload.head_sha==='l2-immutable-fixture'&&Array.isArray(payload.findings)&&payload.findings.length>0
     : roleChecks[role]===true;
 const providerValid=exitCode===0&&started.length===1&&terminals.length===1
   &&completion?.type===(isFailure?'task.failed':'task.completed')
   &&correctRole&&accepted[0]?.type==='task.started';
 let relayAcceptance=null;
 if(providerValid){
   try{relayAcceptance=await relayAcceptProviderEvents({work,jobId,taskId,executionId,role,events:accepted,expectedState:isFailure?'FAILED':'SUCCEEDED',expectedVerdict});}
   catch(error){relayAcceptance={accepted:false,error:error instanceof Error?error.message:String(error)};}
 }
 const outcome=providerValid && relayAcceptance?.accepted===true ? 'PASS' : 'FAIL';
 const result={outcome,role,scenario,provider:'codex',code:exitCode,termination,jobId,taskId,executionId,eventCount:observed.length,accepted:accepted.map(e=>({type:e.type,sourceId:e.source?.id,data:e.data})),rejected:observed.filter(e=>e.validation.length>0),relayAcceptance,modelOutputTail:captured.join('').slice(-2400),reason:outcome==='PASS'?null:'Live provider event contract or authoritative Relay SQLite ingress rejected' };
 writeFileSync(destination,JSON.stringify(result,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({outcome,role,scenario,eventCount:observed.length,accepted:accepted.map(e=>e.type),relayAcceptance,output:destination,reason:result.reason},null,2));
 if(outcome!=='PASS')process.exitCode=1;
}finally{if(process.env.RELAY_L2_KEEP_FIXTURE!=='1')rmSync(work,{recursive:true,force:true});}
