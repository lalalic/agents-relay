// Independent differential for src/decision-audit.ts: redaction, reason
// codes, route-result projection, recent-route joining (bounded JSONL scan +
// legacy full join), the JSONL store over real files, and both audit record
// builders. Timestamps/UUIDs are normalized on both stacks; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  JsonlDecisionAuditStore,outcomeForDecision,recentExecutionRouteResults,
  makeDecisionAudit,makeExecutionDecisionAudit,taskAuditFacts,
} from '../../dist/decision-audit.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');

async function parity(request){
  return new Promise((resolvePromise,reject)=>{
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
        resolvePromise(parsed);
      }catch(e){reject(new Error(`parity JSON: ${e.message}: ${out.slice(0,300)}`));}
    });
    child.stdin.end(JSON.stringify(request)+'\n');
  });
}

const summaries=[
  'task.completed','stream disconnected: Bearer private-token api_key=private-secret',
  'rate limit exceeded for provider','rate_limit_exceeded','HTTP 429 from upstream',
  'quota exhausted after retry','credits exhausted','provider glitch',
  'worker timed out','launch failed','authentication rejected','task failed',
  '中文 失败\n包含\t空白','x'.repeat(400),
  'Bearer abc123 then password=hunter2 access_token=zzz credential:qqq',
  'TOKEN=one SECRET=two api-key=three Authorization: Bearer four',
];
// 'task_started' outcomes are filtered by the public recent-routes path on
// both stacks, so the private default branch for it is not publicly reachable.
const kinds=['success','cancelled','blocked','outcome_unknown','auth_config_failure',
  'timeout','launch_failure','provider_failure','runtime_failure','semantic_failure',
  'task_failure','made_up_kind'];

test('original Node/Rust decision-audit differential',async()=>{
  const cases=[];
  // 1. routeReason redaction/whitespace/240 cap (UTF-16 units incl. surrogate pair)
  for(const value of summaries)cases.push({method:'routeReason',value});
  cases.push({method:'routeReason',value:'😀'.repeat(200)});
  cases.push({method:'routeReason',value:''});
  // 2. routerReasonCode over kinds x summaries
  for(const kind of kinds){
    for(const summary of ['stream disconnected','rate limit exceeded',
      'quota exhausted','plain failure','response.completed']){
      cases.push({method:'reasonCode',kind,summary});
    }
  }
  // 3. routeResult shape over record kinds and route fixtures, derived
  //    through the same public decision/outcome join on both stacks.
  const routeFixtures=[
    {worker:'codex',adapter:'codex',provider:'zai',model:'glm',profile:'p',reasoning:'high'},
    {worker:'w',adapter:'a',provider:'p',model:'m'},
    {worker:'w',adapter:'a',provider:'p',model:'m',profile:'',reasoning:null},
    {worker:'w',adapter:'a',provider:'p'},
    {worker:123,adapter:'a',provider:'p',model:'m'},
    {worker:'w',adapter:'a',provider:'p',model:'m',profile:{deep:{x:1}},reasoning:['r']},
    {worker:'w',adapter:'a',provider:'p',model:'m',profile:'  ',reasoning:'ok'},
  ];
  for(const kind of ['success','cancelled','blocked','outcome_unknown',
    'task_failure','provider_failure']){
    for(const route of routeFixtures){
      cases.push({method:'routeResult',limit:1,records:[
        {record_type:'decision',decision_id:'d',
          selected:{worker:{id:route.worker,adapter:route.adapter},
            model:{provider:route.provider,model:route.model,
              profile:route.profile,reasoning:route.reasoning}}},
        {record_type:'outcome',outcome_id:'o',decision_id:'d',
          timestamp:'2026-11-04T00:00:00.000Z',kind,
          summary:'stream disconnected',evidence:{}},
      ]});
    }
  }
  // 4. recentRoutes: legacy join over mixed records
  const baseDecision={
    record_type:'decision',schema_version:5,timestamp:'2026-11-04T00:00:00.000Z',
    selected:{worker:{id:'codex',adapter:'codex'},
      model:{provider:'zai',model:'glm',profile:'zai',reasoning:'high'}},
  };
  const outcome=(decision_id,kind,timestamp,evidence={})=>({
    record_type:'outcome',schema_version:5,outcome_id:'o-'+decision_id+'-'+kind,
    decision_id,timestamp,kind,summary:'s',evidence});
  {
    const records=[];
    for(let i=0;i<12;i++){
      records.push({...baseDecision,decision_id:'route-'+i});
      records.push(outcome('route-'+i,i%2?'success':'task_failure',
        '2026-11-04T00:'+String(i+1).padStart(2,'0')+':00.000Z'));
    }
    // pending selection must not count
    records.push({...baseDecision,decision_id:'pending',
      timestamp:'2026-11-04T23:00:00.000Z'});
    records.push(outcome('pending','task_started','2026-11-04T23:00:01.000Z'));
    // same key updated later replaces earlier
    records.push(outcome('route-0','provider_failure','2026-11-04T00:01:30.000Z',
      {execution_id:'exec-x'}));
    records.push(outcome('route-0','cancelled','2026-11-04T00:02:30.000Z',
      {execution_id:'exec-x'}));
    // same timestamp different order -> later record wins
    records.push(outcome('route-1','success','2026-11-04T00:02:00.000Z',
      {execution_id:'e1'}));
    records.push(outcome('route-1','task_failure','2026-11-04T00:02:00.000Z',
      {execution_id:'e1'}));
    // two attempts on one decision -> separate entries
    records.push(outcome('route-2','success','2026-11-04T00:03:00.000Z',
      {execution_id:'a'}));
    records.push(outcome('route-2','timeout','2026-11-04T00:04:00.000Z',
      {execution_id:'b'}));
    // legacy outcome without execution/attempt -> 'legacy' key
    records.push(outcome('route-3','blocked','2026-11-04T00:05:00.000Z'));
    // attempt as number evidence
    records.push(outcome('route-4','success','2026-11-04T00:06:00.000Z',{attempt:2}));
    records.push(outcome('route-4','cancelled','2026-11-04T00:07:00.000Z',{attempt:3}));
    // outcome for missing decision -> dropped
    records.push(outcome('ghost','success','2026-11-04T00:08:00.000Z'));
    cases.push({method:'recentRoutes',records,limit:10});
    cases.push({method:'recentRoutes',records,limit:3});
    cases.push({method:'recentRoutes',records,limit:0});
    cases.push({method:'recentRoutes',records,limit:99});
    cases.push({method:'recentRoutes',records:records.slice().reverse(),limit:10});
  }
  // 5. jsonlStore: real files both stacks (temp dirs per stack)
  {
    const appends=[
      outcomeForDecision('d1','success','ok',{attempt:1,execution_id:'e1',
        route:{worker:'w',adapter:'a',provider:'p',model:'m'}}),
      outcomeForDecision('d2','task_failure','bad',{execution_id:'e2',
        route:{worker:'w',adapter:'a',provider:'p',model:'m',profile:'p',reasoning:'r'}}),
      {...baseDecision,decision_id:'d3'},
    ];
    cases.push({method:'jsonlStore',appends,limit:10});
    cases.push({method:'jsonlStore',appends,limit:0});
    // 20 outcomes -> cap 10, bounded tail path, newest first
    const many=[];
    for(let i=0;i<20;i++)many.push(outcomeForDecision('d-'+i,
      i%2?'success':'provider_failure',
      i%2?'done':'provider_unavailable',{execution_id:'e-'+i,
        route:{worker:'w',adapter:'a',provider:'p',model:'m'}}));
    cases.push({method:'jsonlStore',appends:many,limit:10});
    // legacy outcomes without route -> full-join fallback
    const legacy=[];
    for(let i=0;i<3;i++){
      legacy.push({...baseDecision,decision_id:'L-'+i});
      legacy.push(outcome('L-'+i,'success','2026-11-04T00:0'+i+':00.000Z'));
    }
    cases.push({method:'jsonlStore',appends:legacy,limit:10});
    // raw file with malformed lines + trailing partial line + CRLF
    cases.push({method:'jsonlStore',rawFile:
      '{"record_type":"outcome","kind":"success","decision_id":"r1","timestamp":"2026-11-04T00:01:00.000Z","summary":"ok","evidence":{"route":{"worker":"w","adapter":"a","provider":"p","model":"m"}}}\n'
      +'not json at all\n'
      +'{"record_type":"outcome","kind":"task_failure","decision_id":"r2","timestamp":"2026-11-04T00:02:00.000Z","summary":"bad","evidence":{"route":{"worker":"w","adapter":"a","provider":"p","model":"m"}}}\r\n'
      +'{"record_type":"outcome","kind":"success","decision_id":"r3","timestamp":"2026-11-04T00:03',
      appends:[],limit:10});
  }
  // 6. outcomeForDecision (normalize UUID + timestamp)
  cases.push({method:'outcomeForDecision',decisionId:'d',kind:'success',
    summary:'Bearer tok abc',evidence:{a:1}});
  cases.push({method:'outcomeForDecision',decisionId:'d',kind:'provider_failure',
    summary:'plain'});
  // 7. taskAuditFacts
  const taskShape={jobId:'j',id:'t',attempt:2,executionId:'e',
    capabilities:['codex','model'],input:'  long\n text  '};
  cases.push({method:'taskAuditFacts',task:taskShape});
  cases.push({method:'taskAuditFacts',task:{...taskShape,executionId:undefined,
    capabilities:[],input:'😀'.repeat(60)}});
  cases.push({method:'taskAuditFacts',task:null});
  // 8. makeDecisionAudit (normalize UUID; decidedAt is caller-supplied)
  const candidate=(id,over={})=>({id,provider:'openai',model:'m-'+id,
    profile:null,reasoning:null,resourceHealthy:true,resourceRemainingPercent:80,...over});
  const loadedPolicy=(over={})=>({path:null,hash:'h',
    policy:{disabledProviders:['b'],...over.policy},snapshot:over.snapshot??{},
    rules:{path:'r',hash:'rh',text:'rules'}});
  const routing={decidedAt:'2026-11-04T00:00:00.000Z',decidedBy:'engine',
    decisionEvidence:{fallback:true,error:'boom'}};
  cases.push({method:'makeDecisionAudit',
    task:taskShape,
    worker:{id:'w',adapter:'codex'},
    contract:{constraints:{provider:'openai'},excludedRoutes:[{provider:'openai',model:'m-x'}]},
    policy:loadedPolicy({snapshot:{disabledProviders:['b']}}),
    candidates:[candidate('x'),candidate('y',{resourceHealthy:false,reasoning:'high'}),
      candidate('z',{profile:'b'})],
    eligible:[candidate('x')],selected:candidate('x'),routing,
    priorDecisionId:'prev',priorFailure:{classification:'c',summary:'s',sources:['e']}});
  cases.push({method:'makeDecisionAudit',
    task:null,worker:{},contract:{},
    policy:{path:'p',hash:'',policy:{},snapshot:{},
      rules:{path:'',hash:'',text:''}},
    candidates:[],eligible:[],selected:candidate('only'),routing:{}});
  // no decisionEvidence -> fallback false + reason undefined
  cases.push({method:'makeDecisionAudit',
    task:{jobId:'j',id:'t',attempt:0,executionId:null,capabilities:[],input:''},
    worker:{},contract:{constraints:{model:'m-x'},excludedRoutes:[{model:'other'}]},
    policy:{path:null,hash:'h',policy:{disabledProfiles:['b']},snapshot:{},
      rules:{path:'r',hash:'rh',text:'t'}},
    candidates:[candidate('x',{profile:'b'})],eligible:[],selected:candidate('x',{profile:'b'}),
    routing:{decidedAt:'t',decidedBy:'e'}});
  // 9. makeExecutionDecisionAudit
  const worker=(id,over={})=>({workerId:id,adapter:'codex',capabilities:['model'],
    ...over});
  const route=(id,w,m)=>({id,worker:w,model:m});
  const w1=worker('w1',{runtime:'codex',trustDomains:['x'],labels:{a:1},
    browserWorkspaceCapacity:{available:1}});
  const w2=worker('w2');
  cases.push({method:'makeExecutionDecisionAudit',
    task:taskShape,
    workers:[w1,w2],
    requirements:{capabilities:[]},
    evaluations:[
      {route:route('r1',w1,candidate('m1')),eligible:true,rejectionReasons:[]},
      {route:route('r2',w2,candidate('m2')),eligible:false,
        rejectionReasons:['prior_failed_route','policy_disabled_provider']},
    ],
    workerGates:[{workerId:'w1',eligible:true,rejectionReasons:[]},
      {workerId:'w2',eligible:false,rejectionReasons:['resource_unhealthy']}],
    selected:route('r1',w1,candidate('m1')),
    contract:{question:'execution-route-selection',constraints:{},excludedRoutes:[]},
    policy:loadedPolicy({snapshot:{disabledProviders:['b']}}),routing,
    stages:[{name:'s1',facts:{f:1},contract:{type:'choice',question:'q',choices:['a','b']},
      result:{choice:'a',probabilities:{a:0.7,b:0.3},bypassed:false}},
      {name:'s2',facts:{},contract:{type:'choice',question:'q2',choices:['c']},
        result:{choice:'c'}}]});
  cases.push({method:'makeExecutionDecisionAudit',
    task:null,workers:[],requirements:{},
    evaluations:[],workerGates:[],selected:route('r',worker('w'),candidate('m')),
    contract:{},policy:{path:null,hash:'',policy:{},snapshot:{},
      rules:{path:'',hash:'',text:''}},
    routing:{decidedAt:'t',decidedBy:'e'},stages:[]});

  // ---- Node expected values ----
  const nodeTmp=mkdtempSync(join(tmpdir(),'rust2-da-node-'));
  test.after(()=>rmSync(nodeTmp,{recursive:true,force:true}));
  const normalize=(value)=>{
    const clone=structuredClone(value);
    if(Array.isArray(clone))return clone.map(normalize);
    if(clone&&typeof clone==='object'){
      delete clone.decision_id;
      delete clone.outcome_id;
      if(typeof clone.timestamp==='string')clone.timestamp='TS';
      for(const key of Object.keys(clone))clone[key]=normalize(clone[key]);
      return clone;
    }
    return clone;
  };
  const expected=[];
  for(const fixture of cases){
    if(fixture.method==='routeReason'){
      // routeReason is private; derive through outcomeForDecision summary.
      expected.push(outcomeForDecision('d','success',fixture.value).summary);
    }else if(fixture.method==='reasonCode'){
      const store=new JsonlDecisionAuditStore(
        join(nodeTmp,'reason-'+Math.random().toString(36).slice(2)+'.jsonl'));
      await store.append(outcomeForDecision('d',fixture.kind,fixture.summary,
        {route:{worker:'w',adapter:'a',provider:'p',model:'m'}}));
      const [row]=await recentExecutionRouteResults(store,1);
      expected.push(row?row.reason:'DROP');
    }else if(fixture.method==='routeResult'){
      const rows=await recentExecutionRouteResults(
        {read:async()=>fixture.records},fixture.limit);
      expected.push(rows.length?normalize(rows[0]):'DROP');
    }else if(fixture.method==='recentRoutes'){
      expected.push((await recentExecutionRouteResults(
        {read:async()=>fixture.records},fixture.limit)).map(normalize));
    }else if(fixture.method==='jsonlStore'){
      const path=join(nodeTmp,'store-'+Math.random().toString(36).slice(2)+'.jsonl');
      if(fixture.rawFile!==undefined)writeFileSync(path,fixture.rawFile);
      const store=new JsonlDecisionAuditStore(path);
      for(const record of fixture.appends)await store.append(record);
      expected.push({read:(await store.read()).map(normalize),
        routes:(await store.readRecentRoutes(fixture.limit)).map(normalize)});
    }else if(fixture.method==='outcomeForDecision'){
      expected.push(normalize(outcomeForDecision(fixture.decisionId,
        fixture.kind,fixture.summary,fixture.evidence)));
    }else if(fixture.method==='taskAuditFacts'){
      expected.push(taskAuditFacts(fixture.task??undefined));
    }else if(fixture.method==='makeDecisionAudit'){
      expected.push(normalize(makeDecisionAudit({
        task:fixture.task??undefined,worker:fixture.worker,
        contract:fixture.contract,
        policy:{path:fixture.policy.path,hash:fixture.policy.hash,
          policy:fixture.policy.policy,snapshot:fixture.policy.snapshot,
          rules:fixture.policy.rules},
        candidates:fixture.candidates,eligibleCandidates:fixture.eligible,
        selected:fixture.selected,routing:fixture.routing,
        priorDecisionId:fixture.priorDecisionId,
        priorFailure:fixture.priorFailure})));
    }else if(fixture.method==='makeExecutionDecisionAudit'){
      expected.push(normalize(makeExecutionDecisionAudit({
        task:fixture.task??undefined,workers:fixture.workers,
        requirements:fixture.requirements,evaluations:fixture.evaluations,
        workerGateEvaluations:fixture.workerGates,selected:fixture.selected,
        contract:fixture.contract,
        policy:{path:fixture.policy.path,hash:fixture.policy.hash,
          policy:fixture.policy.policy,snapshot:fixture.policy.snapshot,
          rules:fixture.policy.rules},
        routing:fixture.routing,decisionStages:fixture.stages})));
    }
  }
  // ---- Rust side ----
  const results=[];
  for(const fixture of cases){
    const request=JSON.parse(JSON.stringify({op:'certDecisionAudit',...fixture}));
    const parsed=await parity(request);
    if(fixture.method==='outcomeForDecision'){
      results.push(normalize(parsed.value.outcome));
    }else if(fixture.method==='jsonlStore'){
      results.push({read:(parsed.value.read??[]).map(normalize),
        routes:(parsed.value.routes??[]).map(normalize)});
    }else{
      results.push(normalize(parsed.value));
    }
    if((fixture.method==='routeResult')
      &&(results.at(-1)===null||results.at(-1)===undefined))
      results[results.length-1]='DROP';
  }
  const failures=[];
  for(let i=0;i<cases.length;i++){
    if(results[i]===undefined)
      throw new Error('missing Rust result for case '+i+' '+cases[i].method);
    const want=JSON.stringify(expected[i]);
    const got=JSON.stringify(results[i]);
    if(want!==got)failures.push([i,cases[i].method,want,got]);
  }
  for(const [i,method,want,got] of failures.slice(0,10))
    console.log('DA_DIFF',i,method,'want',want.slice(0,260),'got',got.slice(0,260));
  assert.deepEqual(failures.map(f=>f[0]+':'+f[1]),[],
    `${failures.length} decision-audit mismatches of ${cases.length}`);
  console.log('Verified',cases.length,
    'original Node/Rust decision-audit cases');
});
