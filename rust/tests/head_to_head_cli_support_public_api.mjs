// Public CLI storeFor + resolveEventBus transport effects, Node vs real Rust.
// All paths are disposable fixtures, no production SQLite or NATS contact.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {storeFor,resolveEventBus} from '../../dist/cli-support.js';
import {SQLiteRelayStore} from '../../dist/relay-store.js';
const root=resolve(import.meta.dirname,'../..');
const binary=join(root,'rust/target/debug/relay-rust2-api-parity');
const temporary=mkdtempSync(join(tmpdir(),'rust2-cli-public-api-'));
test.after(()=>rmSync(temporary,{recursive:true,force:true}));
const job={id:'901',repository:'local-api',prNumber:0,
  state:'ACTIVE',title:'fixture',projectRoot:'/tmp/fake-job',
  plans:[],tasks:[],createdAt:'2026-11-17T19:00:00.000Z',updatedAt:'2026-11-17T19:00:00.000Z'};
const file=join(temporary,'fixture.json');writeFileSync(file,JSON.stringify(job));
const storeDirectory=join(temporary,'stores');mkdirSync(storeDirectory);
const args=[
  ['--file',file],['--file',file,'--id','901'],['--file',file,'--id','different'],
  ['--file',file,'--id','901','--repo','local-api'],
  ['--file',file,'--id','901','--repo','wrong'],
  ['--id','not-found','--store-dir',storeDirectory],
  ['--id','not-found','--store-dir',storeDirectory,'--repo','local-api'],
  ['--id','not-found','--store-dir',storeDirectory,'--repo','wrong']
];
const fixtures=[];
for(const flags of args)for(const [allowIdOnly,optionalRepo] of [
 [false,false],[false,true],[true,false]]){
 fixtures.push({op:'apiCliSupportStoreFor',args:flags,
   directory:storeDirectory,allowIdOnly,optionalRepo});
}
const env={EVENTS_BUS_CONFIG:join(temporary,'missing-runtime.json')};
for(const flag of [[],['--file','fixture.json'],['--events','none'],['--events','nats'],
 ['--events','auto'],['--events',''],['--nats-url','nats://fixture.example:1234'],
 ['--subject-prefix','relay.test.jobs'],['--events','nats','--subject-prefix','relay.test.jobs']]){
 for(const reachable of [false,true]){
  fixtures.push({op:'apiCliSupportEventBus',args:flag,
    env,reachable});
 }
}
async function node(f){
 const prior=process.env.EVENTS_BUS_CONFIG;
 try{
  process.env.EVENTS_BUS_CONFIG=env.EVENTS_BUS_CONFIG;
  if(f.op==='apiCliSupportStoreFor'){
   const result=await storeFor(f.args,f.allowIdOnly,f.optionalRepo);
   return {ok:true,value:{job:result.job,localFile:result.localFile}};
  }
  const result=await resolveEventBus(f.args,async()=>f.reachable);
  await result.bus?.close();
  return {ok:true,value:{hasBus:Boolean(result.bus),transport:result.transport,
    source:result.source,natsUrl:result.natsUrl}};
 }catch(error){return {ok:false,error:error?.message??String(error)};}
 finally{if(prior===undefined)delete process.env.EVENTS_BUS_CONFIG;
   else process.env.EVENTS_BUS_CONFIG=prior;}
}
test('direct Node/Rust CLI store binding and event bus selection contracts',async()=>{
 const isolated=new SQLiteRelayStore(join(temporary,'relay.sqlite'),'901');
 await isolated.saveJob(job);await isolated.close();
 const expected=[];for(const f of fixtures)expected.push(await node(f));
 const p=spawnSync(binary,[],{cwd:root,input:fixtures.map(JSON.stringify).join('\n')+'\n',
  encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024});
 assert.equal(p.status,0,p.stderr||p.error?.message);
 const actual=p.stdout.trim().split('\n').map(JSON.parse);
 assert.equal(actual.length,fixtures.length);
 const mismatches=[];
 for(let i=0;i<fixtures.length;i++){
  try{assert.deepEqual(actual[i],expected[i]);}
  catch{mismatches.push({case:i,fixture:fixtures[i],node:expected[i],rust:actual[i]});}
 }
 if(mismatches.length)console.error(JSON.stringify(mismatches.slice(0,12),null,2));
 assert.equal(mismatches.length,0,`${mismatches.length} CLI API differences`);
 console.log(`Verified ${fixtures.length} Node/Rust CLI storage and event bus API cases`);
});
