import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import Ajv from 'ajv';

const exe = resolve(process.env.CARGO_TARGET_DIR ?? resolve(import.meta.dirname,'../target'), 'debug/relay-native-job');
const invoke = (root, ...args) => spawnSync(exe, ['artifact', 'validate', ...args], {
  encoding:'utf8', env:{...process.env, AGENTS_RELAY_STORE_DIR:join(root,'isolated-store')},
});

test('native artifact validate matches Node AJV output and leaves unrelated authority bytes untouched', () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-native-platform-artifact-'));
  const artifact = join(root,'artifact.json'), schema = join(root,'schema.json');
  const authority = join(root,'relay.sqlite'); writeFileSync(authority,'sentinel authority');
  try {
    const ajv = new Ajv({allErrors:true, strict:false});
    const cases = [
      [{name:'Relay',count:2}, {type:'object',required:['name','count'],properties:{name:{type:'string',minLength:3},count:{type:'integer',minimum:1}},additionalProperties:false}],
      [{name:'x',count:0,extra:true}, {type:'object',required:['name','missing'],properties:{name:{type:'string',minLength:3},count:{type:'integer',minimum:1}},additionalProperties:false}],
      [[1,'x',1], {type:'array',uniqueItems:true,items:{type:'integer'}}],
      ['nope', {type:'string',pattern:'^[0-9]+$'}],
    ];
    for (const [data, schemaValue] of cases) {
      writeFileSync(artifact, JSON.stringify(data)); writeFileSync(schema, JSON.stringify(schemaValue));
      const result = invoke(root,'--artifact',artifact,'--schema',schema);
      const validate = ajv.compile(schemaValue); const expectedValid = validate(data);
      const expected = {valid:expectedValid, errors:(validate.errors ?? []).map(error=>({path:error.instancePath||'/',message:error.message??'invalid value'}))};
      assert.deepEqual(JSON.parse(result.stdout),expected);
      assert.equal(result.status,expectedValid?0:2,result.stderr);
      if (!expectedValid) assert.match(result.stderr,/Artifact validation failed/);
    }
    assert.equal(readFileSync(authority,'utf8'),'sentinel authority');

    const missing = invoke(root,'--artifact',join(root,'..','escape.json'),'--schema',schema);
    assert.equal(missing.status,2); assert.match(missing.stderr,/artifact file:/);
    const duplicate = invoke(root,'--artifact',artifact,'--artifact',artifact,'--schema',schema);
    assert.equal(duplicate.status,2); assert.match(duplicate.stderr,/duplicate option --artifact/);
    writeFileSync(schema,JSON.stringify({type:'string',format:'custom'}));
    const unsupported = invoke(root,'--artifact',artifact,'--schema',schema);
    assert.equal(unsupported.status,2); assert.match(unsupported.stderr,/Unsupported JSON Schema keyword format/);
    const schemaArray = join(root,'schema-array.json'); writeFileSync(schemaArray,'[]');
    const malformedSchema = invoke(root,'--artifact',artifact,'--schema',schemaArray);
    assert.equal(malformedSchema.status,2); assert.match(malformedSchema.stderr,/Schema must be a JSON object/);

    for (const args of [
      ['context','resolve','--project-path',root], ['agent-discover','--id','x'],
      ['agent-register','--id','x'], ['prompt','--task-id','x'], ['blocker','show','--id','x'],
      ['projection','conflicts','--id','x'], ['migrate-local-repositories','inspect'],
      ['migrate-local-repositories','validate'], ['plan','context','--plan-id','x','--execution-id','e'],
      ['plan','apply','--id','x','--plan-id','p','--execution-id','e','--file','proposal.json'],
    ]) {
      const result = spawnSync(exe,args,{encoding:'utf8',env:{...process.env,AGENTS_RELAY_STORE_DIR:join(root,'isolated-store')}});
      assert.equal(result.status,2,result.stderr);
      assert.match(result.stderr,/has no native Rust parity yet|not ported/);
    }
    assert.equal(readFileSync(authority,'utf8'),'sentinel authority');
  } finally { rmSync(root,{recursive:true,force:true}); }
});
