// Supplemental differential for src/outcome-review.ts reviewerContract and
// parseOutcomeReviewArgs over real filesystem layouts (agents directories
// with real marker files), closing the "full agent resolver" gap recorded in
// the ledger row. No Codex CLI, no model request, no live account.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseOutcomeReviewArgs,reviewerContract,combineOutcomeReviews}
  from '../../dist/outcome-review.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');

async function parity(request){
  return await new Promise((resolvePromise,reject)=>{
    const child=spawn(binary,[],{cwd:root});
    let out='',err='';
    child.stdout.on('data',c=>out+=c);
    child.stderr.on('data',c=>err+=c);
    child.on('error',reject);
    child.on('close',code=>{
      if(code!==0)return reject(new Error(err||`parity exited ${code}`));
      try{
        const parsed=JSON.parse(out.trim());
        if(!parsed.ok)throw new Error('parity error: '+parsed.error);
        resolvePromise(parsed.value);
      }catch(e){reject(new Error(`parity JSON: ${e.message}: ${out.slice(0,300)}`));}
    });
    child.stdin.end(JSON.stringify(request)+'\n');
  });
}
test('reviewerContract resolution and arg parsing over real layouts',async()=>{
  const ROOT=root;
  const cases=[];
  // Real layered layout: project reviewer, workspace reviewer, and a
  // name only present in the Relay root agents directory.
  const workspace=mkdtempSync(join(tmpdir(),'rust2-or-ws-'));
  const project=join(workspace,'proj');
  mkdirSync(join(project,'agents'),{recursive:true});
  writeFileSync(join(project,'agents','security.agent.md'),'# security reviewer');
  mkdirSync(join(workspace,'agents'),{recursive:true});
  writeFileSync(join(workspace,'agents','compliance.agent.md'),'# compliance');
  const builtinReviewer=join(ROOT,'agents','outcome-reviewer.agent.md');
  cases.push({method:'contract',name:'reviewer',projectPath:project,
    workspaceRoot:workspace,root:ROOT,expectExists:true});
  cases.push({method:'contract',name:'security',projectPath:project,
    workspaceRoot:workspace,root:ROOT,expectExists:true});
  cases.push({method:'contract',name:'compliance',projectPath:project,
    workspaceRoot:workspace,root:ROOT,expectExists:true});
  cases.push({method:'contract',name:'nonexistent-reviewer',projectPath:project,
    workspaceRoot:workspace,root:ROOT,expectExists:false});
  // project reviewer wins over a same-name workspace file
  mkdirSync(join(workspace,'agents'),{recursive:true});
  writeFileSync(join(workspace,'agents','security.agent.md'),'# workspace copy');
  cases.push({method:'contract',name:'security',projectPath:project,
    workspaceRoot:workspace,root:ROOT,expectExists:true,
    preferProject:true,projectMarker:'# security reviewer'});
  // Arg parsing over the same layout
  const promptFile=join(project,'request.txt');
  writeFileSync(promptFile,'inspect the fixture evidence');
  const argsCases=[
    {args:['--prompt','review this'],expect:'ok'},
    {args:['--prompt','x','--prompt-file','y'],expect:'err'},
    {args:['--prompt-file','request.txt'],expect:'ok'},
    {args:[],expect:'err'},
    {args:['--prompt','  '],expect:'err'},
    {args:['--prompt','ok','--agents','reviewer,security'],expect:'ok'},
    {args:['--prompt','ok','--agents','reviewer,9bad'],expect:'err'},
    {args:['--prompt','ok','--agents','reviewer,UPPER'],expect:'err'},
    {args:['--prompt','ok','--agents','reviewer,reviewer'],expect:'ok-dedup'},
    {args:['--prompt','ok','--output','out.json'],expect:'ok-output'},
    {args:['--prompt','ok','--project-path',project],expect:'ok'},
    {args:['--prompt','ok','--unknown','x'],expect:'err'},
    {args:['--prompt','ok','--agents'],expect:'err'},
    {args:['--prompt'],expect:'err'},
    {args:['--prompt','ok','--prompt-file'],expect:'err'},
  ];
  const results=[];
  const expected=[];
  for(const fixture of cases){
    let want;
    try{
      const found=reviewerContract(fixture.name,fixture.projectPath,
        fixture.workspaceRoot,fixture.root);
      const content=readFileSync(found,'utf8');
      want={ok:true,exists:true,
        isProject:content.includes('# security reviewer')};
    }catch(error){
      want={ok:false,error:error?.message??String(error)};
    }
    expected.push(want);
    results.push(await parity({op:'certOutcomeReview',method:'contract',
      name:fixture.name,projectPath:fixture.projectPath,
      workspaceRoot:fixture.workspaceRoot}));
  }
  for(const fixture of argsCases){
    let want;
    try{
      const opts=parseOutcomeReviewArgs(fixture.args,project);
      want={ok:true,
        prompt:opts.prompt.slice(0,40),
        reviewers:opts.reviewers,
        projectPath:opts.projectPath,
        output:opts.output===undefined?null:opts.output};
    }catch(error){
      want={ok:false,error:error?.message??String(error)};
    }
    expected.push(want);
    results.push(await parity({op:'certOutcomeReview',method:'parseArgs',
      args:fixture.args,cwd:project}));
  }
  // combineOutcomeReviews verdict precedence
  const combineCases=[
    [{reviewer:'a',verdict:'PASS',findings:[],evidence:[]}],
    [{reviewer:'a',verdict:'PASS',findings:[],evidence:[]},
     {reviewer:'b',verdict:'CHANGE_REQUIRED',findings:[],evidence:[]}],
    [{reviewer:'a',verdict:'CHANGE_REQUIRED',findings:[],evidence:[]},
     {reviewer:'b',verdict:'BLOCKED',findings:[],evidence:[]}],
    [{reviewer:'a',verdict:'BLOCKED',findings:[],evidence:[]},
     {reviewer:'b',verdict:'PASS',findings:[],evidence:[]}],
    [{reviewer:'a',verdict:'PASS',findings:[1],evidence:['x']},
     {reviewer:'b',verdict:'PASS',findings:[],evidence:[]}],
  ];
  for(const reviews of combineCases){
    expected.push({ok:true,value:combineOutcomeReviews(reviews)});
    results.push(await parity({op:'certOutcomeReview',method:'combine',
      reviews}));
  }
  const failures=[];
  for(let i=0;i<expected.length;i++){
    const want=expected[i],got=results[i];
    const norm=v=>JSON.parse(JSON.stringify(v).replaceAll(workspace,'<ws>')
      .replaceAll(project,'<proj>').replaceAll(tmpdir(),'<tmp>')
      .replaceAll(ROOT,'<root>'));
    if(JSON.stringify(norm(want))!==JSON.stringify(norm(got)))
      failures.push([i,norm(want),norm(got)]);
  }
  for(const [i,want,got] of failures.slice(0,8))
    console.log('OR_DIFF',i,JSON.stringify(want).slice(0,200),
      JSON.stringify(got).slice(0,200));
  assert.deepEqual(failures.map(f=>f[0]),[],
    `${failures.length} outcome-review mismatches`);
  rmSync(workspace,{recursive:true,force:true});
  console.log('Verified',expected.length,
    'original Node/Rust outcome-review resolver/arg cases');
});
