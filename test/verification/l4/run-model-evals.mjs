#!/usr/bin/env node
// Actual generated-prompt dry-run behavior evals (not a provider terminal E2E).
// 1. RELAY_L4_OUTPUT_DIR=/tmp/relay-l4-generated npm run test:verification:l4:contracts
// 2. node test/verification/l4/run-model-evals.mjs --prompt-dir /tmp/relay-l4-generated --model gpt-6-luna
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
const a=process.argv.slice(2);
function opt(k,d){const i=a.indexOf(k);return i<0?d:a[i+1];}
const model=opt('--model','gpt-6-luna');
const promptDir=opt('--prompt-dir',process.env.RELAY_L4_OUTPUT_DIR||'');
const output=opt('--output','');
const previous=opt('--regrade','');
if(!promptDir&&!previous)throw new Error('Generate actual L4 prompts first and pass --prompt-dir');
const fixture=JSON.parse(await readFile(new URL('./model-cases.json',import.meta.url),'utf8'));
const only=opt('--only','');
const cases=fixture.cases.filter(c=>!only||only.split(',').includes(c.id));
const skill=await readFile(new URL('../../../skills/agents-relay/SKILL.md',import.meta.url),'utf8').catch(()=>null);
const rows=[];const dir=await mkdtemp(join(tmpdir(),'relay-l4-model-'));
async function execCodex(input,path){
 return new Promise((resolveResult,reject)=>{
  const proc=spawn('codex',['exec','--skip-git-repo-check','--ephemeral','-m',model,'-c','model_reasoning_effort="low"','-s','read-only','-C','/tmp','-o',path,'-'],
   {stdio:['pipe','pipe','pipe']});
  let err='';
  proc.stderr.on('data',b=>{err+=b;});
  proc.stdout.resume();
  const timeout=setTimeout(()=>proc.kill('SIGTERM'),180000);
  proc.on('error',reject);
  proc.on('close',code=>{clearTimeout(timeout);code===0?resolveResult():reject(new Error('codex exit '+code+' '+err.slice(-1000)));});
  proc.stdin.end(JSON.stringify(input));
 });
}
function parse(s){try{return JSON.parse(s.trim());}catch{return JSON.parse(s.slice(s.indexOf('{'),s.lastIndexOf('}')+1));}}
const forbiddenNegation=/\b(?:not|never|avoid|without|do not|don't|must not|instead of)\b/i;
function gradeCase(c,answer) {
 const action=String(answer?.action||'');
 const evidence=[action,String(answer?.verification||'')].join(' ');
 const fail=[];
 if(answer?.decision!==c.decision)fail.push('decision expected '+c.decision+', received '+answer?.decision);
 for(const s of c.must){
  const variants=s.split('|');
  if(!variants.some(part=>evidence.toLowerCase().includes(part.toLowerCase())))fail.push('missing behavior marker '+s);
 }
 for(const s of c.forbidden){
  const pos=action.toLowerCase().indexOf(s.toLowerCase());
  if(pos>=0&&!forbiddenNegation.test(action.slice(Math.max(0,pos-50),pos)))fail.push('forbidden action marker '+s);
 }
 if(!String(answer?.verification||'').trim())fail.push('missing evidence checks');
 return fail;
}
try{
 if(previous){
  if(!output)throw new Error('--regrade requires --output');
  const old=JSON.parse(await readFile(resolve(previous),'utf8'));
  const updated=old.rows.map(r=>{
    const c=fixture.cases.find(x=>x.id===r.id);
    const failures=c?gradeCase(c,r.answer):['unknown case'];
    return {...r,pass:!failures.length,failures};
  });
  const report={...old,source_run:resolve(previous),regraded_at:new Date().toISOString(),
   passed:updated.filter(x=>x.pass).length,failed:updated.filter(x=>!x.pass).length,rows:updated};
  await writeFile(resolve(output),JSON.stringify(report,null,2)+String.fromCharCode(10),{mode:0o600});
  console.log(JSON.stringify({regraded:true,total:updated.length,passed:report.passed,failed:report.failed}));
  process.exitCode=report.failed?1:0;
 }else{
 for(let i=0;i<cases.length;i++){
  const c=cases[i];
  const prompt=await readFile(join(promptDir,c.prompt+'.txt'),'utf8');
  const match=prompt.match(/^You are [^\n]+ at (\/[^\s]+\.md) \(sha256:[a-f0-9]{64}\)\./m);
  if(!match)throw new Error('Missing immutable agent path: '+c.prompt);
  const agent=await readFile(match[1],'utf8');
  const input={
   purpose:'READ-ONLY EVALUATION of a real generated Relay Builder Prompt. DO NOT actually run tools, publish events, create files, or claim any lifecycle result. State intended next action ONLY.',
   actual_graph_action_prompt:prompt,
   pinned_agent_contract:agent,
   pinned_skill:skill,
   scenario:c.scenario,
   response_format:{decision:'one of: plan_apply | fail_closed | load_context | start_event | changes_required | diagnose | inspect_project | verify_media',action:'brief intended next action and protocol/CLI events',verification:'what must be verified before final state',avoid:'unsafe choices to avoid'},
   rules:['Output ONLY a JSON object with decision, action, verification, avoid.',
    'Follow actual roles and event ownership. For simulated missing evidence, fail closed.',
    'Do not actually perform actions or claim Task completed.',
    'Describe the required protocol and intended actions in dry-run wording, even though actions must NOT actually be performed.']
  };
  const outfile=join(dir,'case-'+i+'.txt');
  await execCodex(input,outfile);
  const answer=parse(await readFile(outfile,'utf8'));
  const fail=gradeCase(c,answer);
  rows.push({id:c.id,role_adapter:c.prompt,pass:!fail.length,failures:fail,answer});
  console.log('['+(i+1)+'/'+cases.length+'] '+c.id+' '+(fail.length?'FAIL '+fail.join('; '):'PASS'));
 }
 const report={schema:'relay.l4.model-evals.v1',model,run_at:new Date().toISOString(),total:rows.length,passed:rows.filter(r=>r.pass).length,failed:rows.filter(r=>!r.pass).length,rows};
 if(output)await writeFile(resolve(output),JSON.stringify(report,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({model,total:report.total,passed:report.passed,failed:report.failed},null,2));
 process.exitCode=report.failed?1:0;
 }
}finally{await rm(dir,{recursive:true,force:true});}
