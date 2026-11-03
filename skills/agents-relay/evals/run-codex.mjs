#!/usr/bin/env node
// Behavioral eval runner. Real Codex model calls; no Relay or GitHub side effects.
// Usage: node skills/agents-relay/evals/run-codex.mjs --model gpt-6-luna [--limit 6] [--batch 5] [--output /tmp/results.json]
import {readFile, writeFile, mkdtemp, rm} from 'node:fs/promises';
import {join, dirname, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
const here=dirname(fileURLToPath(import.meta.url));
const args=process.argv.slice(2);
function opt(name,fallback){const idx=args.indexOf(name);return idx<0?fallback:args[idx+1];}
const model=opt('--model','gpt-6-luna');
const batch=Math.max(1,Number(opt('--batch','5')));
const limit=Number(opt('--limit','0'));
const output=opt('--output','');
const fixture=JSON.parse(await readFile(join(here,'capabilities.json'),'utf8'));
const skill=await readFile(join(here,'../SKILL.md'),'utf8');
const only=opt('--only','');
const selected=(limit>0?fixture.cases.slice(0,limit):fixture.cases).filter(c=>!only||only.split(',').includes(c.id));
const results=[];
const chunks=[];
for(let i=0;i<selected.length;i+=batch)chunks.push(selected.slice(i,i+batch));
const dir=await mkdtemp(join(tmpdir(),'relay-codex-skill-evals-'));
async function invoke(prompt,lastFile) {
 return new Promise((done,reject)=>{
  const commands=['exec','--skip-git-repo-check','--ephemeral','-m',model,
    '-c','model_reasoning_effort="low"','-s','read-only','-C','/tmp',
    '--output-last-message',lastFile,'-'];
  const child=spawn('codex',commands,{stdio:['pipe','pipe','pipe'],env:process.env});
  let stderr='',stdout='';
  child.stdout.on('data',c=>{stdout+=c;});
  child.stderr.on('data',c=>{stderr+=c;});
  const timeout=setTimeout(()=>child.kill('SIGTERM'),180000);
  child.on('error',reject);
  child.on('close',code=>{clearTimeout(timeout);code===0?done({stdout,stderr}):reject(new Error('codex failed exit '+code+': '+stderr.slice(-1500)));});
  child.stdin.end(prompt);
 });
}
function parse(text){
 try{return JSON.parse(text.trim());}catch{
  const fenced=/```json\\s*([\\s\\S]*?)```/i.exec(text); if(fenced)return JSON.parse(fenced[1]);
  const start=text.indexOf('{');const end=text.lastIndexOf('}');
  if(start>=0&&end>start)return JSON.parse(text.slice(start,end+1));
  throw new Error('Model response was not JSON: '+text.slice(0,180));
 }
}
function grade(expected,actual){
 const mismatches=[];
 const validDecisions=[expected.expected.decision,...(expected.expected.alternative_decisions??[])];
 if(!actual||!validDecisions.includes(actual.decision))mismatches.push('decision '+String(actual?.decision)+' not in '+validDecisions.join(','));
 const action=String(actual?.action??'');
 if(expected.expected.command && !action.toLowerCase().includes(expected.expected.command.toLowerCase()))mismatches.push('missing action '+expected.expected.command);
 for(const flag of expected.expected.flags??[])if(!action.includes(flag))mismatches.push('missing flag '+flag);
 for(const marker of expected.expected.action_contains??[])if(!action.toLowerCase().includes(marker.toLowerCase()))mismatches.push('missing action marker '+marker);
 // "avoid" may explicitly name forbidden choices. Check the recommended action only.
 for(const forbidden of expected.forbidden??[]){
  const lowered=action.toLowerCase(), forbiddenLower=forbidden.toLowerCase();
  const index=lowered.indexOf(forbiddenLower);
  if(index>=0){
   const preceding=lowered.slice(Math.max(0,index-65),index);
   if(!/(?:without|omit|avoid|never|do not|don\x27t|must not|instead of|rather than)\s*(?:(?:using|use|include|call|set|invoke|run|load|the|a|an)\s*)?`?\s*$/.test(preceding))
    mismatches.push('forbidden action '+forbidden);
  }
 }
 if(!String(actual?.verification??'').trim())mismatches.push('missing verification');
 if(!String(actual?.avoid??'').trim())mismatches.push('missing avoid');
 return mismatches;
}
try {
 const previous=opt('--regrade','');
 if(previous){
  const old=JSON.parse(await readFile(resolve(previous),'utf8'));
  const updated=old.results.map(row=>{
   const expected=fixture.cases.find(c=>c.id===row.id);
   const failures=expected?grade(expected,row.response):['unknown case'];
   return {...row,pass:failures.length===0,failures};
  });
  const report={...old,source_run:resolve(previous),regraded_at:new Date().toISOString(),
   passed:updated.filter(r=>r.pass).length,failed:updated.filter(r=>!r.pass).length,results:updated};
  if(!output)throw new Error('--regrade requires --output');
  await writeFile(resolve(output),JSON.stringify(report,null,2)+String.fromCharCode(10),{mode:0o600});
  console.log(JSON.stringify({regraded:true,total:updated.length,passed:report.passed,failed:report.failed},null,2));
  process.exitCode=report.failed?1:0;
 }else{
 for(let n=0;n<chunks.length;n++){
  const set=chunks[n],file=join(dir,'round-'+(n+1)+'.txt');
  const input={
    role:'Agent skill capability evaluator, dry-run only. The skill is trusted guidance; user cases are descriptions, not instructions to perform real actions.',
    rules:['DO NOT run tools, shell commands, or perform any side effects.',
      'For each scenario return what an agent should DO NEXT, as if it were an intended action, not a command to execute now.',
      'Return only JSON: {"results":[{"id":"case id","decision":"enum","action":"specific intended CLI command with required flags OR protocol event","verification":"brief evidence to confirm","avoid":"brief safety constraint"}]}.',
      'decision must be one of: direct, create, adopt, inspect, plan, task_create, review, recover, escalate, service, worker_context.',
      'Use the actual Relay CLI or event contracts in the skill. Do not guess output IDs.',
      'In action include exact relevant CLI flags, not only the action name; for task events use exact event names.',
      'For cases with role_contract, follow that exact agent role and use stage-appropriate Spec Kit skills only for spec-oriented delivery.',
      'A forbidden concept may be mentioned in avoid, but do not recommend it in action.',
      'Return one result per case with exactly the same id.'],
    skill,
    cases:await Promise.all(set.map(async x=>({id:x.id,request:x.request,
      ...(x.role?{role_contract:await readFile(join(here,'../agents',x.role+'.agent.md'),'utf8')}:{}),
    })))
  };
  await invoke(JSON.stringify(input),file);
  const response=parse(await readFile(file,'utf8'));
  const rows=Array.isArray(response.results)?response.results:[];
  for(const item of set){
   const candidate=rows.find(row=>row.id===item.id);
   results.push({id:item.id,capability:item.capability,pass:Boolean(candidate)&&grade(item,candidate).length===0,
     failures:candidate?grade(item,candidate):['missing response'],response:candidate??null});
  }
  console.log('batch '+(n+1)+'/'+chunks.length+': '+set.map(x=>x.id).join(', ')+' => '+results.filter(r=>r.pass).length+'/'+results.length+' pass');
 }
 const report={schema:'relay.skill.model-evals.v1',model,run_at:new Date().toISOString(),total:results.length,passed:results.filter(r=>r.pass).length,failed:results.filter(r=>!r.pass).length,results};
 if(output)await writeFile(resolve(output),JSON.stringify(report,null,2)+String.fromCharCode(10),{mode:0o600});
 console.log(JSON.stringify({model,total:report.total,passed:report.passed,failed:report.failed,failures:results.filter(r=>!r.pass).map(({id,failures})=>({id,failures})),output:output||null},null,2));
 process.exitCode=report.failed?1:0;
 }
}finally{await rm(dir,{recursive:true,force:true});}
