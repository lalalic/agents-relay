/** Optional L4 live provider reachability probes. Never publishes Task events. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { writeFile, readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { managedWorkerInput } from '../../../dist/managed-worker-input.js';
import { buildPlannerExecutionPrompt } from '../../../dist/planner.js';
import { resolveExecutionContext } from '../../../dist/execution-context.js';
import { issueZWorkerCredential } from '../../../dist/z-oauth.js';
const run = promisify(execFile);
const project = process.env.RELAY_L4_VLOG_PROJECT ?? '/Users/chengli/Workspace/neo/vlog';
const reportPath = process.env.RELAY_L4_REPORT ?? '/tmp/relay-prompt-l4-live.json';
const result = {schema:'relay.l4.provider-bootstrap.v1',project,generatedAt:new Date().toISOString(),checks:{}};
const check=(id,status,evidence)=>result.checks[id]={status,evidence};

const context=await resolveExecutionContext(project,'planner');
const prompt=await buildPlannerExecutionPrompt({job:{id:'L4-PREVIEW',repository:'l4',title:'Read only',objective:'Read only L4',tasks:[],plans:[]},tasks:[],objective:'Read only L4',previousPlannerTaskId:null,
  planExecution:{planId:'plan-1',executionId:'123e4567-e89b-12d3-a456-426614174000'},executionContext:context},undefined,'z');
const role=/with responsibility at (\/\S+\.md)/.exec(prompt);
if (!role)throw new Error('L4 cannot find the actual Planner Agent snapshot');
const snapshot=await readFile(role[1]);
if(createHash('sha256').update(snapshot).digest('hex')!==basename(role[1],'.md'))throw new Error('L4 Agent snapshot digest mismatch');
check('role-snapshot','PASS',{file:role[1],bytes:snapshot.length});

try{
 const {stdout}=await run('codex',['--version'],{timeout:12000});
 await readFile(resolve(project,'graph.mmd'));
 const modelProof=process.env.RELAY_L4_CODEX_MODEL_EVIDENCE_FILE;
 const evidence=modelProof?await readFile(modelProof,'utf8').catch(()=>null):null;
 check('codex-local-bootstrap','READY',{version:stdout.trim(),cwd:project,readableAgent:true,
   providerModelRead:evidence?.trim()==='L4_CODEX_BOOTSTRAP role=planner graph=available skill=available'?'PASS':'NOT_VERIFIED'});
}catch(e){check('codex-local-bootstrap','BLOCKED',{reason:String(e.message).slice(0,180)});}

try{
 const {stdout:status}=await run('webhelm',['status'],{timeout:12000});
 const {stdout:profile}=await run('webhelm',['platform','profile','chatgpt'],{timeout:12000});
 const a=JSON.parse(status),b=JSON.parse(profile);
 const probe=process.env.RELAY_L4_CHATGPT_TOOL_PROBE_FILE;
 const proof=probe?await readFile(probe,'utf8').catch(()=>null):null;
 check('chatgpt-harness',a.daemon?.running&&b.platform==='chatgpt'?'READY':'BLOCKED',{
  connectedWebhelm:a.daemon?.running===true,webPlatform:b.platform,providerModelToolCall:proof?.trim()==='L4_CHATGPT_NEO_MCP_PASS'?'PASS':'NOT_VERIFIED',
  note:'A thread submission/queue receipt alone is not model tool-use proof.'});
}catch(e){check('chatgpt-harness','BLOCKED',{reason:String(e.message).slice(0,180)});}

let token;
const mcp=async(method,params)=>{
 const response=await fetch(String(process.env.AGENTS_RELAY_Z_OAUTH_ORIGIN ?? '').replace(/\/$/,'')+'/mcp',{
  method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},
  body:JSON.stringify({jsonrpc:'2.0',id:31,method,params}),signal:AbortSignal.timeout(15000)});
 const raw=await response.text();const line=raw.split(/\r?\n/).find(x=>x.startsWith('data: '));const data=JSON.parse(line?line.slice(6):raw);
 if(!response.ok||data.error||data.result?.isError)throw new Error('MCP '+method+' returned HTTP '+response.status+' or JSON-RPC error');
 return data.result;
};
try{
 token=await issueZWorkerCredential();
 const tools=await mcp('tools/list',{});
 if(!['shell','fs','events'].every(name=>tools.tools.some(item=>item.name===name)))throw new Error('Required Neo MCP tools unavailable');
 const workContext=await resolveExecutionContext(project,'worker');
 const task={id:'L4-TASK',jobId:'L4-JOB',kind:'work',state:'QUEUED',agentName:'implementation',adapter:'z',
   input:'L4 private task details',output:{kind:'file',path:'runs/l4-evidence.txt'},executionId:'123e4567-e89b-12d3-a456-426614174000',dependencies:[]};
 const work=await managedWorkerInput({id:'L4-JOB',repository:'l4',title:'L4',objective:'Read only',tasks:[task],plans:[]},task,workContext);
 const references=[role[1],
   ...[...work.matchAll(/^\d+\. (?:\[[^\]]+\] )?(\/\S+\.md)$/gm)].map(x=>x[1])];
 let readCount=0;
 for(const path of new Set(references)){
   const fetched=await mcp('tools/call',{name:'fs',arguments:{command:'read',args:{path,encoding:'utf8'}}});
   const value=JSON.stringify(fetched.structuredContent??fetched.content);
   if(value.length<80)throw new Error('Remote fs returned no file content: '+path);
   readCount++;
 }
 const ref=await mcp('tools/call',{name:'fs',arguments:{command:'read',args:{path:role[1],encoding:'utf8'}}});
 if(!JSON.stringify(ref.structuredContent??ref.content).includes('Vlog Graph-first Episode planning'))throw new Error('Real pinned snapshot not readable through remote fs');
 const boot=await mcp('tools/call',{name:'shell',arguments:{command:'exec',args:{command:'neo bootstrap | head -8',cwd:project}}});
 if(!JSON.stringify(boot.structuredContent??boot.content).includes('XChat Harness Bootstrap'))throw new Error('Remote Neo bootstrap could not execute');
 const cli=resolve(new URL('../../../dist/cli.js',import.meta.url).pathname);
 const result=await mcp('tools/call',{name:'shell',arguments:{command:'exec',args:{command:`node ${JSON.stringify(cli)} prompt --id 537 --plan-id plan-2 --adapter z --project-path ${JSON.stringify(project)} | head -5`,cwd:project}}});
 if(!JSON.stringify(result.structuredContent??result.content).includes('# Role'))throw new Error('Matching installed CLI cannot build a live Job 537 prompt through remote shell');
 check('z-remote-oauth-mcp','PASS',{scope:'mcp',expiresInSeconds:3600,remoteSnapshotRead:true,remoteReferenceFiles:readCount,remoteBootstrap:true,remoteMatchingCli:true,eventsToolListed:true,
  note:'OAuth/MCP transport only; Z model Task completion and terminal event not exercised.'});
}catch(e){check('z-remote-oauth-mcp','BLOCKED',{reason:String(e.message).slice(0,220)});}
finally{token=undefined;}

await writeFile(reportPath,JSON.stringify(result,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({report:reportPath,checks:result.checks},null,2));
if(Object.values(result.checks).some(x=>x.status==='BLOCKED'))process.exitCode=1;
