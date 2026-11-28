#!/usr/bin/env node
// Compatibility convenience: explicitly publish, then activate that exact SHA.
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {loopback} from './native-release-common.mjs';
import {main as publish} from './publish-native.mjs';
import {main as live} from './live-native.mjs';
export {pausedAndQuiescent,assertIdleDatabase} from './live-native.mjs';
export async function main(argv=process.argv.slice(2)){
  const {values:args}=parseArgs({args:argv,options:{
    root:{type:'string'},api:{type:'string'},'events-api':{type:'string'},
    'job-id':{type:'string'},'allow-paused-job':{type:'string',multiple:true,default:[]},help:{type:'boolean'}
  }});
  if(args.help){console.log('release-native.mjs (publish then live) [--root DIR] [--api LOOPBACK] [--events-api LOOPBACK] [--job-id ID] [--allow-paused-job ID]');return;}
  if(args.api!==undefined)loopback(args.api);
  if(args['allow-paused-job'].some(id=>!/^[1-9][0-9]*$/.test(id)))throw Error('Job IDs must be positive decimal strings');
  const options=(...keys)=>keys.flatMap(key=>args[key]===undefined?[]:['--'+key,args[key]]);
  const {sha}=await publish([...options('root','events-api','job-id')]);
  await live([...options('root','api'),'--sha',sha,...args['allow-paused-job'].flatMap(id=>['--allow-paused-job',id])]);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(fs.realpathSync(process.argv[1])).href)main().catch(e=>{console.error(e.message);process.exitCode=1;});
