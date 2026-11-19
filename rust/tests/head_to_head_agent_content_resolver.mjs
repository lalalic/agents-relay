// Direct Node/Rust differential for src/agent-content-resolver.ts: layered Markdown Agents, strict parent inheritance and source-relative links.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {agentSourceLayers,resolveAgentMarkdown} from '../../dist/agent-content-resolver.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const binary=resolve(root,'rust/target/debug/relay-rust2-parity');
let built=false;
function rust(request){
 if(!built){const build=spawnSync('cargo',['build','--offline','--manifest-path','rust/Cargo.toml'],{cwd:root,encoding:'utf8',timeout:90000});assert.equal(build.status,0,build.stderr);built=true;}
 const out=spawnSync(binary,[],{input:JSON.stringify(request)+'\n',encoding:'utf8',timeout:9000,maxBuffer:3*1024*1024});
 assert.equal(out.status,0,`${out.error}: ${out.stderr}`);
 return JSON.parse(out.stdout.trim());
}
function refSync(callback){try{return {ok:true,value:callback()}}catch(error){return {ok:false,error:error.message}}}
async function refAsync(callback){try{return {ok:true,value:await callback()}}catch(error){return {ok:false,error:error.message}}}
let seed=0x19a8e7b5;
function rand(n){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed % n}
const choose=items=>items[rand(items.length)];
function temp(){return mkdtempSync(join(tmpdir(),'rust2-agent-resolver-'))}
function write(root,relative,contents){const file=join(root,relative);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,contents);return file}
const base='---\nname: planner\nrole: test\n---\n# Planner\n## A\nOriginal A\n### G\nOriginal G\n## B\nOriginal B\n## C\nOriginal C';
const local='---\nname: planner\nextends: planner\nmode: extend\n---\n# More\nProject notes';

test('source hierarchy path resolution preserves Node order/deduplication',()=>{
 const fixtures=[];
 for(let i=0;i<500;i++){
  const projectPath=choose(['/tmp/project/subdir','./project','/tmp/a/b/c','../outside','/Users/example/work/a/b/project','/tmp/project/../outside','.']);
  const options={globalRoot:choose([undefined,'/global','/tmp/a/b','/tmp/project/subdir']),
    workspaceRoot:choose([undefined,'/tmp','/tmp/a','/Users/example/work','/tmp/project/subdir','/elsewhere'])};
  fixtures.push({op:'agentSourceLayers',projectPath,options});
 }
 for(const [index,req] of fixtures.entries()){
  assert.deepEqual(rust(req),refSync(()=>agentSourceLayers(req.projectPath,req.options)),`Layer ${index} ${JSON.stringify(req)}`);
 }
 console.log(`Verified ${fixtures.length} exact hierarchy path and deduplication cases`);
});

const scenarios=[
 {label:'builtin only'},
 {label:'local standalone',local:'---\nname: planner\n---\n# Local\nIndependent'},
 {label:'local plain markdown no frontmatter',local:'# Local\nNo metadata'},
 {label:'relay extend simple',local},
 {label:'relay replace whole',local:'---\nname: planner\nextends: planner\nmode: replace\n---\n# New Rules\nOnly local'},
 {label:'nested replace and extend',local:'---\nname: planner\nextends: planner\nsections:\n  replace: [Planner/A/G]\n  extend: [Planner/B]\n---\n# Planner\n## A\n### G\nChanged G\n## B\nAdded B'},
 {label:'no extends with sections',local:'---\nname: planner\nsections:\n  replace: [Planner/A]\n---\n# Planner\n## A\nChanged'},
 {label:'conflicting section actions',local:'---\nname: planner\nextends: planner\nsections:\n  replace: [Planner/B]\n  extend: [Planner/B]\n---\n# Planner\n## B\nChanged'},
 {label:'replace missing base section',local:'---\nname: planner\nextends: planner\nsections:\n  replace: [Planner/Missing]\n---\n# Planner\n## Missing\nChanged'},
 {label:'extend missing overlay section',local:'---\nname: planner\nextends: planner\nsections:\n  extend: [Planner/B]\n---\n# Planner\n## Other\nChanged'},
 {label:'mode replace with sections forbidden',local:'---\nname: planner\nextends: planner\nmode: replace\nsections:\n  replace: [Planner/A]\n---\n# Planner\n## A\nNew'},
 {label:'invalid mode',local:'---\nname: planner\nextends: planner\nmode: append\n---\n# Invalid'},
 {label:'invalid name',local:'---\nname: other\n---\n# Invalid'},
 {label:'invalid parent',local:'---\nname: planner\nextends: sibling/notallowed\n---\n# Invalid'},
 {label:'invalid namespaced parent',local:'---\nname: planner\nextends: invalid/planner\n---\n# Missing'},
 {label:'workspace parent with same name',workspace:'---\nname: planner\n---\n# Shared\nShared rules',local:'---\nname: planner\nextends: planner\n---\n# Project\nExtra',workspaceEnabled:true},
 {label:'workspace parent with other name',workspaceOther:'---\nname: common\n---\n# Shared common\nReusable rules',local:'---\nname: planner\nextends: common\n---\n# Project\nExtra',workspaceEnabled:true},
 {label:'cross-name workspace no root',local:'---\nname: planner\nextends: common\n---\n# Project\nExtra'},
 {label:'cross-name workspace with self extends',workspaceOther:'---\nname: common\nextends: common\n---\n# Bad',local:'---\nname: planner\nextends: common\n---\n# Project\nExtra',workspaceEnabled:true},
 {label:'external absolute base',external:'---\nname: foundation\n---\n# Foundation\nAbsolute base',local:'---\nname: planner\nextends: ABSOLUTE_PATH\n---\n# Project\nNew lines'},
 {label:'external missing name',external:'# No name\nMissing metadata',local:'---\nname: planner\nextends: ABSOLUTE_PATH\n---\n# Project\nNew lines'},
 {label:'external non-standalone',external:'---\nname: foundation\nextends: foundation\n---\n# Foundation',local:'---\nname: planner\nextends: ABSOLUTE_PATH\n---\n# Project'},
 {label:'external non-markdown',external:'---\nname: foundation\n---\n# Foundation',externalName:'foundation.txt',local:'---\nname: planner\nextends: ABSOLUTE_PATH\n---\n# Project'},
 {label:'source anchored links and code fence',builtin:'---\nname: planner\n---\n# Planner\n[doc](./docs/base.md) [other](https://example.org/a)',
   local:'---\nname: planner\nextends: planner\n---\n# Extra\n[local](../docs/stage.md#review)\n```md\n[no](../docs/do-not-rewrite.md)\n```'},
 {label:'only project without builtin',builtin:null,local:'---\nname: planner\n---\n# Standalone local',noBuiltin:true},
 {label:'missing relay base',builtin:null,local:'---\nname: planner\nextends: invalid/planner\n---\n# Missing',noBuiltin:true},
 {label:'unknown Agent',builtin:null,noBuiltin:true},
 {label:'duplicate headings',local:'---\nname: planner\nextends: planner\nsections:\n  replace: [Planner/B]\n---\n# Planner\n## B\nchanged\n## B\nagain'},
 {label:'nested fencing',local:'---\nname: planner\nextends: planner\nsections:\n  replace: [Planner/B]\n---\n# Planner\n```md\n## B\nfake\n```\n## B\nreal'},
 {label:'quoted scalar fields',local:"---\nname: planner\nextends: 'planner'\nmode: 'extend'\n---\n# Text"},
 {label:'no extends resets inherited metadata',local:'---\nname: planner\nnew: local-only\n---\n# Current'},
 {label:'extension from base duplicate metadata',local:'---\nname: planner\nextends: planner\nrole: changed\n---\n# More'},
];
// Adversarial JS-regex and inheritance boundary cases discovered in review.
scenarios.push(
 {label:'blank line between section controls',local:'---\nname: planner\nextends: planner\nsections:\n\n  replace: [Planner/B]\n---\n# Planner\n## B\nNew B'},
 {label:'three single quotes are not one quote',local:"---\nname: planner\nextends: '''planner'''\n---\n# Different"},
 {label:'subdocument YAML metadata is independent of frontmatter parsing',builtin:'Preamble\n---\nname: planner\nmode: extend\n---\nBody'},
 {label:'BOM as whitespace in relative destination',local:'---\nname: planner\n---\n# Links\n[test](\uFEFFdocs/x.md)\n[spaced](docs\u00A0/file.md)'},
 {label:'next heading has JS BOM whitespace',local:'---\nname: planner\nextends: planner\nsections:\n  replace: [Planner/B]\n---\n# Planner\n##\uFEFFB\nChanged'},
 {label:'no quoted metadata stripping more than one character',local:"---\nname: planner\nflag: '''multiple quotes'''\n---\n# Metadata"},
 {label:'JS nonwhitespace U+0085 in Markdown link destination',local:'---\nname: planner\n---\n# Markdown\n[doc](doc\u0085file.md)'},
 {label:'BOM before fenced block',local:'---\nname: planner\n---\n# Markdown\n\uFEFF```\n[doc](relative.md)\n\uFEFF```\n[real](actual.md)'},
 {label:'legacy planner.md fallback',builtinName:'planner.md',localName:'agents/planner.md',local:'---\nname: planner\nextends: planner\n---\n# Another'},
);
async function fixtureScenario(scenario,number){
 const dir=temp(),builtins=join(dir,'builtins'),project=join(dir,'project'),workspace=join(dir,'workspace');
 mkdirSync(builtins,{recursive:true});mkdirSync(join(project,'agents'),{recursive:true});mkdirSync(join(workspace,'agents'),{recursive:true});
 const builtinName=scenario.builtinName??'planner.agent.md';
 if(!scenario.noBuiltin)write(builtins,builtinName,scenario.builtin??base);
 if(scenario.workspace)write(workspace,'agents/planner.agent.md',scenario.workspace);
 if(scenario.workspaceOther)write(workspace,'agents/common.agent.md',scenario.workspaceOther);
 if(scenario.local!==undefined){
  let contents=scenario.local;
  if(contents.includes('ABSOLUTE_PATH')){
   const externalName=scenario.externalName??'external.md';
   const file=write(dir,externalName,scenario.external??'---\nname: foundation\n---\n# Foundation');
   contents=contents.replace('ABSOLUTE_PATH',file);
  }
  write(project,scenario.localName??'agents/planner.agent.md',contents);
 }
 if(scenario.symlinkEscape){
  const fs=await import('node:fs');
  fs.rmSync(join(project,'agents','planner.agent.md'));
  symlinkSync(join(builtins,builtinName),join(project,'agents','planner.agent.md'));
 }
 const opts={name:scenario.agentName??'planner',builtinsRoot:builtins,contextRoot:project,
   ...(scenario.workspaceEnabled?{layers:agentSourceLayers(project,{workspaceRoot:workspace})}:{})};
 try{
  const expected=await refAsync(()=>resolveAgentMarkdown(opts.name,opts.builtinsRoot,opts.contextRoot,opts.layers));
  const actual=rust({op:'resolveAgentMarkdown',...opts});
  assert.deepEqual(actual,expected,`Scenario ${number}: ${scenario.label}`);
 }finally{rmSync(dir,{recursive:true,force:true})}
}
test('Markdown inheritance, sections, metadata and link sources match Node on true temporary directory fixtures',async()=>{
 let checked=0;
 for(const scenario of scenarios){await fixtureScenario(scenario,checked++);}
 await fixtureScenario({label:'symlink context escape',symlinkEscape:true,local:'# Temporary'},checked++);
 // Randomized allowed inheritance shapes and document layout permutations.
 for(let i=0;i<210;i++){
  const section=choose(['Planner/A','Planner/A/G','Planner/B','Planner/C','Planner/Missing']);
  const action=choose(['extend','replace']);
  const from=choose(['planner','common','invalid/a']);
  const body=choose(['# Planner\n## A\n### G\nNew G\n## B\nNew B\n## C\nNew C',
   '# Planner\n## B\nNew content', '# Other\n## Title\nContent']);
  const local=`---\nname: planner\nextends: ${from}\nsections:\n  ${action}: [${section}]\n---\n${body}`;
  await fixtureScenario({label:`random-${i}`,local,workspaceEnabled:rand(2)===0,workspace:'# Shared\nAvailable'},checked++);
 }
 console.log(`Verified ${checked} independent real-filesystem Agent inheritance/section cases`);
});

test('multi-level global/workspace/parent/project precedence and metadata match Node',async()=>{
 let verified=0;
 for(let i=0;i<120;i++){
  const dir=temp();
  try{
   const builtin=join(dir,'builtin'),globalRoot=join(dir,'global'),workspace=join(dir,'workspace'),
     project=join(workspace,'teams','sample');
   const options={globalRoot,workspaceRoot:workspace};
   const layers=agentSourceLayers(project,options);
   write(builtin,'planner.agent.md','---\nname: planner\norigin: builtin\n---\n# Root\nOriginal rules');
   const localBody=choose(['# Global\nGlobal instructions','# Visioner\nShared instructions','# Local\nProject instructions']);
   if(rand(4)!==0){
    write(globalRoot,'agents/planner.agent.md',`---\nname: planner\norigin: global\nextends: planner\n---\n${localBody}`);
   }
   for(const [root,tag] of [[workspace,'workspace'],[join(workspace,'teams'),'parent'],[project,'project']]){
    if(rand(4)===0)continue;
    const extend=choose(['','extends: planner\n']);
    write(root,'agents/planner.agent.md',`---\nname: planner\norigin: ${tag}\n${extend}---\n# ${tag}\n${tag} rules\n[doc](./docs/context.md)`);
   }
   const request={op:'resolveAgentMarkdown',name:'planner',builtinsRoot:builtin,contextRoot:project,layers};
   const expected=await refAsync(()=>resolveAgentMarkdown('planner',builtin,project,layers));
   const actual=rust(request);
   assert.deepEqual(actual,expected,`Multi-layer ${i}`);
   verified++;
  }finally{rmSync(dir,{recursive:true,force:true})}
 }
 console.log(`Verified ${verified} multi-layer real filesystem Agent snapshots`);
});
