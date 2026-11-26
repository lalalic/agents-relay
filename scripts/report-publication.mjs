#!/usr/bin/env node
// Shared publication reporting transport. This does not publish a package,
// deploy it, infer success, or modify Job lifecycle.
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const packagePattern=/^[a-z][a-z0-9-]{0,63}$/;
const shaPattern=/^[0-9a-f]{40}$/;
const semver=/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const artifactPattern=/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
export function releaseEvent({packageName,version,sha,registry='native',repository,artifact,jobId,stage}){
  const type=stage===undefined?'package.published':'package.publish_failed';
  if(typeof packageName!=='string'||typeof sha!=='string'||
    [version,repository,artifact,jobId,stage].some(v=>v!==undefined&&typeof v!=='string')||
    !packagePattern.test(packageName??'')||!shaPattern.test(sha??'')||!['native','npm'].includes(registry)
    ||(stage===undefined&&!semver.test(version??''))
    ||(version!==undefined&&!semver.test(version))
    ||(stage!==undefined&&(typeof stage!=='string'||!stage.trim()||stage.length>128))
    ||(jobId!==undefined&&!/^[1-9][0-9]*$/.test(jobId))
    ||(repository!==undefined&&(!/^[A-Za-z0-9_.-]+\/[a-z][a-z0-9-]{0,63}$/.test(repository)||repository.split('/')[1]!==packageName))
    ||(artifact!==undefined&&(artifact.length>214||!artifactPattern.test(artifact)))
    ||(registry==='npm'&&(!repository||!artifact)))throw new Error('Invalid publication metadata');
  const data={package:packageName,sha,registry};
  for(const [key,value] of Object.entries({version,repository,artifact,jobId,stage}))if(value!==undefined)data[key]=value;
  return {type,source:'release/'+packageName+'/'+sha,data};
}
export function endpoint(value,token){
  const u=new URL(value);
  const local=['127.0.0.1','localhost','[::1]'].includes(u.hostname);
  if(u.username||u.password||u.search||u.hash||u.pathname!=='/'
    ||(!local&&u.protocol!=='https:')
    ||(local&&!['http:','https:'].includes(u.protocol))
    ||(!local&&!token))throw Error('Use loopback HTTP(S), or an explicitly authorized HTTPS release-only ingress with a token');
  return u.origin;
}
export async function requestJSON(api,path,{token,payload,timeout=10000}={}){
  const url=endpoint(api,token)+path;
  const response=await fetch(url,{method:payload===undefined?'GET':'POST',redirect:'error',
    signal:AbortSignal.timeout(timeout),
    headers:{...(payload===undefined?{}:{'content-type':'application/json'}),...(token?{authorization:'Bearer '+token}:{})},
    ...(payload===undefined?{}:{body:JSON.stringify(payload)})});
  if(!response.ok)throw Error('Publication endpoint HTTP '+response.status);
  return await response.json();
}
export function releaseHistoryPath(packageName){
  if(!packagePattern.test(packageName??''))throw Error('Invalid release package');
  return '/events?'+new URLSearchParams({sourcePrefix:'release/'+packageName+'/',order:'desc',limit:'500'});
}
export async function publishVerified(api,event,{token,request=requestJSON,sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
  // Validate caller-supplied event again, including the exact three-field source.
  const {package:packageName,...rest}=event.data??{};
  const checked=releaseEvent({packageName,...rest});
  if(!isDeepStrictEqual(event,checked))throw Error('Invalid publication envelope');
  endpoint(api,token);
  const expected='release:'+packageName+':'+event.data.sha+':'+event.type;
  const history='/events?'+new URLSearchParams({source:event.source,type:event.type,order:'desc',limit:'500'});
  const recorded=async()=>{
    const body=await request(api,history,{token});
    if(body.order!=='desc'||!Array.isArray(body.events)||body.events.some(row=>row?.event?.source?.id!==event.source||row?.event?.type!==event.type))throw Error('Invalid release history');
    for(const row of body.events){
      if(row?.event?.event_id!==expected)continue;
      if(row.event.type!==event.type||row.event.source?.id!==event.source||!isDeepStrictEqual(row.event.data,event.data))throw Error('Existing publication receipt has different metadata; do not overwrite');
      return row;
    }
  };
  const old=await recorded();if(old)return old;
  const receipt=await request(api,'/events',{token,payload:{...event,event_id:expected}});
  if(!receipt?.published||receipt.event?.event_id!==expected||receipt.event?.type!==event.type||receipt.event?.source?.id!==event.source||!isDeepStrictEqual(receipt.event.data,event.data))
    throw Error('Events Bus did not acknowledge the exact publication');
  for(let i=0;i<20;i++){
    const row=await recorded();if(row)return row;
    await sleep(500);
  }
  throw Error('Publication not yet durable; retry identical metadata, not the package deployment');
}
export async function main(argv=process.argv.slice(2)){
  const {values}=parseArgs({args:argv,options:{
    package:{type:'string'},version:{type:'string'},sha:{type:'string'},registry:{type:'string',default:'native'},
    repository:{type:'string'},artifact:{type:'string'},'job-id':{type:'string'},stage:{type:'string'},
    'events-api':{type:'string',default:process.env.PUBLICATION_EVENTS_API||'http://127.0.0.1:4223'},help:{type:'boolean'}
  }});
  if(values.help){console.log('report-publication.mjs --package REPO --sha SHA --version VERSION [--registry native|npm] [--repository OWNER/REPO --artifact NAME] [--stage FAILED_STAGE] [--events-api URL]');return;}
  const event=releaseEvent({packageName:values.package,version:values.version,sha:values.sha,registry:values.registry,
    repository:values.repository,artifact:values.artifact,jobId:values['job-id'],stage:values.stage});
  const row=await publishVerified(values['events-api'],event,{token:process.env.PUBLICATION_EVENTS_TOKEN});
  console.log(JSON.stringify(row,null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error(e.message);process.exitCode=1;});
