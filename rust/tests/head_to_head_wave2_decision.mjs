import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {validateDecisionRequest,parseChoiceDecision,chooseWithDecision,
  JevDecisionEngine,decisionMode} from '../../dist/decision.js';
const root=resolve(import.meta.dirname,'../..');
const bin=resolve(root,'rust/target/debug/relay-rust2-parity');
let seed=0x81a23c19;
const rand=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n};
const pick=a=>a[rand(a.length)];
const all=[];
function add(action,fields={}){all.push({op:'wave2Decision',action,...fields})}
for(let i=0;i<1100;i++){
 const choices=pick([['one','two'],['one'],[],['x','x'],['','y'],['Yes','No','Maybe']]);
 const contract={type:pick(['choice','choice','choice','bad']),question:pick(['Choose',' X ','','   ']),choices};
 const request={facts:pick([null,{value:i,flag:i%2===0},{nested:[{a:true},{b:null}]},[1,'yes',false]])};
 const raw=pick([null,{},[],{choice:pick(['one','two','x','Yes','No','wrong',''])},
  {answers:{decision:{choice:pick(['one','two','x','Yes','No','wrong']),
    probabilities:{one:0.7,two:0.3,x:0.5,Yes:0.2,No:0.8}}}},
  {choice:'one',probabilities:{one:pick([0,1,-1,'0.2',0.4]),two:pick([0.6,1.2,0.5,'0.6'])}},
  {answers:[]},{answers:{decision:null}}]);
 add('validate',{contract,request});
 add('parse',{contract,raw});
 add('choose',{contract,request,hasEngine:pick([true,false]),mode:pick(['off','shadow','active']),
  fallback:pick(['one','two','No','x']),raw:pick([
    {type:'choice',choice:'one',probabilities:{one:0.5,two:0.5}},
    {type:'choice',choice:'No'}, {type:'wrong'},{}]),engineError:pick([null,null,'engine offline'])});
 const jevRaw=pick([{}, {answers:{decision:{choice:'route_1',probabilities:{route_1:0.7,route_2:0.3}}},usage:{input_tokens:5},model:'mock'},
  {answers:{decision:{choice:'route_2'}}},{answers:{decision:{choice:'invalid'}}}]);
 add('jevDecide',{contract,request,raw:jevRaw,apiKey:pick(['token','','token']),
  httpStatus:pick([200,200,429,500])});
}
add('mode');
function rust(reqs){
 const p=spawnSync(bin,[],{cwd:root,input:reqs.map(r=>JSON.stringify(r)).join('\n')+'\n',
 encoding:'utf8',timeout:120000,maxBuffer:40*1024*1024});
 assert.equal(p.status,0,p.stderr||String(p.error));
 const lines=p.stdout.trim().split('\n').map(x=>JSON.parse(x));
 assert.equal(lines.length,reqs.length);
 return lines;
}
async function node(q){
 try{
  const {action,contract,request,raw}=q;
  let value;
  switch(action){
   case 'validate':validateDecisionRequest(request,contract);value=null;break;
   case 'parse':value=parseChoiceDecision(raw,contract);break;
   case 'mode':value=decisionMode();break;
   case 'choose':{
     const engine=q.hasEngine?{name:'mock-engine',decide:async()=>{
       if(q.engineError)throw new Error(q.engineError);
       return q.raw;
     }}:undefined;
     value=await chooseWithDecision(engine,q.mode,request,contract,()=>q.fallback);break;
   }
   case 'jevDecide':{
     const engine=new JevDecisionEngine({apiKey:q.apiKey,endpoint:'http://127.0.0.1:1',
       timeoutMs:99,fetcher:async(url,params)=>{
         const body=JSON.parse(params.body);
         assert.ok(body.questions.decision.criteria);
         return {ok:q.httpStatus>=200&&q.httpStatus<300,status:q.httpStatus,json:async()=>raw};
       }});
     value=await engine.decide(request,contract);delete value.latencyMs;break;
   }
   default:throw new Error('bad action');
  }
  return {ok:true,value};
 }catch(err){return {ok:false,error:err.message}}
}
test('choice contracts, probabilities, fallback modes, Jev HTTP mock and failures match real Node exports',async()=>{
 const got=rust(all);
 for(let i=0;i<all.length;i++){
  const expected=await node(all[i]),actual=got[i];
  if(all[i].action==='jevDecide'&&actual.ok)delete actual.value?.latencyMs;
  assert.deepEqual(actual,expected,'decision '+i+' '+JSON.stringify(all[i]).slice(0,510));
 }
 console.log('decision '+all.length+' Node/Rust randomized outcomes');
});
