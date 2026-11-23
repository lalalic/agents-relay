import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

// Exercise the exact pure helpers shipped in the classic dashboard script.
const script=readFileSync(fileURLToPath(new URL('./dashboard.js',import.meta.url)),'utf8');
function helper(name){
  const start=script.indexOf(`function ${name}(`);
  assert.ok(start>=0,`${name} is present in shipped dashboard`);
  const body=script.slice(start).match(/^[\s\S]*?\n}/);
  assert.ok(body,`${name} has a complete body`);
  return vm.runInNewContext(`(${body[0]})`);
}
const isSelectedEvent=helper('isSelectedEvent');
const eventMessage=helper('eventMessage');

test('unscoped and cross-Job SSE events never enter selected feed',()=>{
  const job={id:'721'};
  assert.equal(isSelectedEvent({task_id:'2259'},job,null),false);
  assert.equal(isSelectedEvent({job_id:'720',task_id:'2259'},job,null),false);
  assert.equal(isSelectedEvent({job_id:'721',task_id:'2259'},null,null),false);
  assert.equal(isSelectedEvent({job_id:'721',task_id:'2259'},job,null),true);
  assert.equal(isSelectedEvent({job_id:'721',task_id:'2259'},job,'2259'),true);
  assert.equal(isSelectedEvent({job_id:'721',task_id:'2258'},job,'2259'),false);
});

test('Editor progress is summarized with phase, real frame counts, and next step',()=>{
  const message=eventMessage({type:'task.progress',message:'task.progress',
    data:{phase:'editor-rough-render',evidence:{framesRendered:704,framesTotal:2464},
      next:'Inspect full MP4'}});
  assert.match(message,/editor-rough-render/);
  assert.match(message,/704 \/ 2464 frames/);
  assert.match(message,/Inspect full MP4/);
  assert.doesNotMatch(message,/^task.progress$/);
});
