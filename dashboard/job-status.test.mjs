import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const script=readFileSync(new URL('./dashboard.js',import.meta.url),'utf8');
const start=script.indexOf('function renderJobList(');
const source=script.slice(start,script.indexOf('\n',start));

function badges(job){
  class Element {
    constructor(){this.children=[];}
    append(...children){this.children.push(...children);}
    replaceChildren(){this.children=[];}
    setAttribute(){}
    addEventListener(){}
  }
  const jobList=new Element();
  const context={
    jobList,jobs:[job],filteredJobs:()=>[job],selectedJob:null,
    document:{createElement:()=>new Element()},
    element:(tag,className,content)=>{const item=new Element();item.className=className;if(content!==undefined)item.append(content);return item;},
    text:String,value:String,repoName:String,jobSelectionKey:()=>job.id,
    isCompleteUnmerged:()=>false,counts:()=>({}),compactCounts:()=>'',relativeTime:()=>'',
  };
  vm.runInNewContext(source+';renderJobList()',context);
  const collect=node=>typeof node==='string'?[]:node.className?.startsWith('badge ')?[node.children[0]]:node.children.flatMap(collect);
  return collect(jobList);
}

test('identical job and runtime status render one badge',()=>{
  for(const state of ['COMPLETED','CANCELLED','ACTIVE','IDLE']){
    assert.deepEqual(badges({id:'729',state,runtimeStatus:state}),[state,...(state==='ACTIVE'?['REVIEW REQUIRED']:[])]);
  }
});
test('distinct runtime, review, merge and publication indicators remain visible',()=>{
  assert.deepEqual(badges({id:'1',state:'ACTIVE',runtimeStatus:'RUNNING',publication:{version:'1.2.3'}}),['ACTIVE','RUNNING','v1.2.3','REVIEW REQUIRED']);
  assert.deepEqual(badges({id:'2',state:'COMPLETED',runtimeStatus:'COMPLETED',publicationFailure:{stage:'push'}}),['COMPLETED','PUBLISH FAILED: push']);
  assert.deepEqual(badges({id:'3',state:'ACTIVE',localMerge:{status:'failed',error:'conflict'}}),['ACTIVE','IDLE','REVIEW REQUIRED','MERGE FAILED: conflict']);
});
