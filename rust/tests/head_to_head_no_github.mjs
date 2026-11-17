// Direct Node/Rust parity of src/no-github.ts: disabled GhApiClient rejects before remote IO; parameter/argv/env switch truth table.
import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';import {dirname,resolve} from 'node:path';import {fileURLToPath} from 'node:url';
import {noGitHubMode,DisabledGitHubClient} from '../../dist/no-github.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),bin=resolve(root,'rust/target/debug/relay-rust2-parity');let compiled=false;
function rust(req){if(!compiled){const b=spawnSync('cargo',['build','--offline','--manifest-path','rust/Cargo.toml'],{cwd:root,encoding:'utf8',timeout:90000});assert.equal(b.status,0,b.stderr);compiled=true;}
 const r=spawnSync(bin,[],{input:JSON.stringify(req)+'\n',encoding:'utf8',timeout:10000});assert.equal(r.status,0,`${r.error}: ${r.stderr}`);return JSON.parse(r.stdout.trim());}
function nodeMode(req){
 const prevArgv=process.argv,prevEnv=process.env.AGENTS_RELAY_NO_GITHUB;
 try{
  process.argv=['node','script',...req.processArgs];
  if(req.envValue===undefined)delete process.env.AGENTS_RELAY_NO_GITHUB;
  else process.env.AGENTS_RELAY_NO_GITHUB=req.envValue;
  return {ok:true,value:noGitHubMode(req.args)};
 }finally{process.argv=prevArgv;if(prevEnv===undefined)delete process.env.AGENTS_RELAY_NO_GITHUB;else process.env.AGENTS_RELAY_NO_GITHUB=prevEnv;}
}
let seed=0x5a18112f;const rand=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n};const pick=xs=>xs[rand(xs.length)];
test('strict no-GitHub switches match Node across arguments, argv and environment',()=>{
 for(let i=0;i<900;i++){
  const req={op:'noGitHubMode',args:pick([[],['--no-github'],['--no-github=true'],['--id','1'],['--repo','other']]),
   processArgs:pick([[],['--no-github'],['--something'],['--no-github=false']]),envValue:pick([undefined,'1','0','true','false','yes',''])};
  assert.deepEqual(rust(req),nodeMode(req),`GitHub disabled mode ${i}`);
 }
 console.log('Verified 900 no-GitHub mode selection fixtures');
});
test('all four disabled GitHub API methods fail before network with exact error',async()=>{
 const client=new DisabledGitHubClient();
 for(const method of ['request','graphql','rateLimitSnapshot','currentLogin']){
  const expected=await client[method]('repos/test/project').then(value=>({ok:true,value}),error=>({ok:false,error:error.message}));
  const result=rust({op:'disabledGitHubMethod',method});
  assert.deepEqual(result,{ok:true,value:expected},`DisabledGitHubClient.${method}`);
 }
 console.log('Verified all four GitHub transports are fail-closed without HTTP requests');
});
