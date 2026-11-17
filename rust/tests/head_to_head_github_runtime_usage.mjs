// Direct Node/Rust JSON-wire differential for src/github-runtime-usage.ts; read-only transport observations and fake CLI headers, no GitHub API.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {emptyGitHubRuntimeRateUsage,observeRuntimeRateLimit,runtimeRejection,parseGitHubCliHeaders} from '../../dist/github-runtime-usage.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const binary=resolve(root,'rust/target/debug/relay-rust2-parity');
let built=false;
function rust(req){
 if(!built){const build=spawnSync('cargo',['build','--offline','--manifest-path','rust/Cargo.toml'],{cwd:root,encoding:'utf8',timeout:90000});assert.equal(build.status,0,build.stderr);built=true;}
 const result=spawnSync(binary,[],{input:JSON.stringify(req)+'\n',encoding:'utf8',timeout:10000});
 assert.equal(result.status,0,`${result.error}: ${result.stderr}`);return JSON.parse(result.stdout.trim());
}
function node(req){
 try{
  let value;
  if(req.op==='emptyGitHubRuntimeRateUsage')value=emptyGitHubRuntimeRateUsage();
  if(req.op==='observeRuntimeRateLimit')value=observeRuntimeRateLimit(req.channel,req.response,req.observedAt);
  if(req.op==='runtimeRejection')value=runtimeRejection(req.observation);
  if(req.op==='parseGitHubCliHeaders')value=parseGitHubCliHeaders(req.output,req.hadHeaders);
  return {ok:true,value:JSON.parse(JSON.stringify(value))};
 }catch(error){return {ok:false,error:error.message};}
}
let seed=0xca0052d3;
const rand=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n};
const choose=xs=>xs[rand(xs.length)];
const requests=[{op:'emptyGitHubRuntimeRateUsage'}];
const samples=[
 'HTTP/2 200 OK\r\nx-ratelimit-limit: 5000\r\nx-ratelimit-reset: 1893456000\r\nx-ratelimit-remaining: 4990\r\n\r\n{"ok":true}',
 'HTTP/1.1 403 Forbidden\nRetry-After: 8\nx-ratelimit-remaining: 0\n\n{"message":"rate limit"}',
 'HTTP/1.1 429 Too Many Requests\r\nX-Ratelimit-Resource: graphql\r\n\r\nsecondary rate limit',
 'no header boundary','HTTP/2 200 OK\n\nbody only',
 'HTTP/1.1 201 Created\nset-cookie: secret\nX-A: alpha\nX-A: beta\nBadHeader\n\nresult',
 'HTTP/1.1 500 Error\r\nHeader:\r\n:invalid\r\n \r\n\r\nbody',
 '', 'Unicode⚡⚡\n\nText',
 'HTTP/1.1 204 No Content\r\n\r\n',
];
for(const output of samples)for(const hadHeaders of [true,false])requests.push({op:'parseGitHubCliHeaders',output,hadHeaders});
for(let i=0;i<420;i++){
 const status=choose([200,201,403,429,500,null]);
 const ending=choose(['\r\n\r\n','\n\n','no boundary']);
 const line=choose(['X-RateLimit-Remaining: 0','Retry-After: 8','Bad Header','x-ratelimit-limit: 1000','x-ratelimit-resource: search','X-RateLimit-Remaining: 8']);
 requests.push({op:'parseGitHubCliHeaders',hadHeaders:choose([true,false]),output:`HTTP/1.1 ${status??200} ${choose(['OK','Error'])}\n${line}\n${choose(['x-test: one','X-Test: two','Header no colon'])}${ending}Body_${i}`});
}
const reasons=['','unrelated error','secondary rate limit','Rate Limit Exceeded','graphql_rate_limit','socket hang up','Error 403','request timeout', '😀'.repeat(400)];
const values=[undefined,'', '0',' 0 ', '5000', '429', '3.5','1893456000','-5','1e3','abc','Infinity','0x10','0b111', '9999999999999999999'];
const dates=['2026-09-29T00:00:00.000Z','2026-11-16T12:02:03.250Z','2025-01-01','2026-11-16T12:00:00+05:00'];
for(let i=0;i<850;i++){
 const headers={};
 for(const key of ['x-ratelimit-resource','x-ratelimit-remaining','x-ratelimit-limit','x-ratelimit-reset','x-ratelimit-used','retry-after']){
  if(rand(3)!==0)headers[key]=key==='x-ratelimit-resource'?choose(['core','graphql','search','UNKNOWN','']):choose(values);
 }
 const response={status:choose([null,200,201,204,304,403,404,429,500,503]),headers,body:choose(reasons),stderr:choose(reasons)};
 requests.push({op:'observeRuntimeRateLimit',channel:choose(['rest','graphql']),response,observedAt:choose(dates)});
}
requests.push({op:'observeRuntimeRateLimit',channel:'rest',observedAt:'2026-11-16T12:00:00Z',
 response:{status:429,headers:{},body:'x'.repeat(1999)+'🙂',stderr:''}});
requests.push({op:'observeRuntimeRateLimit',channel:'graphql',observedAt:'2026-11-16T12:00:00Z',
 response:{status:429,headers:{},body:'x'.repeat(1998)+'🙂',stderr:''}});
for(let i=0;i<500;i++){
 const observation={resource:choose(['core','search','graphql']),observedAt:choose(dates),status:choose([403,429,500,null]),
  throttled:choose([false,true]),remaining:choose([null,0,1,50]),retryAfterSeconds:choose([null,0,0.5,3,15]),reason:choose(reasons)};
 requests.push({op:'runtimeRejection',observation});
}
test('GitHub runtime usage telemetry, rejection classification and CLI response headers match Node',()=>{
 for(const [i,scenario] of requests.entries()){
  // Node's JSON bridge cannot represent own properties whose value is undefined.
  // Match both runtimes against the exact transported input envelope.
  const req=JSON.parse(JSON.stringify(scenario));
  const expected=node(req),actual=rust(req);
  assert.deepEqual(actual,expected,`Fixture ${i}: ${JSON.stringify(req).slice(0,400)}`);
 }
 console.log(`Verified ${requests.length} Node/Rust GitHub usage/headers fixtures without network access`);
});
