// Original Node src/dashboard-mobile.ts versus Rust dashboard_mobile.rs public
// head-to-head privacy projections using deterministic IDs and Graph-safe data.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import * as node from '../../dist/dashboard-mobile.js';
let seed=0x6257a;
const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296};
const pick=a=>a[Math.floor(random()*a.length)];
const base=(id,repository='vlog')=>({
 id,repository,title:pick(['Title','中文任务','A😀','',null]),
 state:pick(['DRAFT','ACTIVE','COMPLETED','CANCELLED','FAILED','RUNNING','bad','']),
 runtimeStatus:pick(['ACTIVE','RUNNING','FAILED',null,'COMPLETED','DRAFT']),
 updatedAt:pick(['2026-11-20T01:00:00Z','2026-11-20T02:00:00Z','z','']),
 createdAt:'2026-11-20T01:00:00Z',
 objective:'SECRET_PROMPT',token:'SECRET_TOKEN',
 tasks:[{id:'task1',title:'Visible',objective:'SECRET_PROMPT'},
        {id:'bad/task',title:'Private'},null,{id:'task2',title:'  '},
        {id:'task3',title:' Visible  '}]
});
const cases=[];
function add(method,arg){
 let expected;
 try{
  switch(method){
   case 'validMobileIdentity':expected=node.validMobileIdentity(arg.id,arg.repository);break;
   case 'projectMobileJob':expected=node.projectMobileJob(arg.row);break;
   case 'projectMobileJobs':expected=node.projectMobileJobs(arg.rows,arg.offset,arg.limit);break;
   case 'projectMobileTasks':expected=node.projectMobileTasks(arg.row,arg.id,arg.repository);break;
   case 'projectMobileActivity':expected=node.projectMobileActivity(arg.rows);break;
  }
  cases.push({method,...arg,expected:{ok:true,value:expected}});
 }catch(e){cases.push({method,...arg,expected:{ok:false,error:String(e.message)}});}
}
for(const id of ['a','job_101','1.2-3','../../bad','bad/x','',null,'あ','A'.repeat(101)]){
 for(const repository of ['vlog','neo/toyalive-3d','local/vlog','neo//bad','neo/../bad','/neo','neo/','neo/%2e','bad?evil',''])
  add('validMobileIdentity',{id,repository});
}
for(let i=0;i<160;i++){
 const row=base(pick(['a','b','job_1','valid-123','no/path',null,'']),pick([
   'vlog','neo/toyalive-3d','local/vlog','bad?repo','','neo//bad']));
 add('projectMobileJob',{row});
 add('projectMobileTasks',{row,id:pick([row.id,'wrong']),repository:pick([row.repository,'other'])});
}
for(let i=0;i<110;i++){
 const rows=Array.from({length:Math.floor(random()*28)},(_,j)=>base('job'+j));
 add('projectMobileJobs',{rows,offset:pick([0,1,20,31,-1,0.5,Number.MAX_SAFE_INTEGER]),
  limit:pick([1,2,5,20,21,0,2.5])});
}
for(const ids of [['a','A','b','B','z','Z'],['a-1','a_1','a.1','a1','a2'],
 ['foo','FOO','Foo','foo_2','foo-2']]){
 const same=ids.map(id=>({...base(id),'state':'ACTIVE',
   runtimeStatus:'ACTIVE',updatedAt:'2026-11-20T01:00:00.000Z'}));
 add('projectMobileJobs',{rows:same,offset:0,limit:20});
}
for(let i=0;i<90;i++){
 const rows=Array.from({length:Math.floor(random()*130)},()=>({
  type:pick(['task.started','task.completed','review.approved','job.completed',
   'secret.exfiltration','bad','task.Bad','planner_',null]),
  timestamp:pick(['2026-11-20T01:00:00Z','2026-11-20T02:00:00Z',
   '2026-1-2T','bad',null]),task_id:pick(['1','bad/id','',null]),message:'SECRET_MESSAGE'
 }));
 add('projectMobileActivity',{rows});
}
test('Node/Rust dashboard mobile privacy, identity and pagination',()=>{
 const build=spawnSync('cargo',['build','--offline','--manifest-path','rust/Cargo.toml',
  '--bin','relay-rust2-parity'],{encoding:'utf8',maxBuffer:3*1024*1024});
 assert.equal(build.status,0,build.stderr);
 const payload=cases.map(({expected,...input})=>({op:'dashboardMobile',...input}));
 const rust=spawnSync('rust/target/debug/relay-rust2-parity',[],{
  input:payload.map(value=>JSON.stringify(value)).join('\n')+'\n',
  encoding:'utf8',maxBuffer:12*1024*1024
 });
 assert.equal(rust.status,0,rust.stderr);
 const values=rust.stdout.trimEnd().split('\n').map(line=>JSON.parse(line));
 assert.equal(values.length,cases.length);
 const divergences=[];
 for(let i=0;i<cases.length;i++){
  const r=cases[i],actual=values[i],expected=r.expected;
  try{
   assert.equal(actual.ok,expected.ok);
   if(expected.ok)assert.deepEqual(actual.value,expected.value);
   else assert.equal(actual.error,expected.error);
  }catch(error){divergences.push({index:i,method:r.method,
    input:JSON.stringify(r).slice(0,350),expected,actual});}
 }
 assert.deepEqual(divergences.slice(0,7),[],
  String(divergences.length)+' Node/Rust divergent mobile projections');
 console.log('Verified '+cases.length+' original Node/Rust mobile API fixtures');
});
