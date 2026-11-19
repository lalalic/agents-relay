// Remaining 3 public Model Router APIs (routeModel is separately directly
// compared in head_to_head_route_facades.mjs). No live Codex/provider invoked.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import * as original from '../../dist/model-routing.js';
const root=resolve(import.meta.dirname,'../..');const bin=resolve(root,'rust/target/debug/relay-rust2-parity');
const home=mkdtempSync(join(tmpdir(),'rust2-model-routing-public-'));
test.after(()=>rmSync(home,{recursive:true,force:true}));
const work=[{workerId:'codex',adapter:'codex',runtime:'codex',capabilities:['model']},{workerId:'chatgpt',adapter:'chatgpt',runtime:'chatgpt',capabilities:['model']},{workerId:'z',adapter:'z',runtime:'z',capabilities:['model']}];
const cases=[];
for(const candidate of [{id:'primary'},{id:'default:openai/gpt-5.6',reasoning:'high'}, {id:'model/abc',reasoning:'low'},{id:'model',reasoning:''}])cases.push({op:'certModelPublic',action:'choice',candidate});
const configurations=['','model = "gpt-6"\nmodel_reasoning_effort = "high"','model = "qwen"\nmodel_provider = "third-party"\n[section]\nmodel="ignore"','model = "gpt-6"\n# comment\n[profile]\nmodel = "wrong"','bad configuration'];
for(let i=0;i<configurations.length;i++){
 const config=configurations[i];writeFileSync(join(home,'config.toml'),config);
 // Each case stores its config in a separate subdir to avoid later mutation.
 const separate=join(home,'case-'+i);const {mkdirSync}=await import('node:fs');mkdirSync(separate,{recursive:true});
 writeFileSync(join(separate,'config.toml'),config);
 for(const worker of work){cases.push({op:'certModelPublic',action:'configured',home:separate});
 cases.push({op:'certModelPublic',action:'discover',home:separate,worker,registered:[],nowMs:1795000000000});}
}
// Isolated catalog and ordered profile fixture with no credentials.
const catalogHome=join(home,'catalog');const {mkdirSync}=await import('node:fs');mkdirSync(catalogHome,{recursive:true});
writeFileSync(join(catalogHome,'config.toml'),'model = "gpt-a"\nmodel_reasoning_effort = "medium"\n');
writeFileSync(join(catalogHome,'models_cache.json'),JSON.stringify({models:[{slug:'gpt-a',visibility:'list',priority:3,supported_reasoning_levels:[{effort:'medium'},{effort:'high'}]},{slug:'gpt-b',visibility:'list',priority:1,default_reasoning_level:'low'},{slug:'hidden',visibility:'hide'}]}));
writeFileSync(join(catalogHome,'alt.config.toml'),'model = "gpt-c"\nmodel_provider = "custom"\n');
cases.push({op:'certModelPublic',action:'discover',home:catalogHome,worker:work[0],registered:[],nowMs:1795000000000});
cases.push({op:'certModelPublic',action:'discover',home:catalogHome,worker:work[0],registered:[{id:'codex',runtime:{provider:'z',model:'GLM-test'}}],nowMs:1795000000000});
async function node(q){try{
 let value;
 if(q.action==='choice')value=original.modelChoiceId(q.candidate);
 else if(q.action==='configured')value=await original.configuredCodexDefault(q.home);
 else value=await original.discoverModelCandidates(q.worker,q.registered,undefined,q.home);
 return {ok:true,value:JSON.parse(JSON.stringify(value))};
 }catch(error){return {ok:false,error:error.message}}}
test('36 exact Node/Rust model choice, Codex config and model catalog discovery cases',async()=>{
 const expected=await Promise.all(cases.map(node));
 const p=spawnSync(bin,[],{cwd:root,input:cases.map(JSON.stringify).join('\n')+'\n',encoding:'utf8',timeout:60000});
 assert.equal(p.status,0,p.stderr);const actual=p.stdout.trim().split('\n').map(JSON.parse);assert.equal(actual.length,cases.length);
 for(let i=0;i<cases.length;i++)assert.deepEqual(actual[i],expected[i],`Node/Rust model fixture ${i}: ${JSON.stringify({node:expected[i],rust:actual[i]})}`);
 console.log(`PASS ${cases.length} original Node/Rust model public API fixtures`);
});
