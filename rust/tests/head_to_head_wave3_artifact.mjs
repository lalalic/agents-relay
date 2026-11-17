// Real-filesystem Node Ajv vs Rust validator: disposable temp files only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {validateArtifact} from '../../dist/cli-artifact.js';
const root=process.cwd(),bin=resolve(root,'rust/target/debug/relay-rust2-parity');
let count=0;
const fixtures=mkdtempSync(join(tmpdir(),'rust2-wave3-artifact-'));
process.on('exit',()=>rmSync(fixtures,{force:true,recursive:true}));
async function compare(schema,value){
 const artifactPath=join(fixtures,'data.json'),schemaPath=join(fixtures,'schema.json');
 writeFileSync(artifactPath,JSON.stringify(value));writeFileSync(schemaPath,JSON.stringify(schema));
 let node;try{node={ok:true,value:await validateArtifact(artifactPath,schemaPath)}}
 catch(error){node={ok:false,error:error.message}}
 const raw=spawnSync(bin,[],{input:JSON.stringify({op:'validateArtifact',artifactPath,schemaPath})+'\n',encoding:'utf8'});
 assert.equal(raw.status,0,raw.stderr);const rust=JSON.parse(raw.stdout.trim());
 try{assert.deepEqual(rust,node)}catch(error){throw new Error(`${error.message}\nschema=${JSON.stringify(schema)}\ndata=${JSON.stringify(value)}\nnode=${JSON.stringify(node)}\nrust=${JSON.stringify(rust)}`)}
 count++;
}
let seed=100;
function rnd(){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32}
const pick=xs=>xs[Math.floor(rnd()*xs.length)];
test('schema if/then/else: Ajv selection, allErrors, diagnostic ordering',async()=>{
 for(let i=0;i<90;i++){
   const sch={type:'object',if:{properties:{kind:{const:'a'}}},
    then:{required:['name'],properties:{name:{type:'string',minLength:3}}},
    else:{required:['id'],properties:{id:{type:'integer',minimum:1}}}};
   await compare(sch,{kind:pick(['a','b']),name:pick(['s','long','abc',null,undefined]),id:pick([null,0,1,3,undefined])});
 }
});
test('arrays: contains, required valid items, uniqueness',async()=>{
 const cases=[
 [{type:'array',contains:{type:'number'}},[1,'x']],
 [{type:'array',contains:{type:'number'}},['x','y']],
 [{type:'array',contains:{minimum:3}},[1,2]],
 [{type:'array',contains:{minimum:3}},[1,2,3]],
 [{type:'array',contains:{type:'number'},minContains:2},[1,'x']],
 [{type:'array',uniqueItems:true},[1,1]],
 [{type:'array',uniqueItems:true,contains:{type:'string'}},[1,1]],
 ];
 for(const [sch,v] of cases)await compare(sch,v);
 for(let i=0;i<85;i++){
 const sch={type:'array',contains:{type:pick(['number','integer','string']),minimum:pick([0,2,3])},minItems:pick([0,1,3])};
 await compare(sch,Array.from({length:Math.floor(rnd()*5)},()=>pick([1,2,3,'x',null])));
 }
});
test('objects: dependencies, propertyNames, path/diagnostics',async()=>{
 for(let i=0;i<95;i++){
  const sch={type:'object',required:pick([[],['a'],['z']]),
   properties:{a:{type:'integer'},z:{type:'string'}},
   dependencies:{a:['b']},propertyNames:{pattern:'^[abz]+$'},
   additionalProperties:pick([true,false])};
  const value={};for(const k of ['a','b','z','WRONG'])if(rnd()<0.45)value[k]=pick([1,'bad',3,null]);
  await compare(sch,value);
 }
});
test('artifact error ordering and Ajv coverage',()=>{
 console.log(`Rust/Node real filesystem validations: ${count}`);
 assert.ok(count>200);
});
