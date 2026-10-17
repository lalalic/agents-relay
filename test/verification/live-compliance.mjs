import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Never infer compliance from process exit alone: require actual role event records. */
export function evaluateEmissions({role,executionId,source,events,exitCode=0,transportAccepted=true,provider='unknown'}) {
  const base={role,provider,source,emitted:events.length,transportAccepted};
  if (exitCode!==0) return {...base,outcome:'FAIL',category:'L2',failureClass:'ADAPTER_OR_PROVIDER',reason:`adapter exited ${exitCode}`};
  if (!transportAccepted) return {...base,outcome:'FAIL',category:'L2',failureClass:'TRANSPORT',reason:'ingress rejected emission'};
  const terminals=events.filter(x=>['task.completed','task.failed'].includes(x.type));
  if (events.some(x=>x.source!==source)||terminals.length!==1||!events.some(x=>x.type==='task.started'))
    return {...base,outcome:'FAIL',category:'L2',failureClass:'MODEL_CONTRACT',reason:'wrong source or lifecycle cardinality'};
  const result=terminals[0];
  if (role==='reviewer' && result.type==='task.completed' && !(['approved','changes-required'].includes(result.data?.verdict)&&result.data?.head_sha))
    return {...base,outcome:'FAIL',category:'L2',failureClass:'MODEL_CONTRACT',reason:'reviewer verdict or immutable SHA absent'};
  if (result.type==='task.failed' && !result.data?.reason)
    return {...base,outcome:'FAIL',category:'L2',failureClass:'MODEL_CONTRACT',reason:'failure reason absent'};
  if (!executionId || !source.endsWith('/execution/'+executionId))
    return {...base,outcome:'FAIL',category:'L2',failureClass:'MODEL_CONTRACT',reason:'execution identity mismatch'};
  return {...base,outcome:'PASS',category:'L2',failureClass:null,reason:null};
}

/** Opt-in only; invokes user configured real adapter, no simulated model calls. */
export async function runLiveMatrix(config, {timeoutMs=120000}={}) {
  if (process.env.BW_L2_LIVE!=='1') return config.cases.map(x=>({role:x.role,provider:x.provider,outcome:'NOT_RUN',category:'L2',reason:'set BW_L2_LIVE=1'}));
  return await Promise.all(config.cases.map(async item=>{
    if (!item.command || !item.skillPath) return {role:item.role,provider:item.provider,outcome:'UNSUPPORTED',category:'L2',reason:'real adapter command and agent skill required'};
    const skill=readFileSync(item.skillPath,'utf8');
    const input=JSON.stringify({role:item.role,skill,task:item.task,source:item.source,executionId:item.executionId});
    const child=spawn(item.command[0],item.command.slice(1),{stdio:['pipe','pipe','pipe'],env:{...process.env,BW_L2_SOURCE:item.source}});
    let stdout='',stderr='';child.stdout.on('data',x=>{stdout+=x});child.stderr.on('data',x=>{stderr+=x});
    child.stdin.end(input);
    const outcome=await new Promise(resolve=>{
      const timer=setTimeout(()=>{child.kill('SIGKILL');resolve({code:124})},timeoutMs);
      child.once('error',err=>{clearTimeout(timer);resolve({code:127,error:err.message})});
      child.once('exit',code=>{clearTimeout(timer);resolve({code})});
    });
    try {const data=JSON.parse(stdout);return evaluateEmissions({...item,events:data.events||[],exitCode:outcome.code,transportAccepted:data.transportAccepted===true});}
    catch {return {role:item.role,provider:item.provider,outcome:'FAIL',category:'L2',failureClass:'ADAPTER_OR_PROVIDER',reason:outcome.error || stderr.slice(-500) || 'invalid adapter output'};}
  }));
}
