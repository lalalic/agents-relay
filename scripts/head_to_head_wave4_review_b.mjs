// Worker B: originals from compiled Node TS vs an independent Rust binary.
// Uses a disposable RELAY store and seeded adversarial review fixtures.
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const tmp=mkdtempSync(path.join(os.tmpdir(),'rust2-wave4-review-b-'));
process.env.AGENTS_RELAY_STORE_DIR=tmp;
const review=await import('../dist/review-replan.js');
const thread=await import('../dist/reviewer-thread.js');
const outcome=await import('../dist/outcome-review.js');
let seed=198419;
const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296};
const pick=a=>a[Math.floor(rand()*a.length)];
const ops=[];
const runNode=async v=>{
  try {
    const fn=({reviewWorkSettled:review.reviewWorkSettled,reviewNeedsReplan:review.reviewNeedsReplan,
      reviewPlanReady:review.reviewPlanReady,parseOutcomeReviewArgs:outcome.parseOutcomeReviewArgs,
      combineOutcomeReviews:outcome.combineOutcomeReviews,
      resolveReviewerThreadDestination:thread.resolveReviewerThreadDestination,
      resolveImplementationThreadDestination:thread.resolveImplementationThreadDestination,
      resolveImplementationTaskThreadDestination:thread.resolveImplementationTaskThreadDestination,
      normalizeThreadId:thread.normalizeThreadId,
      prepareReviewerThreadDelivery:thread.prepareReviewerThreadDelivery,
      chatgptThreadRequirements:thread.chatgptThreadRequirements,
      runtimeReviewer:thread.runtimeReviewer,
      prepareRevisionThreadDelivery:thread.prepareRevisionThreadDelivery})[v.op];
    let x;
    switch(v.op){
      case 'reviewWorkSettled': case 'reviewNeedsReplan': case 'reviewPlanReady': x=fn(v.job);break;
      case 'parseOutcomeReviewArgs':x=fn(v.args,v.cwd);break;
      case 'combineOutcomeReviews':x=fn(v.reviews);break;
      case 'resolveImplementationThreadDestination':x=fn(v.job);break;
      case 'resolveImplementationTaskThreadDestination': x=fn(v.job,v.task);break;
      case 'normalizeThreadId':x=fn(v.value,v.label);break;
      case 'resolveReviewerThreadDestination': x=fn(v.job,v.override);break;
      case 'prepareReviewerThreadDelivery': x=fn(v.job,v.task,v.override);break;
      case 'chatgptThreadRequirements': x=fn(v.configured);break;
      case 'runtimeReviewer': x=fn(v.args);break;
      case 'prepareRevisionThreadDelivery':{const task=structuredClone(v.task);x={result:fn(v.job,task)??null,task};break;}
    }
    return {ok:true,value:x??null};
  } catch(e) { return {ok:false,error:e.message} }
};
const caseOf=(op,job={},task={})=>({op,job,task,graph:path.resolve('workflow')});
for(let i=0;i<1000;i++){
  const state=()=>pick(['SUCCEEDED','CANCELLED','FAILED','RUNNING','QUEUED','BLOCKED','DRAFT']);
  const tasks=Array.from({length:Math.floor(rand()*10)},(_,j)=>({
    id:`${j+1}`,kind:pick(['work','planner']),agentName:pick(['worker','implementation','final-review','reviewer','troubleshooter',null]),state:state(),
    attempt:Math.floor(rand()*5),maxAttempts:pick([0,1,3,5]),parentTaskId:`${Math.floor(rand()*10)+1}`,
    recoveryForAttempt:pick([-1,0,1,3,5]), resolution:{state:pick(['active','waiting','resolved','closed',''])}
  }));
  const plans=Array.from({length:Math.floor(rand()*5)},(_,j)=>({id:`${j}`,status:pick(['FAILED','SUCCEEDED','PLANNING','DRAFT']),
    trigger:{source:pick(['review','initial','manual']),reviewTaskId:pick(['r','q'])},generatedTaskIds:pick([[],['1'],['2'],['1','2']])}));
  const job={id:'test',title:'test',repository:'x',projectRoot:tmp,headSha:'abc',state:'ACTIVE',tasks,plans,
    review:pick([undefined,{taskId:'r',outcome:'changes_required',revisionDisposition:pick(['targeted','replan'])},
      {taskId:'r',outcome:'stale',revisionDisposition:'replan'}, {taskId:'q',outcome:'started'}]),
    reviewRevisionRounds:pick([[],[{reviewTaskId:'r',status:'changes_required'}], [{reviewTaskId:'q',status:'changes_required'}]])};
  for(const op of ['reviewWorkSettled','reviewNeedsReplan','reviewPlanReady'])ops.push(caseOf(op,job));
}
// Directed review-settlement cases force positive, retry, reopen and active barriers.
for (let i=0; i<800; i++) {
  const primary={id:'1',kind:'work',agentName:'implementation',state:pick(['SUCCEEDED','FAILED','CANCELLED']),attempt:pick([0,1,2,3]),maxAttempts:3};
  const child={id:'2',kind:'work',agentName:'troubleshooter',parentTaskId:'1',state:pick(['SUCCEEDED','CANCELLED','FAILED','QUEUED','BLOCKED']),
    attempt:pick([0,1,2,3]),maxAttempts:pick([1,3]),recoveryForAttempt:pick([-1,0,1,2,3])};
  const tasks=pick([[primary],[primary,child],[primary,{...child,state:'SUCCEEDED',recoveryForAttempt:3}],
      [{...primary,state:'SUCCEEDED'},{...child,state:'FAILED',attempt:3,maxAttempts:3}],
      [{...primary,state:'FAILED'}, {...child,state:'SUCCEEDED',recoveryForAttempt:0}]]);
  const job={id:'test',state:'ACTIVE',repository:'fixture',projectRoot:tmp,title:'fixture',tasks,plans:[],
    reviewRevisionRounds:[],review:{taskId:'review-1',outcome:'pending'}};
  ops.push(caseOf('reviewWorkSettled',job));
}
for(let i=0;i<1200;i++){
  const string=()=>pick([undefined,null,'', '  ','alpha','alpha  ',' a'.repeat(100),'🚀'.repeat(130),true,5]);
  const job={id:'test',headSha:'sha',implementationThreadId:string(),reviewerThreadId:string(),creatorThreadId:string(),
    tasks:[{id:'t',agentName:pick(['final-review','reviewer','worker']),state:'SUCCEEDED',adapter:'chatgpt',routing:{provider:'chatgpt'},threadId:string(),threadUrl:'https://chatgpt.com/c/x'}]};
  const task={id:'t',agentName:pick(['final-review','reviewer','worker','implementation',null]),reviewHeadSha:pick(['sha','',null]),
    routing:{projectId:pick([null,'p'])},chatgptThreadDelivery:pick([undefined,{requestId:'q',executionId:'e'},{requestId:'q',threadId:'alpha',deliveredAt:'now'}])};
  ops.push(caseOf(pick(['resolveReviewerThreadDestination','resolveImplementationThreadDestination','resolveImplementationTaskThreadDestination','prepareReviewerThreadDelivery','chatgptThreadRequirements']),job,task));
  if(i%4===0)ops.push({...caseOf('normalizeThreadId'),value:string(),label:'--thread-id'});
  if(i%4===0)ops.push({...caseOf('runtimeReviewer'),args:pick([[],['--thread-id','  '],['--thread-id','hello'],['--thread-id','🚀'.repeat(130)]])});
}
for(let i=0;i<1100;i++){
  const adapter=()=>pick(['chatgpt','codex','model']);
  const projectId=()=>pick([undefined,null,'p1','p2']);
  const original={id:'original',adapter:adapter(),routing:{provider:pick(['chatgpt','codex']),projectId:projectId()},
    threadId:pick([null,undefined,'','thread',' t ']),threadUrl:pick(['https://chatgpt.com/c/a','https://example.com/c/a','https://chatgpt.com/c/','']),
    threadDeletedAt:pick([undefined,null,'2025-01-01'])};
  const child={id:'child',adapter:adapter(),routing:{provider:pick(['chatgpt','codex']),projectId:projectId()},
    executionId:pick([null,undefined,'exec']),revision:{kind:pick(['targeted','other']),originalTaskId:pick(['original','missing']),
      threadContinuation:pick([undefined,{decision:'reuse',decidedAt:'2025-01-01T00:00:00Z'},
        {decision:'fallback',decidedAt:'2025-01-01T00:00:00Z'}])}};
  ops.push(caseOf('prepareRevisionThreadDelivery',{id:'job',repository:'repo',tasks:[original]},child));
}
for(let i=0;i<500;i++){
  const args=pick([['--prompt','hi'],['--prompt','hi','--agents','reviewer,a,b'],['--prompt','hi','--agents','-oops'],
    ['--prompt-file','missing'],['--prompt',''],['--prompt','hi','--output','out'],['--prompt','hi','--agents','abc,abc,reviewer'],
    ['--wat','hi'],['--prompt','hi','--project-path',tmp],['--prompt','hi','--agents','UPPER'],[]]);
  ops.push({...caseOf('parseOutcomeReviewArgs'),args,cwd:tmp});
  ops.push({...caseOf('combineOutcomeReviews'),reviews:Array.from({length:Math.floor(rand()*5)},()=>({reviewer:'x',verdict:pick(['PASS','CHANGE_REQUIRED','BLOCKED']),findings:[],evidence:[]}))});
}
const exe=path.resolve('rust/target/debug/relay-rust2-wave4-review');
const rusty=spawnSync(exe,[],{input:ops.map(x=>JSON.stringify(x)).join('\n')+'\n',encoding:'utf8',maxBuffer:20*1024*1024});
if(rusty.status!==0)throw Error(`Rust binary failed: ${rusty.stderr}`);
const rows=rusty.stdout.trim().split('\n');if(rows.length!==ops.length)throw Error(`Rust count ${rows.length} != ${ops.length}`);
let fails=0;const byOp={};
const canonical=x=> Array.isArray(x)?x.map(canonical):(x&&typeof x==='object'?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,k==='decidedAt'?(v===undefined?undefined:'NORMALIZED'):canonical(v)])):x);
const normalize=x=>JSON.stringify(canonical(x));
for(let i=0;i<ops.length;i++){
  const a=await runNode(ops[i]);const b=JSON.parse(rows[i]);
  const pair=byOp[ops[i].op]??={pass:0,fail:0};
  if(normalize(a)!==normalize(b)){
    pair.fail++;fails++;if(fails<=15)console.error('DIFF',i,ops[i].op,JSON.stringify(ops[i]),'NODE',JSON.stringify(a),'RUST',JSON.stringify(b));
  }else pair.pass++;
}
console.log(JSON.stringify({total:ops.length,failures:fails,byOp},null,2));
rmSync(tmp,{recursive:true,force:true});
if(fails)process.exitCode=1;
