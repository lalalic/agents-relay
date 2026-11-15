// Test parent process intentionally killed by the E2E test after worker start.
// A disconnected/killed parent must never leave its native worker running.
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import readline from 'node:readline';
const [binary,dir,mode='die'] = process.argv.slice(2);
if(!binary || !dir) process.exit(2);
const helper=spawn(binary,[],{stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin'}});
let emitted=false;
helper.on('error',error=>{console.error('HELPER_ERROR',error.message);process.exitCode=2;});
helper.stdin.write(JSON.stringify({
 parentPid:process.pid,db:join(dir,'relay.sqlite'),jobId:'91',taskId:'101',executionId:'exec-1',executable:'/bin/sh',
 args:['-c',mode==='normal'?"printf 'hello'; printf 'warn' >&2":mode==='renew'?"exec sleep 0.60":'exec sleep 20'],cwd:dir,
 env:{PATH:'/usr/bin:/bin'},stdout:join(dir,'worker.out'),stderr:join(dir,'worker.err'),
 timeoutMs:mode==='renew'?500:25000,terminateGraceMs:100
})+'\n');
for await(const line of readline.createInterface({input:helper.stdout})){
 try{
  const message=JSON.parse(line);
  if(message.type==='started'){
   emitted=true;
   helper.stdin.write('ack\n');
   process.stdout.write('STARTED '+message.pid+'\n');
   if(mode==='renew'){
    setTimeout(()=>{
     const db=new DatabaseSync(join(dir,'relay.sqlite'));
     db.prepare('UPDATE job_snapshot SET json=? WHERE job_id=?').run(
      JSON.stringify({id:'91',tasks:[{id:'101',state:'RUNNING',executionId:'exec-1',lastWorkerActivityAt:new Date().toISOString()}]}),'91');
     db.close();
    },200);
   }
   if(mode==='die')setInterval(()=>{},1000);
  }
  if(message.type==='finished'){
   process.stdout.write('FINISHED '+JSON.stringify(message.result)+'\n');
   helper.stdin.end();
  }
  if(message.type==='failed'){
   console.error('HELPER_FAILED',message.error);
   process.exitCode=2;
  }
 }catch(error){console.error('PARENT_PARSE_ERROR',error.message);process.exitCode=2;}
}
if(!emitted)process.exitCode=2;
