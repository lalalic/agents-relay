// Direct Node/Rust src/agent-graph.ts DAG parser, visible Agent selection, and contract prompt assembly fixtures.
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {dirname,resolve,join} from 'node:path';import {fileURLToPath} from 'node:url';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';
import {parseAgentGraph,validateAgentSelection,agentGraphPrompt} from '../../dist/agent-graph.js';
import {resolveExecutionContext,agentContractPrompt} from '../../dist/execution-context.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),bin=resolve(root,'rust/target/debug/relay-rust2-parity');let ready=false;
function rust(req){if(!ready){const build=spawnSync('cargo',['build','--offline','--manifest-path','rust/Cargo.toml'],{cwd:root,encoding:'utf8',timeout:90000});assert.equal(build.status,0,build.stderr);ready=true;}
 const result=spawnSync(bin,[],{input:JSON.stringify(req)+'\n',encoding:'utf8',timeout:12000,maxBuffer:5*1024*1024});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout.trim());}
function node(req){try{
  let value;
  if(req.op==='parseAgentGraph')value=parseAgentGraph(req.source);
  else if(req.op==='validateAgentSelection'){
   validateAgentSelection({agents:req.visible.map(name=>({name}))},req.agentName,req.source);value=null;
  }
  return {ok:true,value};
 }catch(error){return {ok:false,error:error.message}}}
let seed=0x23314aff;const rand=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;},pick=xs=>xs[rand(xs.length)];
const sources=[
 `flowchart TD\nstrategy --> synthesis\nproduct --> synthesis\nsynthesis --> planner`,
 `flowchart LR\nbuild[agent:builder] --> verify[agent:evaluator]\nverify --> deliver`,
 `flowchart TB\nalpha[agent:designer]\nbeta[agent:face]\nalpha --> beta\nbeta --> gamma[agent:motion]`,
 `flowchart RL\na --> b\nb --> c\na --> c`,
 `graph LR\na --> b`,
 `flowchart TD\na --> b\nb --> a`,
 `flowchart LR\na[agent:writer] --> a[agent:writer]`,
 `flowchart TD\n%% note\nsolo[agent:reviewer]`,
 `flowchart TD\nnot-parseable?!`,
 `flowchart TD\na[agent:a] --> b[agent:b]\na --> b`,
 ];
const parseCases=[];
for(let i=0;i<1050;i++){
 const source=pick(sources),modified=pick([source,source,source.replace('flowchart','flowchart  '),source.replace(' --> ','-->' ),source+'\n%% metadata',source.replace('flowchart','stateDiagram-v2')]);
 parseCases.push({op:'parseAgentGraph',source:modified});
}
test('Agent Graph DAG fan-out/fan-in topology and malformed input agree with Node',()=>{
 for(const [i,req] of parseCases.entries())assert.deepEqual(rust(req),node(req),`Agent graph parse ${i}: ${req.source}`);
 console.log(`Verified ${parseCases.length} Node/Rust executable Agent Graph parsing and DAG waves`);
});
const validation=[];
for(let i=0;i<690;i++){
 const source=pick([...sources,undefined,'']);
 const visible=pick([['strategy','product','synthesis','planner'],['builder','evaluator','deliver'],['designer','face','motion'],['a','b','c'],[]]);
 const agentName=pick(['strategy','planner','not-visible',undefined,'']);
 validation.push({op:'validateAgentSelection',source,visible,agentName});
}
test('Agent identity must be visible in caller-selected execution source layers',()=>{
 for(const [i,req] of validation.entries())assert.deepEqual(rust(req),node(req),`Agent selection ${i}: ${JSON.stringify(req).slice(0,360)}`);
 console.log(`Verified ${validation.length} Node/Rust Agent selection visibility and error cases`);
});
test('Graph prompt assembly consumes source-resolved Agent contracts and preserves predecessor ordering',async()=>{
 const home=await mkdtemp(join(tmpdir(),'rust2-agent-graph-context-'));
 try{
  const workspace=join(home,'workspace'),project=join(workspace,'project');
  await mkdir(join(project,'agents'),{recursive:true});
  const names=['strategy','product','synthesis','designer'];
  for(const name of names)await writeFile(join(project,'agents',`${name}.agent.md`),`---\nname: ${name}\n---\n\n${name.toUpperCase()} CONTRACT`);
  const context=await resolveExecutionContext(project,'worker',{workspaceRoot:workspace,globalRoot:join(home,'global')});
  const source='flowchart TD\nstrategy --> synthesis\nproduct --> synthesis\nsynthesis --> designer';
  const contracts=Object.fromEntries(await Promise.all(names.map(async name=>[name,await agentContractPrompt(context,name)])));
  const visible=context.agents.map(agent=>agent.name);
  const actual=rust({op:'agentGraphPrompt',source,visible,contracts});
  const expected=await agentGraphPrompt(context,source);
  assert.deepEqual(actual,{ok:true,value:expected});
  console.log('Verified the actual Node execution-context Agent contract prompt assembly');
 }finally{await rm(home,{recursive:true,force:true})}
});
