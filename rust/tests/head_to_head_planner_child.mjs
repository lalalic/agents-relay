// Node src/planner-child.ts: deterministic normal, error-like, missing and nested boundary differential fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {samePlannerChildDefinition} from '../../dist/planner-child.js';
const fields=['id','parentTaskId','input','output','review','priority','storySize','projectName','agentName','agentGraph','dependencies','capabilities','adapter','routing','continuation','maxAttempts','timeoutMs'];
function rust(left,right){const p=spawnSync('rust/target/debug/relay-rust2-parity',[],{input:JSON.stringify({op:'samePlannerChildDefinition',left,right})+'\n',encoding:'utf8'});assert.equal(p.status,0,p.stderr);const v=JSON.parse(p.stdout);assert.equal(v.ok,true,v.error);return v.value}
test('Planner child field projections match Node across normal, missing, nested and boundary inputs',()=>{
 const baseline={id:17,parentTaskId:1,input:{a:[1,null,'中']},output:{kind:'task_pr'},priority:0,dependencies:[],maxAttempts:3,timeoutMs:1000};
 const pairs=[[baseline,baseline],[baseline,{...baseline,state:'SUCCEEDED'}],[baseline,{...baseline,review:null,continuation:null,storySize:'M'}],[baseline,{...baseline,review:{}}],[baseline,{...baseline,storySize:null}],[baseline,{...baseline,storySize:''}],[baseline,{...baseline,input:{a:[1,null,'不同']}}]];
 for(const field of fields){const a={...baseline,[field]:{a:1,b:[true,null,'😃']}};const b={...a,[field]:{a:1,b:[true,null,'😃']}};pairs.push([a,b],[a,{...b,[field]:{a:2}}],[a,{...b,[field]:null}]);}
 for(let i=0;i<300;i++){const f=fields[i%fields.length];const a={...baseline,[f]:i%3===0?null:i%3===1?[i,0,'']:{k:i}};const b={...a,[f]:i%2? a[f]:i+1};pairs.push([a,b]);}
 for(const [a,b] of pairs)assert.equal(rust(a,b),samePlannerChildDefinition(a,b),JSON.stringify([a,b]));
});
