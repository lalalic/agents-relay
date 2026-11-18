// Complete original GitHub PR lookup/create/race/bootstrap API versus native
// Rust with one strictly offline in-memory GitHub effect interpreter.
// No real repository, user PR, credential or network is accessed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {resolvePullRequest} from '../../dist/store.js';
const root=resolve(import.meta.dirname,'../..');
const bin=join(root,'rust/target/debug/relay-rust2-parity');
const pr=(number=43)=>({
 number,title:'Fixture PR',body:'Only local fixture',state:'OPEN',
 headRefName:'feature-local',baseRefName:'main'
});
const empty=()=>({repository:{pullRequests:{nodes:[]}}});
const found=(rows=[pr()])=>({repository:{pullRequests:{nodes:rows}}});
const id=()=>({repository:{id:'repo-gql-id'}});
const made=(item=pr())=>({createPullRequest:{pullRequest:item}});
const branch=(head=true)=>({repository:{
 head:head?{target:{oid:'head-oid',tree:{oid:'tree-oid'}}}:null,
 base:{target:{oid:'main-oid',tree:{oid:'tree-oid'}}}
}});
const error=(message)=>({fixtureError:message});
const base={repository:'test/repo',options:{head:'feature-local',title:'Fixture PR',body:'Only local fixture'}};
const cases=[
 {...base,repository:'invalid',responses:[]},
 {...base,repository:'/repo',responses:[]},
 {...base,options:{},responses:[]},
 {...base,options:{prNumber:43},responses:[{repository:{pullRequest:pr()}}]},
 {...base,options:{prNumber:43},responses:[{repository:{pullRequest:null}}]},
 {...base,options:{prNumber:43},responses:[{repository:{pullRequest:{number:-1}}}]},
 {...base,responses:[found()]},
 {...base,options:{head:'feature-local'},responses:[empty()]},
 {...base,responses:[empty(),{ahead_by:3},id(),made()]},
 {...base,responses:[empty(),{ahead_by:3},id(),error('injected collision'),found()]},
 {...base,responses:[empty(),{ahead_by:3},id(),error('forbidden'),empty()]},
 {...base,responses:[empty(),{ahead_by:0},branch(),{sha:'new-commit'},
  {},found()]},
 {...base,responses:[empty(),error('404 Not Found'),branch(false),
  {},{sha:'new-commit'},{},found()]},
 {...base,responses:[empty(),{ahead_by:0},branch(),{sha:'new-commit'},
  {},empty(),id(),made()]},
 {...base,responses:[empty(),{ahead_by:0},branch(),error('commit rejected')]},
 {...base,responses:[empty(),{ahead_by:0},branch(),{},empty()]},
 {...base,responses:[empty(),{ahead_by:0},branch(),{},{}]},
 {...base,responses:[empty(),{ahead_by:1},id(),error('No commits between main and feature'),
  empty(),branch(),{sha:'new-commit'},{},found()]},
 {...base,responses:[empty(),{ahead_by:1},id(),error('No commits between main and feature'),
  empty(),branch(),{sha:'new-commit'},{},empty(),made()]},
 {...base,responses:[empty(),{ahead_by:1},id(),error('No commits between main and feature'),
  empty(),branch(),{sha:'new-commit'},{},empty(),error('retry failed')]},
 {...base,responses:[empty(),error('503 temporary outage')]},
 {...base,responses:[found([{...pr(),headRefName:'someone-else'},pr()])]},
 {...base,responses:[found([{...pr(),number:0}])]},
 {...base,responses:[empty(),{ahead_by:1},{repository:null}]},
];
async function node(f){
 const responses=structuredClone(f.responses);
 const calls=[];
 const client={
  graphql:async(query,variables)=>{
   calls.push({kind:'graphql',query,variables});
   const value=responses.shift();
   if(value===undefined)throw Error('Fixture GitHub effect exhausted');
   if(value.fixtureError)throw Error(value.fixtureError);
   return value;
  },
  request:async(path,init)=>{
   calls.push({kind:'request',path,method:init?.method??'GET',
    body:init?.body?JSON.parse(init.body):null});
   const value=responses.shift();
   if(value===undefined)throw Error('Fixture GitHub effect exhausted');
   if(value.fixtureError)throw Error(value.fixtureError);
   return value;
  }
 };
 let outcome;
 try{outcome={ok:true,value:await resolvePullRequest(client,f.repository,f.options)};}
 catch(e){outcome={ok:false,error:e.message};}
 return {outcome,calls};
}
test('original Node and Rust GraphQL PR resolve, race and bootstrap effects',async()=>{
 const expected=[];for(const c of cases)expected.push(await node(c));
 const child=spawnSync(bin,[],{cwd:root,
  input:cases.map(c=>JSON.stringify({op:'apiResolvePullRequest',...c})).join('\n')+'\n',
  encoding:'utf8',timeout:120000,maxBuffer:15*1024*1024});
 assert.equal(child.status,0,child.stderr||child.error?.message);
 const actual=child.stdout.trim().split('\n').map(JSON.parse);
 assert.equal(actual.length,cases.length);
 const mismatches=[];
 for(let i=0;i<cases.length;i++){
  if(!actual[i].ok){mismatches.push({i,adapter:actual[i].error});continue;}
  try{assert.deepEqual(actual[i].value,expected[i]);}
  catch{mismatches.push({i,case:cases[i],node:expected[i],rust:actual[i].value});}
 }
 assert.deepEqual(mismatches,[],JSON.stringify(mismatches,null,2));
 console.log('Verified',cases.length,'Node/Rust GitHub PR mutation decision effects');
});
