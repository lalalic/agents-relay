// Direct Node/Rust differential for src/process-identity.ts: real isolated process-group generations, lease owner ps and guarded signals.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync,execFileSync} from 'node:child_process';
import {hostname} from 'node:os';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
 observeProcess,captureProcessRecord,probeProcessRecord,activeRelayLeaseOwner,stopOrphanedProcessGroup,
} from '../../dist/process-identity.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const rustBinary=resolve(root,'rust/target/debug/relay-rust2-parity');
function rust(req){const out=spawnSync(rustBinary,[],{input:JSON.stringify(req)+'\n',encoding:'utf8',timeout:7000});assert.equal(out.status,0,`Rust failed: ${out.stderr}`);const data=JSON.parse(out.stdout.trim());if(!data.ok)throw Error(data.error);return data.value}
async function sleep(ms){await new Promise(resolve=>setTimeout(resolve,ms))}

// Launch a disposable Node child in a new session and let its Python parent
// exit. The adopted child gets its own PGID and is not a production process.
function launchFixture(named=false){
 const code=named?`process.title='agents-relayd';setInterval(()=>{},1000)`:'setInterval(()=>{},1000)';
 const script=`import subprocess\np=subprocess.Popen([${JSON.stringify(process.execPath)},'-e',${JSON.stringify(code)}],start_new_session=True,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,close_fds=True)\nprint(p.pid)`;
 const out=execFileSync('python3',['-c',script],{encoding:'utf8',timeout:5000});
 const pid=Number(out.trim());assert(Number.isSafeInteger(pid)&&pid>2);
 return pid;
}
async function readyLeader(pid){
 for(let i=0;i<20;i++){
  const info=await observeProcess(pid);
  if(info?.pgid===pid)return info;
  await sleep(25);
 }
 throw Error(`Controlled fixture ${pid} did not become an isolated group leader`);
}
async function cleanFixture(pid){
 const observation=await observeProcess(pid);
 if(observation?.pgid===pid){
  try{process.kill(-pid,'SIGKILL')}catch(error){if(error.code!=='ESRCH')throw error}
 }
 await sleep(50);
}

function isIso(value){return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)}
function normalizeRecord(value){if(value===null)return null;assert(isIso(value.observedAt));return {...value,observedAt:'verified ISO'};}

const invalid=[-12,-1,0,1,1.5,9999999999];
test('observeProcess rejects invalid PIDs and agrees with Node for the current process',async()=>{
 for(const pid of [...invalid,process.pid]){
  const actual=rust({op:'observeProcess',pid});
  const expected=await observeProcess(pid);
  assert.deepEqual(actual,expected,`observeProcess(${pid})`);
 }
 console.log(`Verified ${invalid.length+1} process probe calls`);
});

test('capture/probe generations and activeRelayLeaseOwner agree on isolated group leaders',async()=>{
 const worker=launchFixture(),relayd=launchFixture(true);
 try{
  const observed=await readyLeader(worker);
  await readyLeader(relayd);
  assert.deepEqual(rust({op:'observeProcess',pid:worker}),observed);
  const args={jobId:'42',taskId:'120',executionId:'run-42',leaseOwner:'daemon-fixture',pid:worker};
  const expected=await captureProcessRecord(args.jobId,args.taskId,args.executionId,args.leaseOwner,args.pid);
  const actual=rust({op:'captureProcessRecord',...args});
  assert.deepEqual(normalizeRecord(actual),normalizeRecord(expected));
  assert.equal(actual.pgid,worker);
  assert.equal(actual.host,hostname());
  for(const record of [expected,
    ...[-1,0,1,2,2147483648].map(pid=>({...expected,pid,pgid:pid,startToken:'missing'})),
    {...expected,host:'remote.example'},
    {...expected,startToken:'invalid generation'},
    {...expected,startToken:''},
    {...expected,pgid:worker+1},
    {...expected,pid:worker+1},
  ]){
   const node=await probeProcessRecord(record);
   const rustValue=rust({op:'probeProcessRecord',record});
   assert.equal(rustValue,node,`Process generation probe ${JSON.stringify(record).slice(0,150)}`);
  }
  for(const owner of ['', 'relayd-0','relayd-1','relayd-abc','relayd-999999999','relay-'+worker,
    'relayd-'+worker,'relayd-'+relayd]){
   const node=await activeRelayLeaseOwner(owner);
   const rustValue=rust({op:'activeRelayLeaseOwner',owner});
   assert.equal(rustValue,node,`Lease owner ${owner}`);
  }
  // A bad lease identity must never kill a still-running controlled process.
  for(const record of [{...expected,host:'remote.example'},{...expected,pgid:worker+1},
    {...expected,startToken:'stale generation'}]){
   assert.equal(rust({op:'stopOrphanedProcessGroup',record,graceMs:10}),
    await stopOrphanedProcessGroup(record,10));
   assert((await observeProcess(worker))?.pgid===worker,'Guard must not signal an unrelated process group');
  }
  console.log('Verified isolated process generations, lease names, and negative signal fencing');
 }finally{await cleanFixture(worker);await cleanFixture(relayd)}
});

test('controlled abandoned process groups terminate with Node and Rust',async()=>{
 let checked=0;
 for(const target of ['node','rust']){
  const pid=launchFixture();
  try{
   const observed=await readyLeader(pid);
   const record={jobId:'fixture',taskId:'10',executionId:'fixture-execution',leaseOwner:'fixture',
     host:hostname(),pid,pgid:pid,startToken:observed.startToken,observedAt:new Date().toISOString()};
   const outcome=target==='node'?await stopOrphanedProcessGroup(record,30):rust({op:'stopOrphanedProcessGroup',record,graceMs:30});
   assert.equal(outcome,true,`${target} did not terminate isolated process leader`);
   await sleep(30);
   assert.equal(await probeProcessRecord(record),'gone',`${target} left isolated process running`);
   checked++;
  }finally{await cleanFixture(pid)}
 }
 console.log(`Verified ${checked} actual orphan process-group terminations with isolated fixture PIDs`);
});
