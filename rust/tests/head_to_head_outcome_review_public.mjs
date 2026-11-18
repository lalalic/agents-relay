// Read-only Node/Rust Review evaluation with injected runner. No Codex CLI,
// model request, managed Job, real reviewer, or live account is accessed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {evaluateOutcome} from '../../dist/outcome-review.js';
const root=resolve(import.meta.dirname,'../..');
const bin=join(root,'rust/target/debug/relay-rust2-parity');
const options={prompt:'inspect local fixture evidence only',
 projectPath:root,reviewers:['reviewer']};
const values=[
 {status:0,stdout:JSON.stringify({verdict:'PASS',findings:[],evidence:['local test']})},
 {status:0,stdout:JSON.stringify({verdict:'BLOCKED',findings:[],evidence:[]})},
 {status:0,stdout:JSON.stringify({verdict:'CHANGE_REQUIRED',findings:[{reason:'fixture'}],evidence:[]})},
 {status:0,stdout:'not JSON'},
 {status:0,stdout:JSON.stringify({verdict:'PASS',findings:null,evidence:[]})},
 {status:12,stderr:'simulated reviewer process failure',stdout:''},
 {status:null,error:{message:'simulated owned-process error'},stdout:''},
 {status:0,stdout:JSON.stringify({verdict:'INVALID',findings:[],evidence:[]})},
 {status:0,stdout:JSON.stringify({verdict:'PASS',findings:[],evidence:null})},
];
const scenarios=values.map(spawnResponse=>({options,spawnResponse}));
async function node(f){
 const inputs=[];
 let outcome;
 try{
  const value=await evaluateOutcome(f.options,
   (_command,_args,config)=>{
    inputs.push({reviewer:'reviewer',prompt:config.input,project:config.cwd});
    return f.spawnResponse;
   });
  outcome={ok:true,value};
 }catch(error){outcome={ok:false,error:error.message};}
 return {outcome,inputs};
}
test('original Node/Rust Review execution prompt and validation contract',async()=>{
 const expected=[];for(const f of scenarios)expected.push(await node(f));
 const child=spawnSync(bin,[],{cwd:root,
  input:scenarios.map(s=>JSON.stringify({op:'apiOutcomeReview',...s})).join('\n')+'\n',
  encoding:'utf8',timeout:120000,maxBuffer:10*1024*1024});
 assert.equal(child.status,0,child.stderr||child.error?.message);
 const actual=child.stdout.trim().split('\n').map(JSON.parse);
 assert.equal(actual.length,scenarios.length);
 const bad=[];
 for(let i=0;i<scenarios.length;i++){
  if(!actual[i].ok){bad.push({i,error:actual[i].error});continue;}
  try{assert.deepEqual(actual[i].value,expected[i]);}
  catch{bad.push({i,node:expected[i],rust:actual[i].value});}
 }
 assert.deepEqual(bad,[],JSON.stringify(bad,null,2));
 console.log('Verified',scenarios.length,'Node/Rust Review isolated runner scenarios');
});
