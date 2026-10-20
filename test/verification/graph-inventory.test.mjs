import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {GraphRuntime} from '../../dist/workflow/graph-v2.js';
import {executableGraphs} from '../../dist/workflow/usage-index.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const graphDirectory=join(root,'workflow');
const graphs=executableGraphs(graphDirectory);
const walk=(dir)=>readdirSync(dir,{withFileTypes:true}).flatMap(item=>item.isDirectory()?walk(join(dir,item.name)):item.name.endsWith('.ts')?[join(dir,item.name)]:[]);
const productionSources=walk(join(root,'src')).map(path=>readFileSync(path,'utf8'));
const graphNames=readdirSync(graphDirectory).filter(x=>x.endsWith('.mmd')&&x!=='main.mmd').sort();
test('every executable graph is loaded by production, without an orphan or silent deletion',()=>{
 assert.equal(graphNames.length,graphs.size);
 assert.ok(graphNames.length>=16,'unexpected graph inventory contraction requires explicit review');
 for(const name of graphNames){
  assert.ok(graphs.has(name),name);
  assert.ok(productionSources.some(source=>source.includes(name)||source.includes("'"+name.slice(0,-4)+"'")),name+' has no production owner');
 }
});
for(const [filename,graph] of graphs){
 test('L1 all executable paths and branch bindings: '+filename,()=>{
  const nodes=[...graph.nodes.values()];
  const states=[...new Set(nodes.filter(x=>x.kind==='state').map(x=>x.semanticId))];
  const guards=[...new Set(nodes.filter(x=>x.kind==='guard').map(x=>x.semanticId))];
  const actions=[...new Set(nodes.filter(x=>x.kind==='action').map(x=>x.semanticId))];
  const events=[...new Set(graph.edges.filter(e=>['on','emit'].includes(e.kind)).map(e=>e.semanticId))];
  const requests=[...new Set(graph.edges.filter(e=>e.kind==='request').map(e=>e.semanticId))];
  const runtime=new GraphRuntime(graph,{
   states:new Set(states),
   guards:Object.fromEntries(guards.map(id=>[id,facts=>facts.durableFacts[id]===true])),
   actions:Object.fromEntries([...new Set([...actions,...requests])].map(id=>[id,{id}])),
   events:Object.fromEntries(events.map(id=>[id,{id}])),
  });
  assert.ok(states.length>0&&graph.edges.length>0);
  let evaluated=0, accepted=0, rejected=0;
  const coveredEdges=new Set();
  const inputs=graph.edges.filter(edge=>edge.kind==='on'||edge.kind==='request');
  const evaluatedInputs=new Set();
  for(const edge of inputs){
   const state=graph.nodes.get(edge.from).semanticId;
   const key=state+'|'+edge.kind+'|'+edge.semanticId;
   if(evaluatedInputs.has(key))continue;
   evaluatedInputs.add(key);
   const relatedGuards=new Set();
   const visit=(nodeId,seen=new Set())=>{
    if(seen.has(nodeId))return;
    seen.add(nodeId);
    const node=graph.nodes.get(nodeId);
    if(node.kind==='guard')relatedGuards.add(node.semanticId);
    if(node.kind==='state'||node.kind==='emit')return;
    for(const e of graph.edges.filter(e=>e.from===nodeId&&e.kind!=='emit'))visit(e.to,new Set(seen));
   };
   for(const entry of graph.edges.filter(e=>e.from===edge.from&&e.kind===edge.kind&&e.semanticId===edge.semanticId))visit(entry.to);
   const bits=[...relatedGuards];
   assert.ok(bits.length<=16,filename+' needs bounded decision test factoring');
   for(let mask=0;mask<2**bits.length;mask++){
    const durableFacts=Object.fromEntries(bits.map((id,i)=>[id,Boolean(mask&(1<<i))]));
    // Production task-reconcile derives these facts from the same dependencyReady()
    // result: an unsatisfied dependency cannot also make a Task runnable.
    if(filename==='task-lifecycle.mmd'&&durableFacts.dependenciesUnsatisfied===true&&durableFacts.runnable===true)continue;
    const decision=runtime.evaluateSync({currentState:state,input:{transport:edge.kind==='on'?'event':'action',id:edge.semanticId,payload:{}},durableFacts});
    const traverse=(nodeId,path=new Set())=>{
      if(path.has(nodeId))throw Error('cyclic test topology');
      const nextPath=new Set(path);nextPath.add(nodeId);
      const node=graph.nodes.get(nodeId);
      if(node.kind==='state'||node.kind==='emit')return;
      const edges=graph.edges.filter(e=>e.from===nodeId);
      for(const e of edges){
        if(node.kind==='guard'&&e.kind!==(durableFacts[node.semanticId]===true?'true':'false'))continue;
        coveredEdges.add(e);
        if(e.kind!=='emit')traverse(e.to,nextPath);
      }
    };
    // A guard assignment can cause multiple entry paths to be enabled only
    // when the supplied facts are contradictory; do not certify that mask.
    if(decision.accepted){
      for(const inputEdge of graph.edges.filter(e=>e.from===edge.from&&e.kind===edge.kind&&e.semanticId===edge.semanticId)){
        const current=graph.nodes.get(inputEdge.to);
        if(current.kind==='guard'&&durableFacts[current.semanticId]!==true&&!graph.edges.some(e=>e.from===current.id&&e.kind==='false'))continue;
        coveredEdges.add(inputEdge);
        traverse(inputEdge.to);
      }
    }
    assert.notEqual(decision.accepted?null:decision.reason,'ambiguous',filename+': '+key+' mask='+mask);
    evaluated++;
    if(decision.accepted){accepted++;assert.ok(states.includes(decision.target));for(const action of decision.actions)assert.ok(actions.includes(action.id));}
    else {rejected++;assert.equal(decision.reason,'no_transition');}
   }
  }
  assert.ok(evaluated>0&&accepted>0,filename);
  for(const edge of graph.edges)assert.ok(graph.nodes.has(edge.from)&&graph.nodes.has(edge.to));
  const missing=graph.edges.filter(edge=>!coveredEdges.has(edge));
  assert.deepEqual(missing.map(e=>e.line),[],filename+' uncovered declared edges');
  assert.ok(accepted+rejected===evaluated);
 });
}
