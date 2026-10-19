import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

test('isolated L2 MCP transport captures exact emitted payload without auto-repairing bad identity',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-l2-mcp-'));
 const file=join(dir,'captured.jsonl');
 const child=spawn(process.execPath,['test/verification/l2/event-server.mjs',file,'481-sandbox','task-l2','exec-l2'],{stdio:['pipe','pipe','pipe']});
 try {
  const responses=[];let buffer='';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',data=>{
   buffer+=data;
   for(;;){const end=buffer.indexOf('\n');if(end<0)break;responses.push(JSON.parse(buffer.slice(0,end)));buffer=buffer.slice(end+1);}
  });
  const emit=(id,method,params)=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
  emit(1,'initialize',{});
  emit(2,'tools/list',{});
  emit(3,'tools/call',{name:'publish',arguments:{type:'task.started',source:{id:'job/481-sandbox/task/task-l2/execution/exec-l2'},data:{}}});
  emit(4,'tools/call',{name:'publish',arguments:{type:'task.completed',source:{id:'job/481/task/task-l2/execution/exec-l2'},data:{}}});
  child.stdin.end();
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)});
  assert.equal(code,0);
  assert.equal(responses.length,4);
  assert.equal(responses[1].result.tools[0].name,'publish');
  assert.equal(responses[2].result.isError,false);
  assert.equal(responses[3].result.isError,true);
  const captured=readFileSync(file,'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(captured.map(x=>x.validation),[[],['source.id']]);
  assert.equal(captured[1].raw.source.id,'job/481/task/task-l2/execution/exec-l2');
 }finally{child.kill();rmSync(dir,{recursive:true,force:true});}
});
