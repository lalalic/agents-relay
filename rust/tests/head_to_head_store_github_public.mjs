// Independent differential for src/store-github.ts: GitHubStore over an
// injected fixture client — marker parsing, trusted filtering, load/save,
// append, validation, PR state. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {GitHubStore} from '../../dist/store-github.js';
import {renderJobBody,renderTaskComment,renderPlanComment,
  renderAgentComment} from '../../dist/markers.js';

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
function fixtureClient(comments){
  const state={comments:[...comments],requests:[]};
  return {
    state,
    async graphql(){
      return {data:{repository:{pullRequest:{state:'OPEN',
        body:'<!-- agents-relay:job:v1 {"id":"j1","repository":"owner/repo"} -->',
        headRef:{name:'feature'},headRefOid:{oid:'a'.repeat(40)},
        number:7}}}};
    },
    async request(path,method,body){
      state.requests.push({path,method,body});
      if(method==='POST'){
        const id=1000+state.comments.length;
        const comment={id,nodeId:`NODE-${id}`,authorLogin:'trusted-author',
          body:body?.body??null,updatedAt:'2026-01-01T00:00:00.000Z',
          url:`https://example.test/c/${id}`};
        state.comments.push(comment);
        return comment;
      }
      return null;
    },
  };
}
const task=(id,over={})=>({jobId:'j1',id,kind:'work',state:'QUEUED',
  title:'T '+id,dependencies:[],attempt:0,maxAttempts:3,
  createdAt:'2026-01-01T00:00:00.000Z',
  updatedAt:'2026-01-01T00:00:00.000Z',...over});
const jobComment=(job)=>({id:1,nodeId:'N1',authorLogin:'trusted-author',
  body:renderJobBody(job),updatedAt:'2026-01-01T00:00:00.000Z',
  url:'u'});
test('original Node/Rust store-github differential',async()=>{
  const cases=[];
  const mkJob=(over={})=>({id:'j1',repository:'owner/repo',state:'ACTIVE',
    tasks:[],plans:[],createdAt:'2026-01-01T00:00:00.000Z',
    updatedAt:'2026-01-01T00:00:00.000Z',...over});
  // load: valid job marker comment
  cases.push({method:'load',jobId:'j1',
    comments:[jobComment(mkJob())]});
  // load: no comments
  cases.push({method:'load',jobId:'j1',comments:[]});
  // load: job marker from untrusted author ignored
  cases.push({method:'load',jobId:'j1',
    comments:[{...jobComment(mkJob()),authorLogin:'rando'}]});
  // load: task + plan comments included
  cases.push({method:'load',jobId:'j1',comments:[
    jobComment(mkJob()),
    {id:2,nodeId:'N2',authorLogin:'trusted-author',
      body:renderTaskComment(task('t1')),updatedAt:'x',url:'u'},
    {id:3,nodeId:'N3',authorLogin:'trusted-author',
      body:renderPlanComment({jobId:'j1',id:'p1',round:1,
        source:'model-planner',status:'SUCCEEDED',trigger:{source:'cli'},
        generatedTaskIds:[],headSha:null,attempt:1,maxAttempts:3,
        leaseOwner:null,leaseExpiresAt:null,executionId:null,
        createdAt:'2026-01-01T00:00:00.000Z',
        updatedAt:'2026-01-01T00:00:00.000Z'}),updatedAt:'x',url:'u'},
  ]});
  // saveJob on empty store
  cases.push({method:'saveJob',job:mkJob(),comments:[]});
  // appendTask
  cases.push({method:'appendTask',task:task('t9'),comments:[]});
  // listAgents with one trusted agent comment
  cases.push({method:'listAgents',comments:[
    {id:5,nodeId:'N5',authorLogin:'trusted-author',
      body:renderAgentComment({name:'researcher',adapter:'codex',
        registeredAt:'2026-01-01T00:00:00.000Z'}),updatedAt:'x',url:'u'},
    {id:6,nodeId:'N6',authorLogin:'rando',
      body:renderAgentComment({name:'imposter',adapter:'codex',
        registeredAt:'2026-01-01T00:00:00.000Z'}),updatedAt:'x',url:'u'},
  ]});
  // validateJobBinding
  cases.push({method:'validateJobBinding',jobId:'j1',
    comments:[jobComment(mkJob())]});
  cases.push({method:'validateJobBinding',jobId:'other',comments:[]});
  // PR state + head
  cases.push({method:'pullRequestState',comments:[]});
  cases.push({method:'headSha',comments:[]});

  const expected=[];
  for(const fixture of cases){
    const client=fixtureClient(fixture.comments??[]);
    const store=new GitHubStore(client,'owner/repo',7,
      new Set(['trusted-author']));
    try{
      if(fixture.method==='load'){
        const job=await store.load(fixture.jobId);
        expected.push({ok:true,job});
      }else if(fixture.method==='saveJob'){
        await store.saveJob(fixture.job);
        expected.push({ok:true,
          bodies:client.state.comments.map(c=>c.body)});
      }else if(fixture.method==='appendTask'){
        await store.appendTask(fixture.task);
        expected.push({ok:true,
          bodies:client.state.comments.map(c=>c.body)});
      }else if(fixture.method==='listAgents'){
        expected.push({ok:true,agents:await store.listAgents()});
      }else if(fixture.method==='validateJobBinding'){
        await store.validateJobBinding(fixture.jobId);
        expected.push({ok:true});
      }else if(fixture.method==='pullRequestState'){
        expected.push({ok:true,state:await store.pullRequestState()});
      }else if(fixture.method==='headSha'){
        expected.push({ok:true,sha:await store.headSha()});
      }
    }catch(error){
      expected.push({ok:false,error:error?.message??String(error)});
    }
  }
  const results=[];
  for(const fixture of cases){
    results.push(await parity({op:'certStoreGithub',
      method:fixture.method,jobId:fixture.jobId,job:fixture.job,
      task:fixture.task,comments:fixture.comments??[]}));
  }
  const failures=[];
  for(let i=0;i<cases.length;i++){
    const want=expected[i],got=results[i];
    if(want.ok!==got.ok){failures.push([i,want,got]);continue;}
    if(want.ok===false&&want.error!==got.error){failures.push([i,want,got]);continue;}
    if(want.ok===true&&JSON.stringify(want)!==JSON.stringify(got))
      failures.push([i,want,got]);
  }
  for(const [i,want,got] of failures.slice(0,8))
    console.log('SG_DIFF',i,JSON.stringify(want).slice(0,240),
      JSON.stringify(got).slice(0,240));
  assert.deepEqual(failures.map(f=>String(f[0])),[],
    `${failures.length} store-github mismatches`);
  console.log('Verified',cases.length,
    'original Node/Rust store-github cases');
});
