import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'../..');
const {createWorkspaceControl}=await import(pathToFileURL(root+'/dist/relayd-control.js'));
const body=[
 {},{command:undefined},{command:null},{command:0},{command:true},{command:''},
 {command:'job.update'},{command:'job.cancel',jobId:''},
 {command:'job.plan',jobId:null},{command:'job.retry',jobId:0},
 {command:'job.create'}, {command:'job.create',repository:''},
 {command:'job.create',repository:null},{command:'job.create',repository:100},
 {command:'job.create',options:{projectPath:null}},
 {command:'job.create',options:{contentOnly:false}},
 {command:'job.create',options:{executionMode:null}},
 {command:'job.create',options:{schedule:null}},
 {command:'job.create',repository:'good/repo',options:{schedule:{}}},
 {command:'job.create',repository:'good/repo',initialPlan:true,options:{coordinator:{}}},
 {command:'job.create',repository:'',options:{projectPath:'old',contentOnly:false}},
 {command:'job.create',repository:'',options:{contentOnly:false,executionMode:'old'}},
 {command:'job.create',repository:'',options:{schedule:null}},
 {command:'job.create',repository:'',options:{coordinator:{}}},
 {command:' ',jobId:''},{command:'x',jobId:''},{command:'\t',jobId:null},
 {command:'job.create',repository:'good/repo',options:{projectPath:'old',schedule:null}},
 {command:'job.create',repository:'good/repo',options:{contentOnly:null,schedule:null}},
 {command:'job.create',repository:'good/repo',options:{executionMode:false,schedule:null}},
 {command:'job.create',repository:'good/repo',initialPlan:true,options:{coordinator:{},schedule:null}},
];
const command=createWorkspaceControl({});
const expected=[];
for(const input of body){
 try{expected.push({ok:true,value:await command(input)});}
 catch(error){expected.push({ok:false,error:error.message});}
}
const run=spawnSync(root+'/rust/target/debug/relay-rust2-parity',[],
 {encoding:'utf8',input:body.map(x=>JSON.stringify({op:'workspaceControlFactoryParity',body:x})).join('\n')+'\n',timeout:120000});
assert.equal(run.status,0,run.stderr);
const actual=run.stdout.trim().split('\n').map(JSON.parse).map(x=>x.ok?x.value.outcome:x);
assert.equal(actual.length,body.length);
const mismatch=[];
for(let i=0;i<body.length;i++){
 try{assert.deepEqual(actual[i],expected[i]);}
 catch{mismatch.push({index:i,input:body[i],node:expected[i],rust:actual[i]});}
}
if(mismatch.length){for(const diff of mismatch)console.log('DIFF',JSON.stringify(diff));process.exitCode=1;}
else console.log(`WORKSPACE_CONTROL_DIRECT_NODE_RUST_PASS ${body.length}`);
