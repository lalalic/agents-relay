// Independent differential for src/model-redecision.ts: classifyFailureEvidence
// keyword precedence over event/log fixtures, plus the redecideFailedTask
// admission guard (non-model evidence must be rejected).
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {classifyFailureEvidence,redecideFailedTask} from '../../dist/model-redecision.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');

async function parity(request){
  return await new Promise((resolvePromise,reject)=>{
    const child=spawn(binary,[],{cwd:root});
    let out='',err='';
    child.stdout.on('data',c=>out+=c);
    child.stderr.on('data',c=>err+=c);
    child.on('error',reject);
    child.on('close',code=>{
      if(code!==0)return reject(new Error(err||`parity exited ${code}`));
      try{
        const parsed=JSON.parse(out.trim());
        if(!parsed.ok)throw new Error('parity error: '+parsed.error);
        resolvePromise(parsed.value);
      }catch(e){reject(new Error(`parity JSON: ${e.message}: ${out.slice(0,300)}`));}
    });
    child.stdin.end(JSON.stringify(request)+'\n');
  });
}
const event=(type,message,data)=>({type,message,data});
test('original Node/Rust model-redecision differential',async()=>{
  const cases=[
    {events:[],logs:[]},
    {events:[event('task.failed','model unavailable',{})],logs:[]},
    {events:[event('task.failed','provider rate limit exceeded',{})],logs:[]},
    {events:[event('task.failed','credential auth failed',{})],logs:[]},
    {events:[event('task.failed','incompatible configuration',{})],logs:[]},
    {events:[event('task.failed','quota exhausted',{})],logs:[]},
    {events:[event('task.failed','laya launch error',{})],logs:[]},
    {events:[event('x','model failed',null)],logs:[]},
    {events:[event('x','worker network socket failed',{})],logs:[]},
    {events:[event('x','daemon relay nats checkout filesystem',{})],logs:[]},
    {events:[event('x','tool infrastructure',{})],logs:[]},
    {events:[event('x','assertion failed',{})],logs:[]},
    {events:[event('x','test failed implementation compile',{})],logs:[]},
    {events:[event('x','typescript syntax semantic error',{})],logs:[]},
    {events:[event('x','request timed out after deadline',{})],logs:[]},
    {events:[event('x','timeout waiting',{})],logs:[]},
    {events:[event('x','unknown weird crash',{})],logs:[]},
    {events:[],logs:['model provider exploded']},
    {events:[],logs:['worker tool failed']},
    {events:[],logs:['something else entirely']},
    {events:[],logs:['RATE LIMIT hit','quota']},
    {events:[event('x','',null)],logs:['']},
    // keyword precedence: model + infra -> infra wins
    {events:[event('x','model provider and worker network both involved',{})],logs:[]},
    // infra + semantic -> infra
    {events:[event('x','worker assert failed',{})],logs:[]},
    // model + semantic, no infra -> model
    {events:[event('x','model compile error',{})],logs:[]},
    // data payloads are searched too
    {events:[event('x','',{detail:'provider quota exceeded'})],logs:[]},
    {events:[event('x','',{nested:{deep:'socket timeout'}})],logs:[]},
    // case-insensitive
    {events:[event('x','MODEL PROVIDER DOWN',{})],logs:[]},
    {events:[event('x','WORKER NETWORK',{})],logs:[]},
    // partial-word matches
    {events:[event('x','remodel the provider',{})],logs:[]},
    {events:[event('x','rate limiting',{})],logs:[]},
    // taskError hint is deliberately ignored
    {events:[],logs:[],taskError:'model provider failed'},
    {events:[event('x','all good',{})],logs:[],taskError:'timeout'},
  ];
  const expected=cases.map(fixture=>{
    const evidence=classifyFailureEvidence(fixture);
    return {ok:true,classification:evidence.classification,
      summary:evidence.summary,sources:evidence.sources};
  });
  const results=[];
  for(const fixture of cases)
    results.push(await parity({op:'certModelRedecision',method:'classify',
      events:fixture.events,logs:fixture.logs,taskError:fixture.taskError??null}));
  const failures=[];
  for(let i=0;i<cases.length;i++){
    const want=expected[i],got=results[i];
    if(JSON.stringify(want)!==JSON.stringify(got))
      failures.push([i,want,got]);
  }
  for(const [i,want,got] of failures.slice(0,8))
    console.log('MR_DIFF',i,JSON.stringify(want).slice(0,200),
      JSON.stringify(got).slice(0,200));
  assert.deepEqual(failures.map(f=>f[0]),[],
    `${failures.length} model-redecision mismatches`);

  // redecideFailedTask admission guard: non-model evidence is rejected before
  // any routing side effect on both stacks.
  const rejected=await redecideFailedTask(
    {task:{kind:'work',capabilities:[]},worker:{workerId:'w'},
     registered:[],usage:{readUsageSnapshot:async()=>({generatedAt:'2026-01-01T00:00:00.000Z',entries:[]})},
     evidence:expected[8],updateRouting:async()=>{throw new Error('must not update');}})
    .then(()=>null,error=>error.message);
  assert.equal(rejected,'Model re-decision requires model/provider/runtime evidence');
  console.log('Verified',cases.length,'original Node/Rust model-redecision cases');
});
