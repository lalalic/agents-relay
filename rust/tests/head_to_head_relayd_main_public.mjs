// Original dist/relayd-main.js byte-for-byte launcher with only its imported
// runDaemon replaced by an isolated contract spy. Rust invokes the public
// relayd_main::run_relayd_main used by the actual native daemon binary.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,copyFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const root=resolve(import.meta.dirname,'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');
const temp=mkdtempSync(join(tmpdir(),'rust2-relayd-main-'));
test.after(()=>rmSync(temp,{recursive:true,force:true}));
writeFileSync(join(temp,'package.json'),JSON.stringify({type:'module'}));
copyFileSync(join(root,'dist/relayd-main.js'),join(temp,'relayd-main.js'));
writeFileSync(join(temp,'relayd.js'),`
export async function runDaemon(args){
 console.log(JSON.stringify({forwardedArgs:args}));
 if(process.env.FAKE_DAEMON_ERROR!==undefined)throw new Error(process.env.FAKE_DAEMON_ERROR);
}
`);
let seed=0x89dfb11;
function rnd(){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;}
const strings=['','--port','5512','--isolated-store-dir','/tmp/fixture','--interval','50',
  '中文','has space','--bad-flag','"quoted"','\\n'];
const cases=Array.from({length:48},(_,i)=>({
  op:'certRelaydMain',
  argv:Array.from({length:rnd()%8},()=>strings[rnd()%strings.length]),
  error:i%3===0?'Failed to start native relayd':i%7===0?'invalid configuration':null,
}));
test('48 original Node/Rust daemon entrypoint success/failure/argv cases',()=>{
 const errors=[];
 for(let i=0;i<cases.length;i++){
   const c=cases[i];
   const node=spawnSync(process.execPath,[join(temp,'relayd-main.js'),...c.argv],
     {encoding:'utf8',timeout:5000,
       env:{...process.env,...(c.error===null?{}:{FAKE_DAEMON_ERROR:c.error})}});
   assert.equal(node.error,undefined,node.error?.message);
   const rust=spawnSync(binary,[],{cwd:root,input:JSON.stringify(c)+'\n',
     encoding:'utf8',timeout:10000});
   assert.equal(rust.status,0,rust.stderr);
   const output=JSON.parse(rust.stdout.trim());
   assert.equal(output.ok,true);
   const observed=JSON.parse(node.stdout.trim());
   const expected={exitCode:node.status,forwardedArgs:observed.forwardedArgs};
   try{
     assert.deepEqual(output.value,expected);
     assert.equal(rust.stderr.trim(),node.stderr.trim());
   }catch{errors.push({i,argv:c.argv,error:c.error,node:expected,rust:output.value,
      nodeStderr:node.stderr,rustStderr:rust.stderr});}
 }
 assert.deepEqual(errors.slice(0,4),[],`${errors.length} direct Node/Rust daemon entrypoint mismatches`);
 console.log('Verified 48 original Node/Rust daemon entrypoint cases');
});
