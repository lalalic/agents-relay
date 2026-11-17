// Direct original Node src/cli-artifact.ts vs Rust JSON Schema compile, filesystem and CLI parity.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {validateArtifact,runArtifactCommand} from '../../dist/cli-artifact.js';
const root=process.cwd(),bin=resolve(root,'rust/target/debug/relay-rust2-parity');
const fixtures=mkdtempSync(join(tmpdir(),'rust2-wave4-schema-'));
process.on('exit',()=>rmSync(fixtures,{recursive:true,force:true}));
let cases=0;
function rust(op,payload){
 const r=spawnSync(bin,[],{input:JSON.stringify({op,...payload})+'\n',encoding:'utf8'});
 assert.equal(r.status,0,r.stderr); return JSON.parse(r.stdout.trim());
}
async function compare(schema,artifact){
 const artifactPath=join(fixtures,'artifact.json'),schemaPath=join(fixtures,'schema.json');
 writeFileSync(artifactPath,JSON.stringify(artifact));writeFileSync(schemaPath,JSON.stringify(schema));
 let node;
 try{node={ok:true,value:await validateArtifact(artifactPath,schemaPath)}}
 catch(e){node={ok:false,error:e.message}}
 const actual=rust('validateArtifact',{artifactPath,schemaPath});
 try{assert.deepEqual(actual,node)}catch(e){throw new Error(`case #${cases}: ${e.message}\nschema=${JSON.stringify(schema)}\nartifact=${JSON.stringify(artifact)}\nnode=${JSON.stringify(node)}\nrust=${JSON.stringify(actual)}`)}
 cases++;
}
test('Ajv schema compilation malformed-reference and invalid-keyword cases',async()=>{
 const invalid=[
 {$ref:'#/definitions/no'},
 {$ref:'missing.json'},
 {type:'nonsense'},
 {type:['string','wat']},
 {required:'x'},
 {required:[2]},
 {enum:[]},
 {multipleOf:0},
 {properties:{a:{type:'nah'}}},
 {minLength:-1},
 {maxItems:'a'},
 {minimum:'x'},
 {maxProperties:-1},
 {type:['string','integer','string']},
 {definitions:{a:{required:[null]}},properties:{p:{$ref:'#/definitions/a'}}}
 ];
 for(const schema of invalid)await compare(schema,{p:'a'});
});
test('Ajv Unicode UTF-16 string length and formats not validated by default',async()=>{
 const schemas=[
 {type:'string',minLength:3},
 {type:'string',maxLength:1},
 {type:'string',minLength:2,maxLength:3},
 {type:'string',format:'email'},
 {type:'string',format:'unknown'},
 {type:'object',properties:{name:{type:'string',minLength:3}},required:['name']},
 ];
 for(const schema of schemas) for(const data of ['🙂','🙂a','a','a🙂a',{name:'🙂'},'hello'])
 await compare(schema,data);
});
test('runArtifactCommand CLI original output/exit/error precedence',async()=>{
 const artifactPath=join(fixtures,'artifact-cli.json'),schemaPath=join(fixtures,'schema-cli.json');
 for(const action of ['other','validate'])
 for(const schema of [{type:'number'},{type:'string'},{type:'object',required:['a']}])
 for(const value of ['x',3,{}]){
 writeFileSync(artifactPath,JSON.stringify(value));writeFileSync(schemaPath,JSON.stringify(schema));
 const args=['--artifact',artifactPath,'--schema',schemaPath];
 const stdout=[],original=console.log;
 let error=null;
 console.log=(msg)=>stdout.push(msg);
 try{await runArtifactCommand(action,args)}catch(e){error=e.message}
 finally{console.log=original}
 const actual=rust('runArtifactCommand',{action,args});
 assert.deepEqual(actual,{ok:true,value:{stdout,error}},JSON.stringify({action,schema,value}));
 }
});
test('case count',()=>assert.ok(cases>=50));
