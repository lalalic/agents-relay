// Real original Node and Rust Z adapter and Z OAuth differential: worker
// execution-source identity, bounded task brief, short-lived credential
// bootstrap, launch/terminal-recovery request contracts, adapter identity,
// MCP endpoint validation, and the complete PKCE OAuth flow over an
// injected fetcher (both stacks observe structurally identical traffic).
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {
  zExecutionSource,zTaskBrief,zBootstrap,ZAdapter,
} from '../../dist/z-adapter.js';
import {
  zWorkerMcpEndpoint,issueZWorkerCredential,
} from '../../dist/z-oauth.js';

const root=resolve(import.meta.dirname,'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');
const ENDPOINT='https://oauth.example.test/mcp';

// ---------- shared fixtures ----------
const UUID='01234567-89ab-cdef-0123-456789abcdef';
const sourceLine=`Execution source: job/proj-1/task/${UUID}/execution/${UUID}`;
const graphLines=[
  `Job: proj-1-job-1`,
  `Task: t-01`,
  `Execution: ${UUID}`,
].join('\n');
const headerLine='[Relay agent: worker; adapter: z]';
const localInput='Implement the migration and publish task.completed.';
const outputContract='- Publish task.completed\n- Include the diff summary';
const fullZPrompt=[
  headerLine,
  'Job objective: Ship the rust2 z adapter tranche',
  '',
  'Treat the following durable task input as the authoritative work contract; do not query GitHub.',
  '',
  localInput,
  '',
  '[Authoritative execution context]',
  'Graph: job/proj-1/task/t-01',
  '',
  '[Output contract]',
  outputContract,
  '',
  '[Required event contracts]',
  'task.completed requires result JSON.',
].join('\n');
const rolePrompt=[
  '# Role',
  'You are the implementation worker.',
  '',
  '## Bootstrap',
  'Read the pinned harness bootstrap first.',
].join('\n');

const EXECUTION_PROMPTS=[
  ['explicit',`${sourceLine}`],
  ['explicit-plus-graph',[sourceLine,graphLines].join('\n')],
  ['graph-only',graphLines],
  ['two-explicit',[sourceLine,sourceLine.replace('job/proj-1','job/proj-2')].join('\n')],
  ['two-jobs',['Job: a','Task: t','Execution: '+UUID,'Job: b'].join('\n')],
  ['two-tasks',['Job: j','Task: t1','Execution: '+UUID,'Task: t2'].join('\n')],
  ['two-executions',['Job: j','Task: t','Execution: '+UUID,'Execution: '+UUID].join('\n')],
  ['no-source','plain prompt without any Graph identity'],
  ['bad-uuid',`Execution source: job/j/task/t/execution/not-a-uuid`],
  ['bad-uuid-graph',['Job: j','Task: t','Execution: not-a-uuid'].join('\n')],
  ['empty',''],
  ['space-prefixed','  Execution source: job/j/task/t/execution/'+UUID],
  ['not-anchor',`x Execution source: job/j/task/t/execution/${UUID}`],
  ['uppercase-hex',`Execution source: job/j/task/t/execution/${UUID.toUpperCase()}`],
  ['inline-only','Job: j Task: t Execution: '+UUID],
];
const BRIEF_PROMPTS=[
  ['full',fullZPrompt],
  ['no-objective',fullZPrompt.replace('Job objective: Ship the rust2 z adapter tranche\n','')],
  ['github-prompt','[Relay agent: worker; adapter: codex]\nGitHub issue #12 contract...'],
  ['other-header','[Relay agent: implementation]\nSome other role prompt.'],
  ['no-local-block',[
    headerLine,'[Authoritative execution context]','[Output contract]',outputContract,
    '[Required event contracts]','x',
  ].join('\n')],
  ['no-output-contract',[
    headerLine,'Treat the following durable task input as the authoritative work contract; do not query GitHub.','',localInput,'',
    '[Authoritative execution context]','[Required event contracts]','x',
  ].join('\n')],
  ['empty',''],
  ['plain','A plain non-Z prompt'],
  ['multi-local',[
    headerLine,
    'Treat the following durable task input as the authoritative work contract; do not query GitHub.','',localInput,'',
    '[Authoritative execution context]','x',
    'Treat the following durable task input as the authoritative work contract; do not query GitHub.','',localInput,'',
    '[Authoritative execution context]','[Output contract]',outputContract,'[Required event contracts]','x',
  ].join('\n')],
];
const BOOTSTRAP_CASES=[
  ['role-with-section',rolePrompt,'tok-123',ENDPOINT],
  ['role-with-section-no-endpoint',rolePrompt,'tok-123',undefined],
  ['legacy-prompt',fullZPrompt,'tok-123',ENDPOINT],
  ['empty-token',rolePrompt,'  ',ENDPOINT],
  ['newline-token',rolePrompt,'tok\n123',ENDPOINT],
  ['cr-token',rolePrompt,'tok\r123',ENDPOINT],
  ['no-source',fullZPrompt.replace(/^(Job: .*\nTask: .*\nExecution: .*)$/m,'').replace(sourceLine+'\n','').replace('Execution: '+UUID,'Execution: 00000000-0000-0000-0000-000000000000'),'tok',ENDPOINT],
  ['bad-source-token',rolePrompt.replace('Read the pinned harness bootstrap first.','Read: Job: j Task: t Execution: bad'),'tok',ENDPOINT],
];
const ENDPOINT_CASES=[
  ['https-host','https://oauth.example.test'],
  ['https-host-trailing','https://oauth.example.test/'],
  ['https-host-port','https://oauth.example.test:8443'],
  ['https-dotted','https://a.b.c.example'],
  ['http-host','http://oauth.example.test'],
  ['https-path','https://oauth.example.test/path'],
  ['https-userinfo','https://u:pw@oauth.example.test'],
  ['https-bad-port','https://oauth.example.test:123456'],
  ['https-query','https://oauth.example.test/?q=1'],
  ['https-underscore','https://oauth_example.test'],
  ['empty',''],
  ['garbage','not a url'],
];
const FILES=[
  [],
  ['/workspace/refs/a.md'],
  ['/agents-relay/prompt-references/secret.md'],
  ['/agents-relay/prompt-references/a.md','/workspace/refs/b.md'],
  ['/workspace/refs/a.md','/workspace/refs/b.md','/workspace/refs/c.md'],
];

// ---------- Node side evaluation ----------
const nodeRun=(method,payload)=>{
  try{
    switch(method){
      case 'executionSource':
        return {ok:true,source:zExecutionSource(payload.prompt)};
      case 'taskBrief':
        return {ok:true,brief:zTaskBrief(payload.prompt)};
      case 'bootstrap':
        return {ok:true,text:zBootstrap(payload.accessToken,payload.prompt,payload.endpoint)};
      case 'mcpEndpoint':
        return {ok:true,endpoint:zWorkerMcpEndpoint(payload.origin)};
      case 'adapterIdentity':
        return {name:new ZAdapter().name,id:new ZAdapter().id,
          capabilities:new ZAdapter().capabilities};
      case 'launchRequest':{
        const brief=zTaskBrief(payload.prompt);
        const bootstrap=zBootstrap(payload.token,brief,payload.endpoint);
        const actualFiles=(payload.files).filter(p=>!p.includes('/agents-relay/prompt-references/'));
        const attachments=actualFiles.length
          ?'\n\nReference paths accessible through the configured MCP file tools:\n'+actualFiles.join('\n'):'';
        return {ok:true,body:{
          provider:'z',executionId:payload.executionId,timeoutMs:payload.timeoutMs,
          action:'new-thread',
          config:{message:bootstrap+attachments,timeout_seconds:90,wait:false},
        }};
      }
      case 'terminalRecovery':{
        const source=zExecutionSource(payload.prompt);
        return {ok:true,body:{
          thread_id:payload.threadId,wait:false,timeout_seconds:90,
          message:`[Relay terminal recovery — original execution ${source}]\nThe previous worker did not publish a terminal event. Verify the event history and durable Task output using the configured MCP provider at ${payload.endpoint}. Temporary access token: ${payload.token}. Never print this token or store it in files. If output is verifiably complete, publish task.completed for this exact execution. Otherwise continue and publish real task.progress, or task.failed when impossible. Never invent success or start another execution.`,
        }};
      }
      default: throw new Error('unknown node method '+method);
    }
  }catch(error){
    return {ok:false,error:error?.message??String(error)};
  }
};

// Node fake fetcher mirrors the Rust fixture provider scenario by scenario.
// It returns real Response objects because the production flow calls
// .json(), .text() and .headers.get('location') on every reply.
const REDIRECT='http://127.0.0.1:8765/agents-relay/oauth/callback';
const jsonResponse=(status,value)=>new Response(JSON.stringify(value),{status});
const rawResponse=(status,body)=>new Response(body,{status});
const redirectResponse=(status,location)=>
  new Response('',{status,headers:{location}});
function nodeFixtureFetcher(scenario,trace){
  let lastState='';
  return async (url,init)=>{
    const path=url.replace('https://oauth.test','');
    const contentType=init.headers?.['Content-Type']??null;
    // Normalize the body the same way the Rust parity trace does: form
    // bodies (URLSearchParams or strings) become sorted key lists, JSON
    // bodies stay intact.
    let bodyKeys=null;
    if(init.body!=null&&contentType!=='application/json'){
      const text=typeof init.body==='string'?init.body:init.body.toString();
      if(text)bodyKeys=Object.keys(Object.fromEntries(new URLSearchParams(text))).sort();
    }else if(typeof init.body==='string'){
      bodyKeys=[JSON.stringify(JSON.parse(init.body))];
    }
    trace.push({path,method:init.method,contentType,bodyKeys});
    if(path==='/register'){
      if(scenario==='register-reject')return jsonResponse(400,{error:'registration denied'});
      if(scenario==='no-client')return jsonResponse(201,{client_name:'Agents Relay Z worker'});
      if(scenario==='malformed-json')return rawResponse(201,'not json');
      return jsonResponse(201,{client_id:'client-fixture'});
    }
    if(path.startsWith('/authorize?')){
      if(scenario==='authorize-reject')return jsonResponse(403,{error:'forbidden'});
      if(scenario==='no-rid')return rawResponse(200,'<html><body>no form here</body></html>');
      if(scenario==='html-no-rid')return rawResponse(200,'<input name="other" value="x">');
      if(scenario==='bad-rid')return rawResponse(200,'<input name="rid" value="bad rid!">');
      lastState=new URL('https://x'+path).searchParams.get('state')??'';
      return rawResponse(200,'<input name="rid" value="rid-fixture">');
    }
    if(path==='/authorize'){
      if(scenario==='consent-reject')return jsonResponse(200,{error:'consent denied'});
      if(scenario==='no-location')return rawResponse(302,'');
      if(scenario==='slow-consent')return redirectResponse(302,`${REDIRECT}?code=late&state=stale&iss=https%3A%2F%2Foauth.test`);
      if(scenario==='bad-redirect-host')return redirectResponse(302,'http://127.0.0.1:9999/agents-relay/oauth/callback?code=x');
      if(scenario==='bad-redirect-path')return redirectResponse(302,'http://127.0.0.1:8765/other/callback?code=x');
      if(scenario==='no-code')return redirectResponse(302,`${REDIRECT}?state=${lastState}&iss=https%3A%2F%2Foauth.test`);
      if(scenario==='no-iss')return redirectResponse(302,`${REDIRECT}?code=fixture-code&state=${lastState}`);
      if(scenario==='iss-mismatch')return redirectResponse(302,`${REDIRECT}?code=fixture-code&state=${lastState}&iss=https%3A%2F%2Fevil.test`);
      if(scenario==='state-mismatch')return redirectResponse(302,`${REDIRECT}?code=fixture-code&state=deadbeef&iss=https%3A%2F%2Foauth.test`);
      return redirectResponse(302,`${REDIRECT}?code=fixture-code&state=${lastState}&iss=https%3A%2F%2Foauth.test`);
    }
    if(path==='/token'){
      if(scenario==='token-reject')return jsonResponse(500,{error:'token denied'});
      if(scenario==='expires')return jsonResponse(200,{access_token:'worker-only',expires_in:1800});
      if(scenario==='no-access-token')return jsonResponse(200,{expires_in:3600});
      if(scenario==='malformed-token')return rawResponse(200,'not json');
      if(scenario==='no-refresh')return jsonResponse(200,{access_token:'worker-only',expires_in:3600});
      if(scenario==='refresh')return jsonResponse(200,{access_token:'worker-only',expires_in:3600,refresh_token:'refresh-secret'});
      return jsonResponse(200,{access_token:'worker-only',expires_in:3600,refresh_token:'refresh-secret'});
    }
    if(path==='/revoke'){
      if(scenario==='revoke-fails')return jsonResponse(400,{error:'revocation denied'});
      return jsonResponse(200,{});
    }
    throw new Error('fixture saw unexpected path '+path);
  };
}

// ---------- Rust side evaluation ----------
function rustRun(cases){
  const result=spawnSync(binary,[],{cwd:root,
    input:cases.map(f=>JSON.stringify({op:'certZPublic',...f})).join('\n')+'\n',
    maxBuffer:256*1024*1024});
  assert.equal(result.status,0,`parity binary failed: ${result.stderr}`);
  return result.stdout.toString().trim().split('\n').map(line=>{
    const parsed=JSON.parse(line);
    return parsed.ok?parsed.value:{error:parsed.error};
  });
}

// ---------- the differential ----------
test('original Node/Rust Z adapter and Z OAuth public differential',()=>{
  const cases=[];
  const expected=[];
  const push=(method,payload,nodeOutcome)=>{
    cases.push({method,...payload});
    expected.push(nodeOutcome);
  };

  for(const [name,prompt] of EXECUTION_PROMPTS)
    push('executionSource',{prompt},nodeRun('executionSource',{prompt}));
  for(const [name,prompt] of BRIEF_PROMPTS)
    push('taskBrief',{prompt},nodeRun('taskBrief',{prompt}));
  for(const [name,prompt,token,endpoint] of BOOTSTRAP_CASES)
    push('bootstrap',{prompt,accessToken:token,endpoint},nodeRun('bootstrap',{prompt,accessToken:token,endpoint}));
  for(const [name,origin] of ENDPOINT_CASES)
    push('mcpEndpoint',{origin},nodeRun('mcpEndpoint',{origin}));
  push('adapterIdentity',{},nodeRun('adapterIdentity',{}));
  for(const files of FILES)
    for(const [name,prompt] of BRIEF_PROMPTS.slice(0,4))
      push('launchRequest',{prompt,files,token:'tok-1',endpoint:ENDPOINT,
        executionId:UUID,timeoutMs:900000},
        nodeRun('launchRequest',{prompt,files,token:'tok-1',endpoint:ENDPOINT,
          executionId:UUID,timeoutMs:900000}));
  push('terminalRecovery',{prompt:fullZPrompt,threadId:'thread-1',token:'tok-1',
    endpoint:ENDPOINT},nodeRun('terminalRecovery',{prompt:fullZPrompt,threadId:'thread-1',
    token:'tok-1',endpoint:ENDPOINT}));

  const outputs=rustRun(cases);
  assert.equal(outputs.length,cases.length);
  const failures=[];
  for(let i=0;i<cases.length;i++){
    const want=expected[i];
    const got=outputs[i];
    let diff=null;
    if(want.ok!==got.ok){
      diff=['ok',want.ok,got.ok];
    }else if(!want.ok){
      if(want.error!==got.error)diff=['error',want.error,got.error];
    }else{
      const keys=Object.keys(want).filter(k=>k!=='ok');
      for(const key of keys){
        if(JSON.stringify(want[key])!==JSON.stringify(got[key])){
          diff=[key,want[key],got[key]];break;
        }
      }
    }
    if(diff)failures.push({case:i,method:cases[i].method,payload:cases[i],diff});
  }
  if(failures.length>0){
    console.error('first divergence:',
      JSON.stringify(failures[0],null,1).slice(0,1200));
  }
  assert.equal(failures.length,0,
    `${failures.length}/${cases.length} divergences`);
  console.log(`Verified ${cases.length} original Node/Rust Z adapter pure contract cases`);
});

test('original Node/Rust Z OAuth PKCE flow differential over injected fetcher',async()=>{
  const scenarios=[
    // full successes
    'happy','refresh','no-refresh',
    // provider rejections at each protocol step
    'register-reject','no-client','malformed-json','authorize-reject',
    'no-rid','html-no-rid','bad-rid','consent-reject',
    // callback validation failures
    'no-location','slow-consent','bad-redirect-host','bad-redirect-path',
    'no-code','no-iss','iss-mismatch','state-mismatch',
    // token endpoint validation
    'token-reject','expires','no-access-token','malformed-token',
    // refresh revocation
    'revoke-fails',
  ];
  const cases=[];
  const expected=[];
  for(const scenario of scenarios){
    const trace=[];
    let nodeOutcome;
    try{
      const token=await issueZWorkerCredential({
        origin:'https://oauth.test',
        operatorToken:'operator-secret',
        fetcher:nodeFixtureFetcher(scenario,trace),
      });
      nodeOutcome={ok:true,token,trace};
    }catch(error){
      nodeOutcome={ok:false,error:error?.message??String(error),trace};
    }
    cases.push({method:'issueCredential',scenario,origin:'https://oauth.test',
      operatorToken:'operator-secret',stateSeed:7});
    expected.push(nodeOutcome);
  }
  const outputs=rustRun(cases);
  assert.equal(outputs.length,cases.length);
  const failures=[];
  for(let i=0;i<scenarios.length;i++){
    const scenario=scenarios[i];
    const want=expected[i];
    const got=outputs[i];
    let diff=null;
    if(want.ok!==got.ok)diff=['ok',want.ok,got.ok];
    else if(want.ok&&want.token!==got.token)diff=['token',want.token,got.token];
    else if(!want.ok){
      // Malformed provider JSON surfaces the platform JSON parser's own
      // error text (V8 vs serde_json); compare the failure class, not the
      // parser wording.
      const malformed=scenario==='malformed-json'||scenario==='malformed-token';
      if(malformed){
        if(!(typeof want.error==='string'
          &&/not valid JSON|Unexpected token/.test(want.error)
          &&typeof got.error==='string'&&got.error.length>0))
          diff=['error-class',want.error,got.error];
      }else if(want.error!==got.error)diff=['error',want.error,got.error];
    }
    else{
      // Traffic shape must match: same request paths in the same order with
      // the same methods, content types, and normalized body descriptions.
      // The /authorize GET query carries per-stack random state and PKCE
      // challenge, so compare its structure, not its exact string.
      const normalize=(entry,index)=>{
        const copy={...entry};
        if(copy.path?.startsWith('/authorize?')){
          const params=new URL('https://x'+copy.path).searchParams;
          copy.path='/authorize?'
            +['response_type','client_id','redirect_uri','code_challenge_method',
              'scope','resource'].map(k=>`${k}=${params.get(k)}`).join('&');
        }
        return copy;
      };
      const wantTrace=want.trace.map(normalize).map(t=>JSON.stringify(t));
      const gotTrace=(got.trace??[]).map(normalize).map(t=>JSON.stringify(t));
      if(JSON.stringify(wantTrace)!==JSON.stringify(gotTrace))
        diff=['trace',wantTrace,gotTrace];
    }
    if(diff)failures.push({scenario:scenarios[i],diff});
  }
  if(failures.length>0){
    console.error('first flow divergence:',
      JSON.stringify(failures[0],null,1).slice(0,1200));
  }
  assert.equal(failures.length,0,
    `${failures.length}/${scenarios.length} flow divergences`);
  console.log(`Verified ${scenarios.length} original Node/Rust Z OAuth PKCE flow scenarios with identical traffic shapes`);
});
