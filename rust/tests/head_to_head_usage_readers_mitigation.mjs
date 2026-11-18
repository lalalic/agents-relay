// Node src/usage.ts public reader facades against Rust real implementations.
// Only local synthetic Codex telemetry, fake WebHelm command and missing keys.
// This never runs Codex CLI or calls a provider/account endpoint.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,utimesSync,chmodSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {BrowserWorkspaceUsageReader,CodexSessionUsageReader,
  ZaiUsageReader,DeepSeekCreditReader,OpenRouterCreditReader} from '../../dist/usage.js';
const root=resolve(import.meta.dirname,'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');
const tmp=mkdtempSync(join(tmpdir(),'rust2-unmatched-usage-'));
test.after(()=>rmSync(tmp,{force:true,recursive:true}));
const nowMs=Date.now();
function session(name,minutesAgo,kind){
 const home=join(tmp,name);const dir=join(home,'sessions','2026','11');mkdirSync(dir,{recursive:true});
 const time=new Date(nowMs-minutesAgo*60_000).toISOString();
 const record={timestamp:time,type:'event_msg',payload:{type:'token_count',rate_limits:{
   primary:{used_percent:25.5,window_minutes:300,resets_at:Math.trunc(nowMs/1000)+3600},
   secondary:{used_percent:91,window_minutes:10080,resets_at:Math.trunc(nowMs/1000)+86400}
 }}};
 const file=join(dir,'events.jsonl');
 writeFileSync(file,kind==='invalid'?'bad\n':JSON.stringify(record)+'\n');
 utimesSync(file,new Date(nowMs),new Date(nowMs));
 return home;
}
const fresh=session('fresh',1,'valid');
const stale=session('stale',25,'valid');
const invalid=session('invalid',1,'invalid');
const absent=join(tmp,'no-session-files');
const script=join(tmp,'webhelm-fixture');
writeFileSync(script,'#!/bin/sh\nprintf \'%s\\n\' \'{"name":"Harness","poolSize":4,"idle":2,"leased":2,"available":1}\'\n');
chmodSync(script,0o755);
const requests=[
 ...[fresh,stale,invalid,absent].map(home=>({op:'usageReaderSurface',kind:'codex-session',home,nowMs,count:2})),
 {op:'usageReaderSurface',kind:'browser',command:script,count:1},
 {op:'usageReaderSurface',kind:'browser',command:join(tmp,'missing-binary'),count:1},
 ...['zai','deepseek','openrouter'].map(kind=>({op:'usageReaderSurface',kind,count:2})),
];
function normalize(value){
 const clone=structuredClone(value);
 for(const key of ['generatedAt','observedAt'])if(key in clone)clone[key]='NORMALIZED';
 return clone;
}
async function original(f){
 let reader;
 switch(f.kind){
 case 'codex-session':reader=new CodexSessionUsageReader(f.home,8,10_000,()=>new Date(f.nowMs));break;
 case 'browser':reader=new BrowserWorkspaceUsageReader(f.command,3_000);break;
 case 'zai':reader=new ZaiUsageReader('');break;
 case 'deepseek':reader=new DeepSeekCreditReader('');break;
 case 'openrouter':reader=new OpenRouterCreditReader('');break;
 default:throw Error('unknown fixture');
 }
 const result=[];
 for(let i=0;i<f.count;i++)result.push(normalize(await reader.read()));
 return result;
}
test('native UsageReader facades match original Node for offline telemetry and absent provider keys',async()=>{
 const expected=[];for(const fixture of requests)expected.push(await original(fixture));
 const run=spawnSync(binary,[],{cwd:root,encoding:'utf8',timeout:120000,
  input:requests.map(JSON.stringify).join('\n')+'\n',maxBuffer:4*1024*1024});
 assert.equal(run.status,0,run.stderr||run.error?.message);
 const output=run.stdout.trim().split('\n').map(JSON.parse);
 assert.equal(output.length,requests.length);
 const mismatch=[];
 for(let i=0;i<requests.length;i++){
  try{assert.deepEqual(output[i],{ok:true,value:expected[i]});}
  catch{mismatch.push({case:requests[i],node:expected[i],rust:output[i]});}
 }
 assert.deepEqual(mismatch,[]);
 console.log('Verified '+requests.length+' isolated Node/Rust native reader scenarios, no provider access');
});
