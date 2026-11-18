// Isolated live Node CLI semantics compared directly with Rust host boundary.
// The injected "neo" binary is a temporary shell fixture, never real Neo MCP.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {chmodSync,existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {runReviewCommand} from '../../dist/cli-review.js';

const root=resolve(import.meta.dirname,'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');
const tmp=mkdtempSync(join(tmpdir(),'rust2-cli-review-diff-'));
const fakeNeo=join(tmp,'neo');
const snapshot=join(tmp,'handoff-copy.json');
writeFileSync(fakeNeo, `#!/bin/sh
test "$1" = mcp || exit 31
test "$2" = call || exit 32
test "$3" = review.preview || exit 33
test "$4" = --args-file || exit 34
cp "$5" "$FAKE_REVIEW_SNAPSHOT" || exit 35
printf '%s' "$FAKE_REVIEW_OUTPUT"
`);
chmodSync(fakeNeo,0o700);
test.after(()=>rmSync(tmp,{recursive:true,force:true}));
const cases=[];
for(const args of [
 [], ['request'],['--path','relative','--id','5','--task-id','7','--execution-id','9'],
 ['request','--path','/tmp/source'], ['wait','--id','5'],
 ['fail','--id','5','--task-id','7','--execution-id','9'],
 ['begin','--id','','--task-id','7','--execution-id','9'],
 ['unknown'],['--path','/tmp/source','--id','5','--task-id','7'],
]){
 cases.push({action:'interactive',args});
}
const valid=[
 ['request','--path','/tmp/source','--id','5','--task-id','7','--execution-id','9'],
 ['--path','/tmp/source','--id','5','--task-id','7','--execution-id','9'],
];
for(const args of valid)for(const previewOutput of [
 '{"result":{"status":"pending","receiptId":"test-only"}}',
 '{"isError":true,"reason":"provider refused"}',
 '{"result":{"isError":true,"code":"unavailable"}}'
])cases.push({action:'interactive',args,previewOutput});
for(const action of ['nope','job']){
 cases.push({action,args:[]});
}
async function node(c){
 const prevPath=process.env.PATH;
 const prevOutput=process.env.FAKE_REVIEW_OUTPUT;
 const prevSnapshot=process.env.FAKE_REVIEW_SNAPSHOT;
 process.env.PATH=tmp+':'+prevPath;
 process.env.FAKE_REVIEW_OUTPUT=c.previewOutput??'{"status":"pending"}';
 process.env.FAKE_REVIEW_SNAPSHOT=snapshot;
 const oldConsole=console.log,logs=[];
 console.log=(message)=>logs.push(message);
 let outcome;
 try{
  await runReviewCommand(c.action,c.args);
  outcome={ok:true,value:logs.length?JSON.parse(logs.at(-1)):null};
 }catch(error){outcome={ok:false,error:error.message};}
 finally{
  console.log=oldConsole;
  process.env.PATH=prevPath;
  if(prevOutput===undefined)delete process.env.FAKE_REVIEW_OUTPUT;
  else process.env.FAKE_REVIEW_OUTPUT=prevOutput;
  if(prevSnapshot===undefined)delete process.env.FAKE_REVIEW_SNAPSHOT;
  else process.env.FAKE_REVIEW_SNAPSHOT=prevSnapshot;
 }
 const preview=existsSync(snapshot)?JSON.parse(readFileSync(snapshot,'utf8')):null;
 if(existsSync(snapshot))rmSync(snapshot);
 return {outcome,preview,control:null};
}
function normalization(x){
 const value=structuredClone(x);
 if(!value.outcome.ok&&value.outcome.error.startsWith('Neo review.preview rejected:')){
  value.outcome.error='Neo review.preview rejected';
 }
 return value;
}
test('direct Node/Rust review CLI validation and isolated Neo preview handoff',async()=>{
 const expected=[];for(const c of cases)expected.push(normalization(await node(c)));
 const requests=cases.map(c=>({op:'apiCliReview',...c}));
 const process=spawnSync(binary,[],{cwd:root,
  input:requests.map(JSON.stringify).join('\n')+'\n',
  encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024});
 assert.equal(process.status,0,process.stderr||process.error?.message);
 const rows=process.stdout.trim().split('\n').map(JSON.parse);
 assert.equal(rows.length,cases.length);
 const failures=[];
 for(let i=0;i<cases.length;i++){
  if(!rows[i].ok){failures.push({i,adapterError:rows[i].error});continue;}
  const actual=normalization({...rows[i].value,control:null});
  try{assert.deepEqual(actual,expected[i]);}
  catch{failures.push({i,case:cases[i],node:expected[i],rust:actual});}
 }
 assert.deepEqual(failures,[],JSON.stringify(failures,null,2));
 console.log('Verified',cases.length,'Node/Rust review CLI and fake Neo host cases');
});
