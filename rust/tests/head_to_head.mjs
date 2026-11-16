// New differential suite: run identical fixtures against real Node src output and rust2, rejecting all mismatches.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { deriveTaskTitle } from '../../dist/task-title.js';
import { requiredPlannerTaskTitle } from '../../dist/planner-task-title.js';
import { validateDependencyValidity } from '../../dist/dependency-validity.js';
import { terminalRecoveryEligible, terminalRecoveryPrompt } from '../../dist/terminal-event-recovery.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const rustBinary = resolve(root, 'rust/target/debug/relay-rust2-parity');
const ready = {hasSession:true,hasThread:true,terminalObserved:false,recoveryAttempts:0,outcomeUncertain:false,cancelled:false};
const cases = [];
for (const input of [
  '', '  \n \t', '# My Title', '###### Heading', '####### Heading', '#NoWhitespace',
  '- alpha', '*  alpha', '+\talpha', '1. alpha', '12)  alpha', '01) alpha',
  '# - Example', '### 13) List title', '- 4. Nested item',
  '\r\n \nMy First Title\n My Second Title',
  'Heading\u00a0with\u2003different\twhitespace', '\ufeffLeading and trailing\u3000',
  'Line\u0085separator', '日本語の見出しは長い文字列',
  'X'.repeat(96), 'X'.repeat(97), 'X'.repeat(93) + '\t'.repeat(8) + 'X',
  '😀'.repeat(60), 'x'.repeat(92) + '😀' + 'longer title',
  '𐀀'.repeat(50), '# ' + 'a'.repeat(100), '#'.repeat(7) + ' words',
]) cases.push({op:'deriveTaskTitle',input});
for (const fallback of ['Untitled', '', 'Fallback '+ 'x'.repeat(98), '😀'.repeat(50)]) {
  cases.push({op:'deriveTaskTitle',input:'\n',fallback});
}
for (const value of [null, false, 10, {}, '', '   ', 'one two three four',
  'one two three four five', 'one two three four five six seven eight',
  'one two three four five six seven eight nine',
  '  one\u00a0two\tthree  four\ufefffive  ',
  '一个 二个 三个 四个 五个', '\u0085one two three four five',
]) cases.push({op:'requiredPlannerTaskTitle',value,index:7});
for (const value of [null, [], false, 42, 'text', {},
  {a:'order-only'}, {a:'rerun',b:'revalidate'}, {a:'bad'}, {c:'rerun'},
  {a:undefined}, {a:null}, {a:1}, {a:{}},
  JSON.parse('{"__proto__":"rerun"}'),
  JSON.parse('{"b":"bad","a":"bad"}'),
  JSON.parse('{"2":"bad","1":"bad"}'),
]) cases.push({op:'validateDependencyValidity',dependencies:['a','b','__proto__'],value});
cases.push({op:'validateDependencyValidity',dependencies:['a'],value:{a:'rerun'},field:'customPolicy'});
cases.push({op:'validateDependencyValidity',dependencies:['a','b'],value:JSON.parse('{"b":"bad","a":"bad"}')});
cases.push({op:'validateDependencyValidity',dependencies:['1','2'],value:JSON.parse('{"2":"bad","1":"bad"}')});
cases.push({op:'validateDependencyValidity',dependencies:['a'],value:{c:'rerun'},field:'customPolicy'});
for (const recoveryAttempts of [-3, -1, 0, 0.5, 0.9999, 1, 2, 12]) {
  for (let bits=0;bits<32;bits++) {
    const facts={...ready,recoveryAttempts};
    ['hasSession','hasThread','terminalObserved','outcomeUncertain','cancelled'].forEach((field,i)=>facts[field]=Boolean(bits & (1<<i)));
    cases.push({op:'terminalRecoveryEligible',facts});
  }
}
for (const executionId of ['', 'exec-original', '中文-exec-1', 'a/b/c', '"quoted"']) cases.push({op:'terminalRecoveryPrompt',executionId});

function nodeReference(request) {
  try {
    let value;
    switch(request.op) {
      case 'deriveTaskTitle': value=deriveTaskTitle(request.input,request.fallback);break;
      case 'requiredPlannerTaskTitle': value=requiredPlannerTaskTitle(request.value,request.index);break;
      case 'validateDependencyValidity': value=validateDependencyValidity(request.dependencies,request.value,request.field);break;
      case 'terminalRecoveryEligible': value=terminalRecoveryEligible(request.facts);break;
      case 'terminalRecoveryPrompt': value=terminalRecoveryPrompt(request.executionId);break;
      default: throw new Error('unrecognized op');
    }
    return {ok:true,value:value??null};
  }catch(e){return {ok:false,error:e.message};}
}

test('four direct Node source ports produce matching results and errors',()=>{
  const build=spawnSync('cargo',['build','--offline','--manifest-path','rust/Cargo.toml'],{cwd:root,encoding:'utf8',timeout:90000});
  assert.equal(build.status,0,`Rust build failed: ${build.stderr}`);
  const input=cases.map(item=>JSON.stringify(item)).join('\n')+'\n';
  const result=spawnSync(rustBinary,[],{input,encoding:'utf8',maxBuffer:1024*1024,timeout:30000});
  assert.equal(result.status,0,`Rust CLI failed: ${result.stderr}`);
  const rustLines=result.stdout.trim().split('\n');
  assert.equal(rustLines.length,cases.length);
  for(let i=0;i<cases.length;i++) {
    const actual=JSON.parse(rustLines[i]);
    const expected=nodeReference(JSON.parse(JSON.stringify(cases[i])));
    assert.deepStrictEqual(actual,expected,`Mismatch in case ${i}: ${JSON.stringify(cases[i])}`);
  }
  console.log(`Verified ${cases.length} exact Node/Rust differential cases (including errors, Unicode, and recovery guards).`);
});
