// New Rust2 Node/Rust differential test for src/routing-policy.ts: file-backed policy, hashing, eligibility and ranking.
import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir,homedir} from 'node:os';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {policyPath,executionRouterRulesPath,loadExecutionRouterRules,saveExecutionRouterRules,loadRoutingPolicy,policyAllows,policyRank} from '../../dist/routing-policy.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const rustBin=resolve(root,'rust/target/debug/relay-rust2-parity');
function rust(requests){
 const proc=spawnSync(rustBin,[],{input:requests.map(JSON.stringify).join('\n')+'\n',encoding:'utf8',maxBuffer:10*1024*1024});
 assert.equal(proc.status,0,proc.stderr);
 const lines=proc.stdout.trim().split('\n');assert.equal(lines.length,requests.length);
 return lines.map(JSON.parse);
}
let cases=[];
const policies=[{},
 {disabledProviders:['openai'],disabledProfiles:['fast'],preferredProviders:['zai'],preferredProfiles:['special'],qualityByTaskKind:{research:['id-0']},recovery:{penalizePriorRoute:true}},
 {preferredProviders:[],preferredProfiles:[],disabledProviders:[],disabledProfiles:[],qualityByTaskKind:{},recovery:{}},
 {disabledProviders:['zai','custom'],preferredProviders:['zai','openai'],preferredProfiles:['fast','super'],qualityByTaskKind:{research:['id-1','id-2'],coding:['id-2']},recovery:{penalizePriorRoute:false}},
];
let seed=81274415;const n=max=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%max};
for(let i=0;i<1200;i++) {
 const candidate={id:`id-${n(3)}`,provider:['openai','zai','custom',''][n(4)],profile:['fast','special','super','',undefined][n(5)]};
 const policy=policies[n(policies.length)];
 const taskKind=['research','coding','other','',undefined][n(5)];
 cases.push({op:'policyAllows',candidate,policy},{op:'policyRank',candidate,policy,taskKind});
}
let opts=['',undefined,'explicit-path'];
for(const explicit of opts) for(const env of opts) {
 cases.push({op:'routingPolicyPath',explicit,env,cwd:process.cwd()});
 cases.push({op:'executionRouterRulesPath',explicit,env,home:homedir()});
}
function nodeRef(r){
 try{
  let value;
  if(r.op==='policyAllows')value=policyAllows(r.candidate,r.policy);
  else if(r.op==='policyRank')value=policyRank(r.candidate,r.taskKind,r.policy);
  else if(r.op==='routingPolicyPath') {
   const old=process.env.AGENTS_RELAY_ROUTING_POLICY;
   try{if(r.env===undefined)delete process.env.AGENTS_RELAY_ROUTING_POLICY;
     else process.env.AGENTS_RELAY_ROUTING_POLICY=r.env;
     value=policyPath(r.explicit);
   }finally{if(old===undefined)delete process.env.AGENTS_RELAY_ROUTING_POLICY;
     else process.env.AGENTS_RELAY_ROUTING_POLICY=old;}
  } else if(r.op==='executionRouterRulesPath') {
   const old=process.env.AGENTS_RELAY_EXECUTION_ROUTER_RULES;
   try{if(r.env===undefined)delete process.env.AGENTS_RELAY_EXECUTION_ROUTER_RULES;
     else process.env.AGENTS_RELAY_EXECUTION_ROUTER_RULES=r.env;
     value=executionRouterRulesPath(r.explicit);
   }finally{if(old===undefined)delete process.env.AGENTS_RELAY_EXECUTION_ROUTER_RULES;
     else process.env.AGENTS_RELAY_EXECUTION_ROUTER_RULES=old;}
  }
  return {ok:true,value};
 }catch(error){return {ok:false,error:error.message};}
}
test('routing-policy eligibility, ranking and default path parity',()=>{
 const build=spawnSync('cargo',['build','--offline','--manifest-path','rust/Cargo.toml'],{cwd:root,encoding:'utf8',timeout:90000});
 assert.equal(build.status,0,build.stderr);
 const actual=rust(cases);
 for(let i=0;i<cases.length;i++)assert.deepEqual(actual[i],nodeRef(cases[i]),`Case ${i}: ${JSON.stringify(cases[i])}`);
 console.log(`Verified ${cases.length} routing policy rank/path fixtures`);
});

test('routing-policy and router-rules file hashing and sanitized snapshots match Node',async()=>{
 const dir=mkdtempSync(resolve(tmpdir(),'rust2-routing-policy-'));
 try {
  const policyFile=resolve(dir,'route-policy.json');
  const rulesFile=resolve(dir,'nested','rules.md');
  const fileCases=[
   {missing:true},
   {raw:'not-json'},
   {raw:'null'},
   {raw:'[]'},
   {raw:JSON.stringify({disabledProviders:['a','b'],disabledProfiles:['fast'],preferredProviders:['zai'],preferredProfiles:['x'],qualityByTaskKind:{coding:['id-1'],broken:['x',1]},recovery:{penalizePriorRoute:true}})},
   {raw:JSON.stringify({disabledProviders:['valid',4],disabledProfiles:[],qualityByTaskKind:{one:['x'],two:[],three:[3]},recovery:{penalizePriorRoute:'yes'}})},
   {raw:JSON.stringify({qualityByTaskKind:JSON.parse('{"__proto__":["x"],"a":["1"]}')})},
   {raw:'{ "preferredProviders" : ["zai"], "qualityByTaskKind": {} }\r\n'},
   {raw:Buffer.from([0xc3,0x28])},
  ];
  let count=0;
  for(const fixture of fileCases){
   if(fixture.missing)rmSync(policyFile,{force:true});
   else writeFileSync(policyFile,fixture.raw);
   const node=await loadRoutingPolicy(policyFile,rulesFile);
   const actual=rust([{op:'loadRoutingPolicy',path:policyFile,rulesPath:rulesFile}])[0];
   // Compare the actual JSON wire contract: Node object properties whose
   // value is undefined are deliberately omitted by JSON serialization.
   assert.deepEqual(actual,{ok:true,value:JSON.parse(JSON.stringify(node))},`Policy file mismatch ${count}`);
   count++;
  }
  for(const text of ['', '[choices]\r\nzai: glm high\r\n[routing-instruction]\r\n Prefer to wait\r\n',
    'plain text\n', '\uFEFF[choices]\nopenai: gpt-6 HIGH\n', '\u3000text with spaces  ']){
   const nodeSaved=await saveExecutionRouterRules(text,rulesFile);
   const actualSaved=rust([{op:'saveExecutionRouterRules',path:rulesFile,text}])[0];
   assert.deepEqual(actualSaved,{ok:true,value:nodeSaved});
   assert.equal(readFileSync(rulesFile,'utf8'),text);
   const nodeLoaded=await loadExecutionRouterRules(rulesFile);
   const actualLoaded=rust([{op:'loadExecutionRouterRules',path:rulesFile}])[0];
   assert.deepEqual(actualLoaded,{ok:true,value:nodeLoaded});
   count+=2;
  }
  const invalid=Buffer.from([0x66,0x6f,0x80]);
  writeFileSync(rulesFile,invalid);
  assert.deepEqual(rust([{op:'loadExecutionRouterRules',path:rulesFile}])[0],{ok:true,value:await loadExecutionRouterRules(rulesFile)});
  console.log(`Verified ${count+1} routing policy and rules file I/O fixtures`);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
