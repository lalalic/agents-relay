// Node/Rust parity for src/github-pr-archive.ts via an entirely fake GitHubClient; no network, PR merge or real remote modifications.
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {resolve,dirname} from 'node:path';import {fileURLToPath} from 'node:url';
import {archiveDisplayPullRequest} from '../../dist/github-pr-archive.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),bin=resolve(root,'rust/target/debug/relay-rust2-parity');let compiled=false;
function rust(req){if(!compiled){const b=spawnSync('cargo',['build','--offline','--manifest-path','rust/Cargo.toml'],{cwd:root,encoding:'utf8',timeout:90000});assert.equal(b.status,0,b.stderr);compiled=true;}
 const r=spawnSync(bin,[],{input:JSON.stringify({op:'archiveDisplayPullRequestScenario',...req})+'\n',encoding:'utf8',timeout:10000,maxBuffer:5*1024*1024});assert.equal(r.status,0,`${r.error}: ${r.stderr}`);return JSON.parse(r.stdout.trim());}
async function node(req){
 const trace=[];
 const client={async request(path,options){
  trace.push({path,options:options??null});
  const method=options?.method??'GET';
  const stage=method==='POST'?'post':method==='PATCH'?'patch':'list';
  if(req.failAt===stage)throw new Error(req.error??'injected GitHub failure');
  return method==='GET'?req.comments:{status:'ok'};
 }};
 try{
  const value=await archiveDisplayPullRequest(client,req.repository,req.number,req.jobId,req.publishedSha,req.state);
  return {ok:true,value:{result:{ok:true,value},trace}};
 }catch(error){return {ok:true,value:{result:{ok:false,error:error.message},trace}};}
}
let seed=0x4f3331aa;const rand=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n};const choice=xs=>xs[rand(xs.length)];
const scenarios=[
 {repository:'repo/a',number:22,jobId:'job-42',publishedSha:'abc123',state:'OPEN',comments:[]},
 {repository:'repo/a',number:22,jobId:'job-42',publishedSha:'abc123',state:'OPEN',comments:[{body:'Agents Relay local completion: job-42'}]},
 {repository:'repo/a',number:22,jobId:'job-42',publishedSha:'abc123',state:'CLOSED',comments:[]},
 {repository:'repo/a',number:22,jobId:'job-42',publishedSha:'abc123',state:'OPEN',comments:{bad:true}},
 {repository:'repo/a',number:22,jobId:'job-42',publishedSha:'abc123',state:'OPEN',comments:[],failAt:'post'},
 {repository:'repo/a',number:22,jobId:'job-42',publishedSha:'abc123',state:'OPEN',comments:[{body:'Agents Relay local completion: job-42'}],failAt:'patch'},
];
for(let i=0;i<1150;i++){
 const jobId=choice([`job-${i}`,'🐼','local job','']);
 const marker=`Agents Relay local completion: ${jobId}`;
 const comments=choice([[],[{}], [{body:'Another note'}], [{body:marker}], [{body:`prefix ${marker} suffix`}],
  [null,12,{body:4},{body:null}], {notArray:true}, 'bad',null, [false,[],{}], [{body:`Different Job: ${i}`}]]);
 scenarios.push({repository:choice(['owner/repo','another/repo','中文/repo','local-repo']),number:choice([0,1,22,400]),
  jobId,publishedSha:choice(['abc123','HEAD-abc','🐼-commit','000000000000000']),state:choice(['OPEN','OPEN','CLOSED','MERGED','open']),
  comments,failAt:choice([undefined,undefined,undefined,'list','post','patch']),error:choice(['injected GitHub failure','request unavailable','API rejected'])});
}
test('archive display-only GitHub PR only after locally completed Job and never POST duplicate marker',async()=>{
 for(const [i,req] of scenarios.entries()){
  const expected=await node(req),actual=rust(req);
  assert.deepEqual(actual,expected,`GitHub archive fixture ${i}: ${JSON.stringify(req).slice(0,540)}`);
 }
 console.log(`Verified ${scenarios.length} Node/Rust remote PR archive policy scenarios using only fake clients`);
});
