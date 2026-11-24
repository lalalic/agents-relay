#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {basename} from 'node:path';
const skill="agents-relay";
const definitions=[["daemon", "agents-relayd", ["--live-store-dir", "__HOME__/.agents-relay/stores", "--port", "8787", "--concurrency", "4", "--interval", "300000"]]];
const home=process.env.HOME||'';
const expand=s=>s.replaceAll('__HOME__',home);
const action=process.argv[2]||'status';
if(!['setup','status','doctor'].includes(action)){console.error('usage: node skills/'+skill+'/bin/services.mjs setup|status|doctor');process.exit(2)}
const run=(cmd,args)=>{const p=spawnSync(cmd,args,{encoding:'utf8'});if(p.error)throw p.error;if(p.status!==0)throw new Error(cmd+' failed: '+String(p.stderr||p.stdout).slice(0,300));return p.stdout};
// PM2 keeps its original argv across source-file edits and ordinary restarts.
// Report drift rather than claiming an outdated live service matches this Skill.
const configured=(binary,args,live)=>{
  const env=live?.pm2_env;
  if(!env)return false;
  const expected=args.map(expand);
  const actual=Array.isArray(env.args)?env.args.map(String):[];
  const launch=String(env.pm_exec_path||'');
  const binaryName=basename(launch);
  const binaryMatches=binaryName===binary||(binary==='agents-relayd'&&binaryName==='agents-relayd-rust');
  // Operators may configure additional NATS/WebHelm options after the core
  // startup arguments. Do not declare drift solely for those native options.
  return binaryMatches&&JSON.stringify(actual.slice(0,expected.length))===JSON.stringify(expected);
};
try {
 const pm2=JSON.parse(run('pm2',['jlist']));
 const report=[];
 for(const [service,binary,args] of definitions){
   const id=skill+'/'+service;
   const current=pm2.find(x=>x.name===id);
   if(action==='setup'&&!current){
      if(skill==='family-tutor')throw new Error('family-tutor/orchestrator missing: provision product runtime before setup; serviceman must not infer its working directory');
      const result=spawnSync('serviceman',['define','--skill',skill,'--service',service,'--apply','--',binary,...args.map(expand)],{stdio:'inherit'});
      if(result.error)throw result.error;
      if(result.status!==0)throw new Error('failed to define '+id);
   }
   const live=action==='setup'?JSON.parse(run('pm2',['jlist'])).find(x=>x.name===id):current;
   report.push({service:id,state:live?.pm2_env?.status||'missing',registered:Boolean(live),
     configuration:!live?'missing':configured(binary,args,live)?'match':'drift'});
 }
 console.log(JSON.stringify({skill,services:report},null,2));
 if(report.some(x=>x.state!=='online'||x.configuration!=='match')) {
   console.error('Service missing, unhealthy, or PM2 argv drift: inspect and explicitly re-register the affected service; setup does not overwrite a live PM2 definition.');
   process.exitCode=2;
 }
} catch(e){console.error(e.message);process.exitCode=2}
