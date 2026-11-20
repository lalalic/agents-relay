// Direct original Node src/usage.ts parsing/observation layers vs Rust:
// CodexSessionUsageReader telemetry scan over real fixture .jsonl files,
// BrowserWorkspaceUsageReader capacity decoding through a local probe
// executable, Z.ai / DeepSeek / OpenRouter 2xx payload decoding via an
// injected fetch, and the app-server response projection through a fake
// JSON-RPC process. No network, no real provider tokens.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,rmSync,utimesSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {
  CodexSessionUsageReader,
  BrowserWorkspaceUsageReader,
  ZaiUsageReader,
  DeepSeekCreditReader,
  OpenRouterCreditReader,
  CodexApiUsageReader,
} from '../../dist/usage.js';

const root=resolve(import.meta.dirname,'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');
const scratch=mkdtempSync(join(tmpdir(),'rust2-usage-public-'));
test.after(()=>rmSync(scratch,{force:true,recursive:true}));
const NOW=Date.parse('2026-11-18T09:00:00.000Z');
function shellQuote(text){return "'"+text.replaceAll("'","'\\''")+"'";}

// ---------- CodexSessionUsageReader over real files ----------
function tokenCountLine(timestamp,primary,secondary){
 const rate_limits=secondary===undefined?{primary}:{primary,secondary};
 return JSON.stringify({type:'event_msg',timestamp,
  payload:{type:'token_count',rate_limits}});
}
const freshBoth=tokenCountLine('2026-11-18T08:30:00.000Z',
 {used_percent:30,window_minutes:300,resets_at:1795000000},
 {used_percent:60,window_minutes:10080,resets_at:1795600000});
const staleLine=tokenCountLine('2026-11-01T08:30:00.000Z',
 {used_percent:30,window_minutes:300},{used_percent:60,window_minutes:10080});
const freshPrimaryOnly=tokenCountLine('2026-11-18T08:45:00.000Z',
 {used_percent:30,window_minutes:300},undefined);
const freshSecondaryOnly=tokenCountLine('2026-11-18T08:50:00.000Z',
 undefined,{used_percent:60,window_minutes:10080});

function writeTelemetry(dir,name,lines,mtimeMs){
 mkdirSync(dir,{recursive:true});
 const file=join(dir,name);
 writeFileSync(file,lines.join('\n')+(lines.length?'\n':''));
 utimesSync(file,new Date(mtimeMs),new Date(mtimeMs));
 return file;
}
function homeWith(setup){
 const home=join(scratch,'home-'+Math.random().toString(36).slice(2,8));
 setup(home);
 return home;
}
const sessionCases=[
 // fresh telemetry with both windows
 {name:'fresh-both',home:homeWith(h=>writeTelemetry(join(h,'sessions'),'s.jsonl',[freshBoth],NOW-3_600_000))},
 // fresh but missing weekly window
 {name:'no-weekly',home:homeWith(h=>writeTelemetry(join(h,'sessions'),'s.jsonl',[freshPrimaryOnly],NOW-3_600_000))},
 // fresh but missing five-hour window
 {name:'no-five-hour',home:homeWith(h=>writeTelemetry(join(h,'sessions'),'s.jsonl',[freshSecondaryOnly],NOW-3_600_000))},
 // stale latest -> unavailable with stale reason
 {name:'stale',home:homeWith(h=>writeTelemetry(join(h,'sessions'),'s.jsonl',[staleLine],NOW-3_600_000))},
 // newest-wins across files (stale first, fresh in nested dir)
 {name:'newest-wins',home:homeWith(h=>{
   writeTelemetry(join(h,'sessions'),'old.jsonl',[staleLine],NOW-7_200_000);
   writeTelemetry(join(h,'sessions','nested','deep'),'new.jsonl',[freshBoth],NOW-60_000);
  })},
 // empty home -> no telemetry reason
 {name:'empty',home:join(scratch,'empty-home')},
 // junk lines only
 {name:'junk',home:homeWith(h=>writeTelemetry(join(h,'sessions'),'s.jsonl',['hello','','{broken'],NOW-60_000))},
 // archived_sessions scanned too
 {name:'archived',home:homeWith(h=>writeTelemetry(join(h,'archived_sessions'),'a.jsonl',[freshBoth],NOW-3_600_000))},
 // file older than lookback cutoff is ignored
 {name:'too-old-file',home:homeWith(h=>writeTelemetry(join(h,'sessions'),'old.jsonl',[freshBoth],NOW-9*86_400_000))},
 // exact cutoff boundary file (mtime === cutoff kept: Node uses >=)
 {name:'cutoff-boundary',home:homeWith(h=>writeTelemetry(join(h,'sessions'),'b.jsonl',[freshBoth],NOW-8*86_400_000))},
];
async function nodeSession(home){
 const reader=new CodexSessionUsageReader(home,8,0,()=>new Date(NOW));
 return await reader.read();
}

// ---------- rateLimitsFromLine corpus via single-line homes ----------
const telemetryLines=[
 freshBoth,
 tokenCountLine('2026-11-18T07:00:00.000Z',{used_percent:101,window_minutes:300},{used_percent:80,window_minutes:10080}),
 tokenCountLine('2026-11-18T07:00:00.000Z',{used_percent:42.5,window_minutes:0}),
 tokenCountLine('bad-date',{used_percent:42.5,window_minutes:300}),
 tokenCountLine('2026-11-18T07:00:00.000Z',{used_percent:-1,window_minutes:300},{used_percent:80,window_minutes:10080,resets_at:0}),
 tokenCountLine('2026-11-18T07:00:00.000Z',{used_percent:'77',window_minutes:10080,resets_at:'x'}),
 JSON.stringify({type:'event_msg',payload:{type:'token_count'}}),
 JSON.stringify({type:'other',payload:{type:'token_count',rate_limits:{}}}),
 JSON.stringify({type:'event_msg',payload:{type:'other',rate_limits:{primary:{used_percent:1,window_minutes:300}}}}),
 'not json at all',
 '',
];
const lineHomes=telemetryLines.map((line,i)=>homeWith(h=>
 writeTelemetry(join(h,'sessions'),'s.jsonl',[line],NOW-60_000)));

// ---------- BrowserWorkspaceUsageReader through a local probe ----------
function capacityScript(index,lines,exitCode){
 const dir=join(scratch,'webhelm-'+index);mkdirSync(dir,{recursive:true});
 const script=join(dir,'webhelm');
 const body='#!/bin/sh\n'+(lines.length?
   lines.map(l=>`printf '%s\\n' ${shellQuote(l)}`).join('\n')+'\n':'')
  +'exit '+exitCode+'\n';
 writeFileSync(script,body,{mode:0o700});
 return script;
}
const freshStamp='2026-11-18T09:00:00.000Z';
const oldStamp='2026-11-18T06:00:00.000Z';
const capacityCases=[
 {lines:[JSON.stringify({name:'Harness',poolSize:5,idle:2,leased:3,available:2,observedAt:freshStamp})],exit:0},
 {lines:[JSON.stringify({name:'Harness',poolSize:5,idle:2,leased:3,available:true,observedAt:freshStamp})],exit:0},
 {lines:[JSON.stringify({name:'Harness',poolSize:5,idle:2,leased:3,available:false,observedAt:freshStamp})],exit:0},
 {lines:[JSON.stringify({name:'Harness',observedAt:freshStamp})],exit:0},
 {lines:[JSON.stringify({name:'Harness',idle:-1,leased:2,observedAt:freshStamp})],exit:0},
 {lines:[JSON.stringify({name:'Custom',idle:0,leased:0,available:0,observedAt:freshStamp})],exit:0},
 {lines:[JSON.stringify({idle:1,observedAt:freshStamp})],exit:0},
 {lines:[JSON.stringify({name:'Harness',idle:1,observedAt:oldStamp})],exit:0},
 {lines:['garbage',JSON.stringify({name:'Harness',idle:4,leased:1,available:3,observedAt:freshStamp})],exit:0},
 {lines:[JSON.stringify({name:'Skip',idle:9,observedAt:oldStamp}),JSON.stringify({name:'Late',idle:1,observedAt:freshStamp})],exit:0},
 {lines:[JSON.stringify({name:'Harness',poolSize:'5',idle:'2',observedAt:freshStamp})],exit:0},
 {lines:[JSON.stringify({name:'Harness',idle:1,observedAt:'not-a-date'})],exit:0},
 {lines:[],exit:3},
 {lines:[JSON.stringify({name:'Harness',poolSize:0,idle:0,leased:0,available:0,observedAt:freshStamp})],exit:0},
];
async function nodeCapacity(c,index){
 const script=capacityScript(index,c.lines,c.exit);
 const reader=new BrowserWorkspaceUsageReader(script,5000,()=>new Date(NOW),15*60_000);
 return await reader.read();
}

// ---------- provider payload decoding (2xx via injected fetch) ----------
const zaiPayloads=[
 {data:{limits:[
  {type:'TOKENS_LIMIT',unit:3,percentage:25,nextResetTime:1795000000000},
  {type:'CREDIT_LIMIT',unit:6,percentage:75.5,nextResetTime:1795600000000}]}},
 {data:{limits:[{type:'TOKENS_LIMIT',unit:3,percentage:25}]}},
 {data:{limits:[{type:'OTHER',unit:3,percentage:25},{type:'TOKENS_LIMIT',unit:9,percentage:25}]}},
 {data:{limits:[{type:'TOKENS_LIMIT',unit:3,percentage:101},{type:'CREDIT_LIMIT',unit:6,percentage:50}]}},
 {data:{limits:[{type:'TOKENS_LIMIT',unit:3,percentage:'25'},{type:'CREDIT_LIMIT',unit:6,percentage:50}]}},
 {data:{}},
 {},
 {data:{limits:[{type:'TOKENS_LIMIT',unit:3,percentage:25,nextResetTime:'soon'},
   {type:'CREDIT_LIMIT',unit:6,percentage:50,nextResetTime:1795600000000}]}},
];
const deepseekPayloads=[
 {is_available:true,balance_infos:[{currency:'CNY',total_balance:'110.00'},{currency:'USD',total_balance:'10'}]},
 {is_available:false,balance_infos:[{currency:'CNY',total_balance:'110.00'}]},
 {is_available:true,balance_infos:[]},
 {is_available:true,balance_infos:[{currency:'CNY',total_balance:'not-a-number'}]},
 {is_available:true,balance_infos:[{total_balance:5}]},
 {},
];
const openrouterPayloads=[
 {data:{total_credits:100,total_usage:40.5}},
 {data:{total_credits:100}},
 {data:{total_usage:10}},
 {data:{}},
 {},
 {data:{total_credits:'100',total_usage:'40.5'}},
];
async function nodeZai(payload){
 const reader=new ZaiUsageReader('fixture-key','https://fixture.invalid/usage',
  async()=>({ok:true,status:200,json:async()=>payload}),()=>new Date(NOW));
 return await reader.read();
}
async function nodeDeepseek(payload){
 const reader=new DeepSeekCreditReader('fixture-key','https://fixture.invalid/balance',
  async()=>({ok:true,status:200,json:async()=>payload}),()=>new Date(NOW));
 return await reader.read();
}
async function nodeOpenrouter(payload){
 const reader=new OpenRouterCreditReader('fixture-key','https://fixture.invalid/credits',
  async()=>({ok:true,status:200,json:async()=>payload}),()=>new Date(NOW));
 return await reader.read();
}

// ---------- app-server response projection through a fake process ----------
const appServerResponses=[
 {id:2,result:{rateLimits:{primary:{usedPercent:12.5,windowDurationMins:300,resetsAt:1795000000},
  secondary:{usedPercent:73.5,windowDurationMins:10080,resetsAt:1795600000}}}},
 {id:2,result:{rateLimits:{primary:{usedPercent:12.5,windowDurationMins:10080},
  secondary:{usedPercent:73.5,windowDurationMins:300}}}},
 {id:2,result:{rateLimits:{primary:{usedPercent:0,windowDurationMins:300}}}},
 {id:2,result:{}},
 {id:2,random:'shape'},
];
async function nodeAppServer(response){
 const dir=join(scratch,'app-server-'+appServerResponses.indexOf(response));
 mkdirSync(dir,{recursive:true});
 const script=join(dir,'codex');
 writeFileSync(script,'#!/bin/sh\n'+
  `printf '%s\\n' ${shellQuote(JSON.stringify({id:1,result:{}}))}\n`+
  `printf '%s\\n' ${shellQuote(JSON.stringify(response))}\n`,{mode:0o700});
 const reader=new CodexApiUsageReader(()=>new Date(NOW));
 const original=process.env.PATH;
 process.env.PATH=dir+':'+original;
 try{return await reader.read();}
 finally{process.env.PATH=original;}
}

function parityLines(requests){
 const run=spawnSync(binary,[],{cwd:root,encoding:'utf8',timeout:120000,
  input:requests.map(JSON.stringify).join('\n')+'\n',maxBuffer:16*1024*1024});
 assert.equal(run.status,0,run.stderr||run.error?.message);
 return run.stdout.trim().split('\n').map(JSON.parse);
}

test('usage parsing and provider observation layers match Node and Rust',async()=>{
 const mismatches=[];
 // ---- CodexSessionUsageReader (real files, both stacks)
 const sessionExpected=[];
 for(const c of sessionCases)sessionExpected.push(await nodeSession(c.home));
 let actual=parityLines(sessionCases.map(c=>({op:'usagePublicParity',
  method:'codexSessionUsage',codexHome:c.home,lookbackDays:8,now:NOW})));
 for(let i=0;i<sessionCases.length;i++){
  const rust=actual[i].value??actual[i];
  const nodeNorm={...sessionExpected[i],generatedAt:'NORMALIZED'};
  try{assert.deepEqual(rust,nodeNorm);}
  catch{mismatches.push({kind:'session',i:sessionCases[i].name,node:nodeNorm,rust});}
 }
 // ---- rateLimitsFromLine corpus (one fixture file per line)
 const lineExpected=[];
 for(const home of lineHomes)lineExpected.push(await nodeSession(home));
 actual=parityLines(lineHomes.map(home=>({op:'usagePublicParity',
  method:'codexSessionUsage',codexHome:home,lookbackDays:8,now:NOW})));
 for(let i=0;i<lineHomes.length;i++){
  const rust=actual[i].value??actual[i];
  const nodeNorm={...lineExpected[i],generatedAt:'NORMALIZED'};
  try{assert.deepEqual(rust,nodeNorm);}
  catch{mismatches.push({kind:'line',i,line:telemetryLines[i],node:nodeNorm,rust});}
 }
 // ---- BrowserWorkspaceUsageReader (local probe process, both stacks)
 const capacityExpected=[];
 for(let i=0;i<capacityCases.length;i++)capacityExpected.push(await nodeCapacity(capacityCases[i],i));
 actual=parityLines(capacityCases.map(c=>({op:'usagePublicParity',
  method:'parseBrowserWorkspaceCapacity',
  output:c.lines.join('\n')+(c.lines.length?'\n':''),
  observedAt:new Date(NOW).toISOString(),
  staleAfterMs:900000,exitCode:c.exit})));
 for(let i=0;i<capacityCases.length;i++){
  const rust=actual[i].value??actual[i];
  try{assert.deepEqual(rust,capacityExpected[i]);}
  catch{mismatches.push({kind:'capacity',i,node:capacityExpected[i],rust});}
 }
 // ---- Z.ai payload decoding
 const zaiExpected=[];
 for(const payload of zaiPayloads)zaiExpected.push(await nodeZai(payload));
 actual=parityLines(zaiPayloads.map(payload=>({op:'usagePublicParity',
  method:'zaiPayload',payload})));
 for(let i=0;i<zaiPayloads.length;i++){
  const nodeNorm={...zaiExpected[i],generatedAt:'NORMALIZED'};
  const rust=actual[i].value??actual[i];
  try{assert.deepEqual(rust,nodeNorm);}
  catch{mismatches.push({kind:'zai',i,payload:zaiPayloads[i],node:nodeNorm,rust});}
 }
 // ---- DeepSeek payload decoding
 const deepseekExpected=[];
 for(const payload of deepseekPayloads)deepseekExpected.push(await nodeDeepseek(payload));
 actual=parityLines(deepseekPayloads.map(payload=>({op:'usagePublicParity',
  method:'deepseekPayload',payload})));
 for(let i=0;i<deepseekPayloads.length;i++){
  const nodeNorm={...deepseekExpected[i],generatedAt:'NORMALIZED'};
  const rust=actual[i].value??actual[i];
  try{assert.deepEqual(rust,nodeNorm);}
  catch{mismatches.push({kind:'deepseek',i,payload:deepseekPayloads[i],node:nodeNorm,rust});}
 }
 // ---- OpenRouter payload decoding
 const openrouterExpected=[];
 for(const payload of openrouterPayloads)openrouterExpected.push(await nodeOpenrouter(payload));
 actual=parityLines(openrouterPayloads.map(payload=>({op:'usagePublicParity',
  method:'openrouterPayload',payload})));
 for(let i=0;i<openrouterPayloads.length;i++){
  const nodeNorm={...openrouterExpected[i],generatedAt:'NORMALIZED'};
  const rust=actual[i].value??actual[i];
  try{assert.deepEqual(rust,nodeNorm);}
  catch{mismatches.push({kind:'openrouter',i,payload:openrouterPayloads[i],node:nodeNorm,rust});}
 }
 // ---- app-server response projection
 const appExpected=[];
 for(const response of appServerResponses)appExpected.push(await nodeAppServer(response));
 actual=parityLines(appServerResponses.map(response=>({op:'usagePublicParity',
  method:'codexAppServerResponse',response})));
 for(let i=0;i<appServerResponses.length;i++){
  const nodeNorm={...appExpected[i],generatedAt:'NORMALIZED'};
  const rust=actual[i].value??actual[i];
  try{assert.deepEqual(rust,nodeNorm);}
  catch{mismatches.push({kind:'app-server',i,node:nodeNorm,rust});}
 }
 assert.deepEqual(mismatches.slice(0,6),[],JSON.stringify(mismatches,null,2).slice(0,5000));
 console.log(`Verified ${sessionCases.length} session + ${telemetryLines.length} line + ${capacityCases.length} capacity + ${zaiPayloads.length} zai + ${deepseekPayloads.length} deepseek + ${openrouterPayloads.length} openrouter + ${appServerResponses.length} app-server Node/Rust usage scenarios`);
});
