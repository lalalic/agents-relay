// Direct Node/Rust differential for src/observability.ts: secret redaction, failure classification and nested correlation-only observations.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
 errorMessage,classifyFailure,sanitizeObservationValue,sanitizeObservationData,
 RelayObservability,collectObservations,withObservabilityCorrelation,currentObservabilityCorrelation,
} from '../../dist/observability.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const binary=resolve(root,'rust/target/debug/relay-rust2-parity');
let built=false;
function rust(request){
 if(!built){const result=spawnSync('cargo',['build','--offline','--manifest-path','rust/Cargo.toml'],{cwd:root,encoding:'utf8',timeout:90000});assert.equal(result.status,0,result.stderr);built=true;}
 const result=spawnSync(binary,[],{input:JSON.stringify(request)+'\n',encoding:'utf8',maxBuffer:9*1024*1024,timeout:12000});
 assert.equal(result.status,0,`${result.error}: ${result.stderr}`);
 return JSON.parse(result.stdout.trim());
}
function node(req){
 try{
  const error=req.asError?Object.assign(new Error(req.error.message??''),req.error):req.error;
  let value;
  switch(req.op){
   case 'errorMessage':value=errorMessage(error);break;
   case 'classifyFailure':value=classifyFailure(error);break;
   case 'sanitizeObservationValue':value=sanitizeObservationValue(req.value,req.depth);break;
   case 'sanitizeObservationData':value=sanitizeObservationData(req.data);break;
   case 'observabilityEnvironment':{
    const observer=RelayObservability.fromEnvironment(req.env);
    value={minimumLevel:observer.minimumLevel,enabled:['debug','info','warn','error','unknown'].map(level=>({level,enabled:observer.isEnabled(level)}))};
    break;
   }
   case 'observabilityScenario':{
    const observations=[];
    const observer=new RelayObservability(collectObservations(observations),req.minimumLevel);
    const beforeRecord=()=>req.before?.forEach(record=>observer.record(record));
    const duringRecord=()=>req.during?.forEach(record=>observer.record(record));
    const afterRecord=()=>req.after?.forEach(record=>observer.record(record));
    const nested=withObservabilityCorrelation(req.outer??{},()=>{
       const before=currentObservabilityCorrelation();beforeRecord();
       const inside=withObservabilityCorrelation(req.inner??{},()=>{const inside=currentObservabilityCorrelation();duringRecord();return inside});
       afterRecord();return {before,inside,after:currentObservabilityCorrelation()};
    });
    value={records:observations.map(record=>({...record,ts:req.timestamp})),nested,
       previous:{},final:currentObservabilityCorrelation()};break;
   }
   default:throw Error(`unknown fixture ${req.op}`);
  }
  // A top-level JS undefined is not serializable; the parity harness carries
  // it as JSON null without turning the normal Node API outcome into an error.
  return {ok:true,value:value===undefined?null:JSON.parse(JSON.stringify(value))};
 }catch(error){return {ok:false,error:error.message}}
}
const fixtures=[];
const errors=[
 null,false,true,0,3.125,409,'ECONNRESET','HTTP rate limit','socket hang up','Task exists',
 [],[1,2],{}, {message:'already exists with a different definition'},
 {message:'Task already exists with a DIFFERENT definition',status:409},
 {message:'server error',status:503},
 {message:'ERR',statusCode:503},
 {message:'rate limited',status:429},
 {message:'rate limited',status:400,retryAfter:5},
 {message:'failed',response:{status:502,headers:{'Retry-After':'3'}}},
 {message:'fetch failed: ETIMEDOUT'},
 {message:'not found',status:404},
 {message:'wrapped',status:'503',statusCode:503},
 {message:'throttled',retryAfter:'0.5'},
 {message:'throttled',retryAfter:0,retryAfterMs:7.5},
 {message:'backoff',response:{headers:{'RETRY-AFTER':'1.5'}}},
 {message:'response error',headers:{'retry-after':12}},
 {message:'nothing',response:{headers:[]}},
 {message:'already exists with a different definition',status:503},
 {message:'unset',retryAfter:'junk',retryAfterMs:false},
 {message:'other',retryAfter:null,retryAfterMs:null},
];
let seed=0xf002715b;
const rand=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n};
const select=list=>list[rand(list.length)];
const messageParts=['network temporary unavailable','Task exists with a different definition','ECONNRESET','ETIMEDOUT','Fetch failed','random','Unknown error','rate limit reached','EAI_AGAIN','und_err','task.failed',''] ;
for(let i=0;i<1800;i++){
 const message=select(messageParts);
 const status=select([undefined,200,400,409,429,500,503,599,600,0,-1,null,'500',true]);
 const statusCode=select([undefined,503,429,409,200,null]);
 const retryAfter=select([undefined,null,'0','5','0.25',5,-1,'nope',true,false]);
 const retryAfterMs=select([undefined,1,250.5,0,null,-1,'3',false]);
 const headers=select([undefined,{'retry-after':'2'},{'RETRY-AFTER':'3'}, {'Retry-After':'0'},{}]);
 errors.push({message,status,statusCode,retryAfter,retryAfterMs,headers, response:select([undefined,{status:503,headers},{status:429},{}])});
}
for(const error of errors)for(const op of ['errorMessage','classifyFailure'])fixtures.push({op,error});
for(const error of [{},{status:429},{message:''},{message:'failed',status:503}, {message:'',retryAfter:15}]) {
 fixtures.push({op:'classifyFailure',error,asError:true},{op:'errorMessage',error,asError:true});
}
for(const message of ['bad info','rate limit','timeout','token expired'])for(const error of [{message,status:429},{message,status:409},{message,status:500}]){
 fixtures.push({op:'classifyFailure',error,asError:true},{op:'errorMessage',error,asError:true});
}
const values=[
 'A'.repeat(511)+'🙂suffix','A'.repeat(510)+'🙂suffix','🙂'.repeat(255)+'A🙂suffix',
 null,true,false,0,12.5,'','hello','💚','😀'.repeat(256),'a'.repeat(512),'a'.repeat(513),
 '汉'.repeat(600),'prefix'.repeat(100),'🙂'.repeat(300),
 {authorization:'Bearer secret',apiKey:'my-api-key',nested:{password:'pass',prompt:'SYSTEM',keep:'safe'}},
 {input:'secret'.repeat(100),content:'raw'.repeat(200),body:'one'.repeat(40),patch:'x'.repeat(513)},
 {a:{b:{c:{d:{e:12,foo:'deep',token:'secret'}}}}},
 Array.from({length:25},(_,i)=>({index:i,authorization:'Bearer '+i,keep:'x'.repeat(530)})),
 {'__proto__':'object',normal:1},
 {someArray:[{data:{nested:{one:{two:{level:6}}}}}]},
];
const keys=['token','access_token','password','PassWd','apiKey','API-KEY','private-key','Authorization','cookies','headers','promptData','nested','body','messages','payload','nested_data','safe'];
for(let i=0;i<2300;i++){
 const value={};for(let j=0;j<rand(15);j++){
  value[select(keys)]=select([null,1,0,false,'x'.repeat(40),'😀'.repeat(270),['x'.repeat(520)],{secret:'pass',normal:8},{body:'a'.repeat(700),details:{cookie:'test'}}]);
 }
 values.push(select([value,[value,value],{children:[value,value]},{data:{nested:value}},'a'.repeat(rand(850)),true]));
}
for(const value of values){fixtures.push({op:'sanitizeObservationValue',value,depth:select([0,1,2,3,4,5])});fixtures.push({op:'sanitizeObservationData',data:value});}

for(const setting of [undefined,'','debug','info','warn','error','Silent','off','NONE','0','false',' bogus ', ' DEBUG ']){
 for(const fallback of [undefined,'info','warn','debug']){
  fixtures.push({op:'observabilityEnvironment',env:{
   ...(setting!==undefined?{AGENTS_RELAY_OBSERVABILITY:setting}:{}),
   ...(fallback!==undefined?{RELAY_OBSERVABILITY_LEVEL:fallback}:{}),
  }});
 }
}
const records=[
 {stage:'wake',event:'Job wake',message:'Started',data:{token:'very secret',attempt:1}},
 {stage:'graph',event:'transition',message:'Moved',level:'debug',outcome:'started',transition:{graph:'job',from:'ACTIVE',to:'COMPLETED'}},
 {stage:'store',event:'save',message:'Saved',level:'info',outcome:'succeeded',correlation:{jobId:'override-job'},data:{input:'a'.repeat(800),payload:'b'.repeat(1200),nested:{password:'secret',keep:'safe'}}},
 {stage:'projection',event:'retry',message:'Retry',level:'warn',outcome:'failed',data:{error:'bad',nested:{nested:{nested:{value:'secret',message:'hi'}}}}},
 {stage:'daemon',event:'error',message:'Failed',level:'error',outcome:'failed'},
 {stage:'reconcile',event:'noop',message:'Already done',outcome:'noop'},
];
for(let i=0;i<350;i++){
 const minimumLevel=select(['debug','info','warn','error']);
 const before=Array.from({length:rand(6)},()=>select(records));
 const during=Array.from({length:rand(7)},()=>select(records));
 const after=Array.from({length:rand(5)},()=>select(records));
 fixtures.push({op:'observabilityScenario',minimumLevel,outer:{repository:select(['repo','other']),jobId:'job-100',taskId:'t-1'},
  inner:{taskId:'t-2',executionId:'exec-2'},before,during,after,timestamp:'2026-11-16T15:00:00.000Z'});
}

test('failure classification, strict redaction and nested correlation match Node JSON wire',()=>{
 let count=0;
 for(const request of fixtures){
  const expected=node(request),actual=rust(request);
  assert.deepEqual(actual,expected,`Observability mismatch ${count}, ${JSON.stringify(request).slice(0,500)}`);
  count++;
 }
 console.log(`Verified ${count} Node/Rust observability fixtures: failure classification, sensitive keys, payload bounds, nested contexts`);
});
