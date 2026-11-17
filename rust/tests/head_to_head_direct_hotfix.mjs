// New head-to-head Rust2 tests for Node src/router-rules.ts and src/workflow/contracts.ts, exercising identical inputs and errors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseRouterRules, appendRoutingInstruction, appendAgentModelPreference,
} from '../../dist/router-rules.js';
import {
  WORKFLOW_EVENT_NAMES, WORKFLOW_FACT_NAMES, WORKFLOW_MUTATION_NAMES,
  WORKFLOW_EFFECT_NAMES, WORKFLOW_EFFECT_POLICIES,
  workflowEffectFailureEvent, classifyWorkflowActions, emptyWorkflowDecision,
} from '../../dist/workflow/contracts.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const rustBinary = resolve(root, 'rust/target/debug/relay-rust2-parity');
const cases = [];
for (const text of [
  '', '\n', 'legacy free text', '[choices]', '[routing-instruction]',
  '[choices]\nopenai: gpt-6 high, gpt-6 medium\n[ routing-instruction]',
  '[choices]\nopenai: gpt-6 high, gpt-6 high\nopenai: gpt-6 high',
  '[choices]\nopenai: gpt-6 high, sol medium\n[Routing-Instruction]\n Prefer exact\n\n',
  '[choices]\nworker/one::zai:glm-5.3@HIGH\nworker/one::zai:glm-5.3@high',
  '[choices]\n  # comment\nopenai: gpt-5.6 high, sol medium\n z.ai: glm-5.3-flash medium',
  '[choices]\r\nopenai: gpt-5.6 high\r\n[routing-instruction]\r\n A \r\n\t\r\n',
  ' [routing-instruction] \nfoo\n[routing-instruction]\nbar',
  '[choices]\nopenai: model extra ignored-word\nmodel::provider:model@HiGh',
  '[CHOICES]\nopenai: a HIGH\n[other]\nopenai: ignored\n[choices]\nopenai: b low',
  '[routing-instruction]\n\uFEFFLeading BOM\u00A0\nTrailing\t \n',
  '[routing-instruction]\r\n\r\n  foo\r\nbar\n[other]\ntext',
  '[choices]\nopenai: 🦄 unicorn\nopenai: model\u00A0high',
  '[choices]\nfoo: gpt-6 high, , baz\nworker::zai:glm@high',
  ' 	[choices]	\r\nfoo: x\r\n[other]\r\n[routing-instruction]\r\n hello',
  ' [choices]\nx: y\n[RouTing-InStruction]\nKeep\n[other]\n ignore',
  '%% comment\n[routing-instruction]\n x\n\n\n',
]) cases.push({op:'parseRouterRules',text});

// Deliberately distinguish JS Unicode whitespace from Rust regex Unicode
// whitespace, including U+0085 and FEFF, and JS multiline U+2028/U+2029.
for(const space of ['\u00A0','\u1680','\u2003','\u2028','\u2029','\u202F','\u205F','\u3000','\uFEFF','\u0085','\u001C']) {
  for(const text of [
    `[choices]\n${space}foo: model high`, `[choices]\nfoo${space}:${space}model high`,
    `[choices]\nfoo:${space}model${space}HIGH`, `[choices]\nfoo: model${space} HIGH`,
    `${space}[choices]${space}\nfoo: model`, `[choices]\nfoo: model\n${space}[routing-instruction]${space}\nHi`,
    `[choices]\nfoo: model\n[Routing-Instruction]\n${space}hi${space}`,
  ]) cases.push({op:'parseRouterRules',text});
}
// Seeded pseudorandom corpus; intentionally mixes valid/invalid legacy syntax.
let seed = 0x927a6b13;
function randint(max) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; }
const parts = [
  '[choices]','[ROUTING-INSTRUCTION]','[other]','[routing-instruction]',
  'openai: gpt-6 high, sol medium', 'model::zai:glm@high',
  'openai: \u00A0gpt-6 HIGH ', ' x: model', 'a: b low',
  '', '  ', ' # a comment', 'm:m', 'not a route', 'fake: x, y, z',
  'worker::provider:model@HIGH', '# comment', 'a: B LoW',
  'X: model \u3000extra', 'provider: model extra words',
];
for(let i=0;i<1400;i++) {
  let text='';
  for(let n=0,cap=1+randint(14);n<cap;n++) text += parts[randint(parts.length)] + (randint(4)===0?'\r\n':'\n');
  cases.push({op:'parseRouterRules',text});
}
for(const question of ['', 'Original question', '中文问题', 'Question\n\n']) {
  for(const instruction of ['', 'instruction', '\n  preserve \t', '中文\r\n\uFEFF']) {
    cases.push({op:'appendRoutingInstruction',question,instruction});
  }
  for(const preference of [undefined,null,{}, {model:'gpt-6'}, {reasoning:'high'}, {model:'gpt-6',reasoning:'HIGH'}, {model:'', reasoning:''}, {model:' sol ',reasoning:' high ' }]) {
    cases.push({op:'appendAgentModelPreference', question, preference});
  }
}
cases.push({op:'workflowContractsInventories'}, {op:'workflowEffectPolicies'});
for(const effect of [...WORKFLOW_EFFECT_NAMES,'not-an-effect']) cases.push({op:'workflowEffectFailureEvent',effect});
for(const reason of ['ambiguous','no_transition']) cases.push({op:'emptyWorkflowDecision',reason});
const names=[...WORKFLOW_MUTATION_NAMES,...WORKFLOW_EFFECT_NAMES];
cases.push({op:'classifyWorkflowActions',actions:[]});
for(const name of names) cases.push({op:'classifyWorkflowActions',actions:[name]});
for(let i=0;i<600;i++) {
  const actions=[];
  for(let j=0,total=randint(12);j<total;j++) actions.push(names[randint(names.length)]);
  cases.push({op:'classifyWorkflowActions',actions});
}
for(const actions of [['bad'],['mutation.notReal'],['effect.unknown'],['mutation.clearError','unknown'],['effect.launchTask','unknown']]) cases.push({op:'classifyWorkflowActions',actions});
function reference(request) {
  try {
    let value;
    switch(request.op) {
      case 'parseRouterRules':value=parseRouterRules(request.text);break;
      case 'appendRoutingInstruction':value=appendRoutingInstruction(request.question,request.instruction);break;
      case 'appendAgentModelPreference':value=appendAgentModelPreference(request.question,request.preference);break;
      case 'workflowContractsInventories':value={events:WORKFLOW_EVENT_NAMES,facts:WORKFLOW_FACT_NAMES,mutations:WORKFLOW_MUTATION_NAMES,effects:WORKFLOW_EFFECT_NAMES};break;
      case 'workflowEffectPolicies':value=WORKFLOW_EFFECT_POLICIES;break;
      case 'workflowEffectFailureEvent':value=workflowEffectFailureEvent(request.effect);break;
      case 'classifyWorkflowActions':value=classifyWorkflowActions(request.actions);break;
      case 'emptyWorkflowDecision':value=emptyWorkflowDecision(request.reason);break;
      default:throw Error('unknown fixture');
    }
    return {ok:true,value:JSON.parse(JSON.stringify(value))};
  } catch(error) { return {ok:false,error:error.message}; }
}

test('router rules and workflow contracts are identical to compiled Node output',()=>{
  const build=spawnSync('cargo',['build','--offline','--manifest-path','rust/Cargo.toml'],{cwd:root,encoding:'utf8',timeout:90000});
  assert.equal(build.status,0,`Rust build failed: ${build.stderr}`);
  const run=spawnSync(rustBinary,[],{input:cases.map(JSON.stringify).join('\n')+'\n',encoding:'utf8',maxBuffer:16*1024*1024});
  assert.equal(run.status,0,`Rust parity CLI failed: ${run.stderr}`);
  const actual=run.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(actual.length,cases.length);
  for(let i=0;i<cases.length;i++) {
    const expected=reference(cases[i]);
    assert.deepStrictEqual(actual[i],expected,`Mismatch case ${i}: ${JSON.stringify(cases[i])}`);
  }
  console.log(`Verified ${cases.length} exact Rust2 direct hotfix Node/Rust fixtures`);
});
