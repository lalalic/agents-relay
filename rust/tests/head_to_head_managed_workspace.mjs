import assert from 'node:assert/strict';
import {spawnSync,execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
const src=resolve(import.meta.dirname,'../..');
const {prepareManagedExecutionWorktree}=await import(pathToFileURL(src+'/dist/workspace.js'));
const bin=src+'/rust/target/debug/relay-rust2-parity';
const root=mkdtempSync(join(tmpdir(),'rust2-managed-git-h2h-'));
const primary=join(root,'repo'),remote=join(root,'upstream.git');
const nodeWorkspace=join(root,'node-workspace'),rustWorkspace=join(root,'rust-workspace');
mkdirSync(primary);mkdirSync(nodeWorkspace);mkdirSync(rustWorkspace);
function git(cwd,...args){return execFileSync('git',['-C',cwd,...args],{encoding:'utf8',timeout:30000,env:{...process.env,GIT_TERMINAL_PROMPT:'0'}}).trim()}
function command(...args){return execFileSync(args[0],args.slice(1),{encoding:'utf8',timeout:30000}).trim()}
function save(name,value){writeFileSync(join(primary,name),value)}
function commit(message){git(primary,'add','.');git(primary,'commit','-q','-m',message);return git(primary,'rev-parse','HEAD');}
function native(input){const run=spawnSync(bin,[],{input:JSON.stringify(input)+'\n',encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024});assert.equal(run.status,0,run.stderr);const parsed=JSON.parse(run.stdout.trim());return parsed.ok?parsed.value.outcome:parsed;}
function clean(value,path){return JSON.stringify(value).replaceAll(nodeWorkspace,'<workspace>').replaceAll(rustWorkspace,'<workspace>').replaceAll(root,'<root>');}
const observations=[];
async function compare(name,params){
 const nodeInput={...params,workspaceRoot:nodeWorkspace};
 const rustInput={op:'workspaceManagedParity',...params,workspaceRoot:rustWorkspace};
 let nodeResult;
 try{nodeResult={ok:true,value:await prepareManagedExecutionWorktree(nodeInput.projectPath,nodeInput.repository,
 nodeInput.prNumber,nodeInput.head,'ignored',nodeInput.workspaceRoot)};}
 catch(error){nodeResult={ok:false,error:error.message};}
 const rustResult=native(rustInput);
 const n=clean(nodeResult),r=clean(rustResult);
 observations.push({name,node:nodeResult,rust:rustResult,match:n===r});
 if(n!==r){console.log('DIFF',name,JSON.stringify({node:nodeResult,rust:rustResult}).slice(0,4200));}
 return {nodeResult,rustResult};
}
try{
 command('git','init','--bare','-q','--initial-branch=main',remote);
 git(primary,'init','-q','--initial-branch=main');git(primary,'config','user.email','h2h@example.invalid');git(primary,'config','user.name','Node Rust differential');
 save('readme.txt','first commit\n');commit('main init');
 git(primary,'remote','add','origin','file://'+remote);git(primary,'push','-q','origin','main');
 git(primary,'checkout','-q','-b','feature');save('feature.txt','feature-1\n');let head=commit('feature one');git(primary,'push','-q','origin','feature');
 git(primary,'checkout','-q','main');
 git(primary,'remote','set-url','origin','https://github.com/fixture/repo.git');
 git(primary,'config','url.file://'+remote+'.insteadOf','https://github.com/fixture/repo.git');
 assert.equal(git(primary,'config','--get','remote.origin.url'),'https://github.com/fixture/repo.git');
 // Explicit fetch rewrites to local bare; no GitHub network access is possible.
 git(primary,'fetch','-q','origin','refs/heads/feature:refs/remotes/origin/feature');
 const args=(additional={})=>({projectPath:primary,repository:'fixture/repo',prNumber:23,head:{ref:'feature',sha:head},...additional});
 await compare('first checkout',args());
 const nodeCheckout=join(nodeWorkspace,'.worktrees','agents-relay','fixture-repo-pr-23','job');
 const rustCheckout=join(rustWorkspace,'.worktrees','agents-relay','fixture-repo-pr-23','job');
 assert(existsSync(nodeCheckout)&&existsSync(rustCheckout));
 await compare('idempotent same SHA',args());
 mkdirSync(join(primary,'nested'));
 await compare('nested project prefix',args({projectPath:join(primary,'nested')}));
 await compare('incorrect Github origin identity',args({repository:'evil/repo'}));
 await compare('immutable SHA mismatch',args({head:{ref:'feature',sha:'a'.repeat(40)}}));
 await compare('PR 0 invalid checkout identity',args({prNumber:0}));
 await compare('bad repository syntax',args({repository:'bad'}));
 // Fast-forward remote feature from primary: old worktree SHA is an ancestor.
 git(primary,'checkout','-q','feature');save('feature.txt','feature-2\n');head=commit('feature two');git(primary,'push','-q','origin','feature');git(primary,'checkout','-q','main');
 await compare('clean fast-forward',args());
 assert.equal(git(nodeCheckout,'rev-parse','HEAD'),head);
 assert.equal(git(rustCheckout,'rev-parse','HEAD'),head);
 // Dirty checkout is never reset/overwritten by a newer remote PR SHA.
 writeFileSync(join(nodeCheckout,'untracked-test.txt'),'keep');
 writeFileSync(join(rustCheckout,'untracked-test.txt'),'keep');
 git(primary,'checkout','-q','feature');save('feature.txt','feature-3\n');head=commit('feature three');git(primary,'push','-q','origin','feature');git(primary,'checkout','-q','main');
 await compare('dirty checkout rejects ahead SHA',args());
 assert.equal(readFileSync(join(nodeCheckout,'untracked-test.txt'),'utf8'),'keep');
 assert.equal(readFileSync(join(rustCheckout,'untracked-test.txt'),'utf8'),'keep');
 rmSync(join(nodeCheckout,'untracked-test.txt'));rmSync(join(rustCheckout,'untracked-test.txt'));
 // Distinct local commits diverge independently; do not overwrite those commits.
 for(const checkout of [nodeCheckout,rustCheckout]){
  writeFileSync(join(checkout,'local-only.txt'),'KEEP-'+checkout);
  git(checkout,'add','.');git(checkout,'commit','-q','-m','unique local decision');
 }
 await compare('local commits preserve non-ff history',args());
 assert(existsSync(join(nodeCheckout,'local-only.txt')) && existsSync(join(rustCheckout,'local-only.txt')));
 console.log('OBSERVED',JSON.stringify(observations.map(({name,match})=>({name,match}))));
 assert(observations.every(x=>x.match),'Some Node/Rust managed worktree scenarios differed');
 console.log('DIRECT_NODE_RUST_WORKSPACE_MANAGED_PASS',observations.length);
}finally{rmSync(root,{force:true,recursive:true});}
