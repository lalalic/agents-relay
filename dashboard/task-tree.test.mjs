import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const script=readFileSync(fileURLToPath(new URL('./dashboard.js',import.meta.url)),'utf8');
const css=readFileSync(fileURLToPath(new URL('./dashboard.css',import.meta.url)),'utf8');
const taskNodeSource=script.slice(script.indexOf('function taskNode('),script.indexOf('function buildTree('));
assert.ok(taskNodeSource.startsWith('function taskNode('));

class Element {
  constructor(tag){this.tagName=tag;this.children=[];this.attributes={};this.listeners={};this.style={};this.hidden=false;}
  append(...children){this.children.push(...children);}
  setAttribute(name,value){this.attributes[name]=value;}
  addEventListener(name,callback){this.listeners[name]=callback;}
  click(){this.listeners.click?.();}
}

test('task branches and leaves share label indentation and retain selection/fold behavior',()=>{
  const state={selectedJob:'724',selectedTaskId:null,eventTaskId:null,
    collapsedTasks:new Set(),expandedTasks:new Set(),remembered:0,rendered:0};
  const context={
    document:{createElement:tag=>new Element(tag)},
    element:(tag,className,content)=>{const item=new Element(tag);item.className=className;if(content!==undefined)item.textContent=content;return item;},
    text:String,value:value=>String(value??''),selected:()=>({repository:'agents-relay',tasks:[]}),
    shortManagedId:id=>id,taskVerdict:()=>null,taskStateLabel:()=>'',taskTagDisplay:()=>null,
    taskSubtreeComplete:()=>false,rememberSelection:()=>state.remembered++,clearEvents:()=>{},
    renderAll:()=>state.rendered++,loadEventHistory:async()=>{},
    get selectedJob(){return state.selectedJob;},get selectedTaskId(){return state.selectedTaskId;},
    set selectedTaskId(value){state.selectedTaskId=value;},set eventTaskId(value){state.eventTaskId=value;},
    collapsedTasks:state.collapsedTasks,expandedTasks:state.expandedTasks,
  };
  const taskNode=vm.runInNewContext(`${taskNodeSource}; taskNode`,context);
  const nested={id:'2256',title:'Troubleshooter',state:'QUEUED'};
  const branch={id:'2255',title:'Visioner',state:'RUNNING'};
  const leaf={id:'2261',title:'Producer',state:'QUEUED'};
  const children=new Map([[branch.id,[nested]]]);
  const branchItem=taskNode(branch,children,1);
  const leafItem=taskNode(leaf,children,1);
  const branchLine=branchItem.children[0];
  const leafLine=leafItem.children[0];
  const branchFold=branchLine.children[0];
  const leafSpacer=leafLine.children[0];
  const branchRow=branchLine.children[1];
  const leafRow=leafLine.children[1];
  const width=css.match(/\.task-fold,\.task-fold-slot\s*\{[^}]*width:([\d.]+)rem/);
  const gap=css.match(/\.task-line\s*\{[^}]*gap:([\d.]+)rem/);
  const inset=css.match(/\.task-row\s*\{[^}]*padding:[^;]*\s([\d.]+)rem/);
  assert.ok(width&&gap&&inset,'shared slot, line gap and row inset rules are present');
  assert.equal(width[1],'1.25');
  assert.equal(branchRow.className,leafRow.className);
  assert.equal(Number(width[1])*16+Number(gap[1])*16+Number(inset[1])*16,26.4);
  assert.equal(leafSpacer.className,'task-fold-slot');
  assert.equal(leafSpacer.attributes['aria-hidden'],'true');
  assert.equal(leafSpacer.tagName,'span');
  assert.equal(branchFold.tagName,'button');
  assert.equal(branchFold.attributes['aria-expanded'],'true');

  branchFold.click();
  assert.equal(branchItem.children[1].hidden,true);
  assert.equal(branchFold.attributes['aria-expanded'],'false');
  assert.ok(state.collapsedTasks.has('724:2255'));
  const collapsedAgain=taskNode(branch,children,1);
  assert.equal(collapsedAgain.children[0].children[0].attributes['aria-expanded'],'false');
  leafRow.click();
  assert.equal(state.selectedTaskId,'2261');
  assert.equal(state.eventTaskId,'2261');
  assert.equal(state.remembered,1);
  assert.equal(state.rendered,1);
  assert.equal(taskNode(leaf,children,1).children[0].children[1].attributes['aria-current'],'true');
});
