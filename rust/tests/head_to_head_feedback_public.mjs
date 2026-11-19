// Independent differential for src/feedback.ts (PROVENANCE QUARANTINE cleared):
// pure helpers (marker/parse/redact/provenance/legacy record/fingerprint/
// markdown) plus real-filesystem FileFeedbackStore submit/read and attachment
// integrity. No Worker C artifacts reused.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,mkdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {
  marker,renderFeedbackMarker,parseFeedbackMarker,redactSensitiveText,
  createFeedbackRecord,feedbackWorkProvenance,feedbackFingerprint,
  renderFeedbackMarkdown,materializeFeedbackRecord,FileFeedbackStore,
  readFeedbackAttachment,
} from '../../dist/feedback.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');

const PROVENANCE={source:'public-site',product:'agents-relay',surface:'cli',
  actorClass:'pilot-user',version:'1.0',submittedAt:'2026-11-01T10:00:00.000Z'};
const LEGACY_RECORD=(over={})=>{
  const base=createFeedbackRecord({text:'It crashed',provenance:PROVENANCE},
    {id:'feedback-17',receivedAt:'2026-11-01T10:05:00.000Z'});
  return {...base,...over};
};
const MODERN_RECORD={schema:'agents-relay:feedback:v1',schemaVersion:1,
  id:'9b7d2d10-1111-4222-8333-444455556666',
  idempotencyKey:'key-1',
  userContent:{text:'modern text'},
  attachments:[{id:'a1',filename:'shot.png',mediaType:'image/png',sizeBytes:3,
    sha256:'a'.repeat(64),storageRef:'attachments/x/shot.png',
    uploadedAt:'2026-11-01T10:00:00.000Z'}],
  systemProvenance:PROVENANCE,
  triage:{status:'new',updatedAt:'2026-11-01T10:00:00.000Z'},
  downstream:[],createdAt:'2026-11-01T10:00:00.000Z'};

function nodePure(fixture){
  try{
    if(fixture.method==='marker')
      return {ok:true,value:marker(fixture.label,fixture.value)};
    if(fixture.method==='renderMarker')
      return {ok:true,value:renderFeedbackMarker(fixture.record)};
    if(fixture.method==='parseMarker')
      return {ok:true,parsed:parseFeedbackMarker(fixture.value)};
    if(fixture.method==='redact')
      return {ok:true,value:redactSensitiveText(fixture.value)};
    if(fixture.method==='createRecord')
      return {ok:true,record:jsonable(createFeedbackRecord(fixture.submission,
        fixture.options),fixture.options)};
    if(fixture.method==='workProvenance')
      return {ok:true,value:feedbackWorkProvenance(fixture.record)};
    if(fixture.method==='fingerprint')
      return {ok:true,value:feedbackFingerprint(fixture.record)};
    if(fixture.method==='renderMarkdown')
      return {ok:true,value:renderFeedbackMarkdown(fixture.record)};
  }catch(error){return {ok:false,error:error?.message??String(error)};}
  throw new Error('unreachable '+fixture.method);
}
function jsonable(value,options){
  // Mirror the Rust op normalization tokens exactly.
  const strip=(record)=>{
    record=JSON.parse(JSON.stringify(record));
    if(record.id&&(!options||!options.id))record.id='<dynamic>';
    if(record.createdAt)record.createdAt='<dynamic>';
    if(record.triage&&record.triage.updatedAt)record.triage.updatedAt='<dynamic>';
    if(record.attachments)for(const a of record.attachments){
      if(a.id)a.id='<dynamic>';
      if(a.uploadedAt)a.uploadedAt='<dynamic>';
      if(a.storageRef){
        const suffix=String(a.storageRef).split('/').slice(2).join('/');
        a.storageRef=suffix.replace(
          /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}-/,
          '<dynamic>-');
      }
    }
    if(record.systemMetadata&&record.systemMetadata.receivedAt
      &&(!options||!options.receivedAt))
      record.systemMetadata.receivedAt='<dynamic>';
    return record;
  };
  if(Array.isArray(value))return value.map(strip);
  return strip(value);
}
async function parity(cases){
  const lines=cases.map(f=>JSON.stringify(f));
  return await new Promise((resolvePromise,reject)=>{
    const child=spawn(binary,[],{cwd:root});
    let out='',err='';
    child.stdout.on('data',c=>out+=c);
    child.stderr.on('data',c=>err+=c);
    child.on('error',reject);
    child.on('close',code=>{
      if(code!==0)return reject(new Error(err||`parity exited ${code}`));
      try{
        const values=out.trim().split('\n').filter(Boolean).map(line=>{
          const parsed=JSON.parse(line);
          if(!parsed.ok)throw new Error('parity error: '+parsed.error);
          return parsed.value;
        });
        resolvePromise(values);
      }catch(e){reject(new Error(`parity JSON: ${e.message}: ${out.slice(0,300)}`));}
    });
    child.stdin.end(lines.join('\n')+'\n');
  });
}
function deepEqual(a,b){
  if(a===b)return true;
  if(typeof a!==typeof b)return false;
  if(a===null||b===null)return a===b;
  if(Array.isArray(a)&&Array.isArray(b))
    return a.length===b.length&&a.every((v,i)=>deepEqual(v,b[i]));
  if(typeof a==='object'){
    const ka=Object.keys(a).sort(),kb=Object.keys(b).sort();
    return JSON.stringify(ka)===JSON.stringify(kb)
      &&ka.every(k=>deepEqual(a[k],b[k]));
  }
  return false;
}
function compare(cases,expected,results,label){
  const failures=[];
  for(let i=0;i<cases.length;i++){
    const want=expected[i],got=results[i];
    if(want.ok!==got.ok){failures.push([i,cases[i].method,want,got]);continue;}
    if(want.ok===false&&want.error!==got.error){failures.push([i,cases[i].method,want,got]);continue;}
    if(want.ok===true&&!deepEqual(want,got))
      failures.push([i,cases[i].method,want,got]);
  }
  for(const [i,method,want,got] of failures.slice(0,8))
    console.log('FB_DIFF',i,method,JSON.stringify(want).slice(0,260),
      JSON.stringify(got).slice(0,260));
  assert.deepEqual(failures.map(f=>f[0]),[],
    `${failures.length} ${label} mismatches`);
}
test('feedback pure helper differential (quarantine cleared)',async()=>{
  const cases=[];
  // marker: label + JSON serialization with > escaping
  for(const value of [{a:1},'b>',{nested:{x:['>','y']}},null,[],{s:'a\\b"c'}])
    cases.push({method:'marker',label:'agents-relay:feedback:v1',value});
  cases.push({method:'marker',label:'other',value:{z:9}});
  // renderFeedbackMarker: strips userContent only
  cases.push({method:'renderMarker',record:MODERN_RECORD});
  cases.push({method:'renderMarker',record:{...MODERN_RECORD,userContent:{text:'secret'}}});
  // parseFeedbackMarker: round trip + adversarial
  cases.push({method:'parseMarker',value:renderFeedbackMarker(MODERN_RECORD)});
  cases.push({method:'parseMarker',value:'<!-- agents-relay:feedback:v1 {"schema":"agents-relay:feedback:v1","schemaVersion":1} -->'});
  cases.push({method:'parseMarker',value:'<!-- agents-relay:feedback:v1 {"schema":"wrong","schemaVersion":1} -->'});
  cases.push({method:'parseMarker',value:'<!-- agents-relay:feedback:v1 {"schema":"agents-relay:feedback:v1","schemaVersion":2} -->'});
  cases.push({method:'parseMarker',value:'garbage'});
  cases.push({method:'parseMarker',value:'before <!-- agents-relay:feedback:v1 {"schema":"agents-relay:feedback:v1","schemaVersion":1,"x":">"} --> after'});
  // redactSensitiveText
  for(const value of [
    'Bearer abc123._~+/=- done',
    'bearer ABC',
    'sk_abcdefgh12345678 and pk_1234567890abcd',
    'sk_short',
    'api_key: secretvalue token=abc123 secret:zzz',
    'API-KEY = mykey123',
    'nothing to redact',
    'Bearer x then sk_abcdefghijkl',
  ])cases.push({method:'redact',value});
  // createFeedbackRecord legacy shapes
  cases.push({method:'createRecord',submission:{text:'plain',provenance:PROVENANCE}});
  cases.push({method:'createRecord',submission:{text:'Bearer abc',provenance:PROVENANCE},options:{sanitize:true}});
  cases.push({method:'createRecord',submission:{text:'x'.repeat(20001),provenance:PROVENANCE}});
  cases.push({method:'createRecord',submission:{text:'',provenance:PROVENANCE}});
  cases.push({method:'createRecord',submission:{text:'with contact',provenance:{...PROVENANCE,contact:{channel:'email',value:'a@b.c'}}}});
  cases.push({method:'createRecord',submission:{text:'pub',provenance:PROVENANCE,visibility:'public'}});
  cases.push({method:'createRecord',submission:{text:'pub',provenance:PROVENANCE,visibility:'public',sanitized:true}});
  cases.push({method:'createRecord',submission:{text:'a',provenance:{...PROVENANCE,product:''}}});
  cases.push({method:'createRecord',submission:{text:'a',provenance:{...PROVENANCE,submittedAt:'nope'}}});
  cases.push({method:'createRecord',submission:{text:'a',provenance:{...PROVENANCE,contact:{channel:'url',value:'  '}}}});
  cases.push({method:'createRecord',submission:{text:'a',provenance:{...PROVENANCE,version:'v'.repeat(501)}}});
  cases.push({method:'createRecord',submission:{text:'a',attachments:[{reference:'oss://bucket/1.png',mimeType:'image/png',sizeBytes:100,sha256:'a'.repeat(64),width:1,height:1}],provenance:PROVENANCE}});
  cases.push({method:'createRecord',submission:{text:'a',attachments:[{reference:'oss://bucket/1.png',mimeType:'image/bmp',sizeBytes:100}],provenance:PROVENANCE}});
  cases.push({method:'createRecord',submission:{text:'a',attachments:[{reference:'oss://b/1.png?x=1',mimeType:'image/png',sizeBytes:100}],provenance:PROVENANCE}});
  cases.push({method:'createRecord',submission:{text:'a',attachments:[{reference:'https://u:p@x/y.png',mimeType:'image/png',sizeBytes:100}],provenance:PROVENANCE}});
  cases.push({method:'createRecord',submission:{text:'a',attachments:[{reference:'',mimeType:'image/png',sizeBytes:100}],provenance:PROVENANCE}});
  cases.push({method:'createRecord',submission:{text:'a',attachments:[{reference:'r',mimeType:'image/png',sizeBytes:0}],provenance:PROVENANCE}});
  cases.push({method:'createRecord',submission:{text:'a',attachments:[{reference:'r',mimeType:'image/png',sizeBytes:-5}],provenance:PROVENANCE}});
  cases.push({method:'createRecord',submission:{text:'a',attachments:[{reference:'r',mimeType:'image/png',sizeBytes:1.5}],provenance:PROVENANCE}});
  cases.push({method:'createRecord',submission:{text:'a',attachments:Array.from({length:11},(_,i)=>({reference:'r'+i,mimeType:'image/png',sizeBytes:1})),provenance:PROVENANCE}});
  cases.push({method:'createRecord',submission:{text:'a',provenance:{...PROVENANCE,product:'x'.repeat(201)}}});
  cases.push({method:'createRecord',submission:{text:'a',provenance:{...PROVENANCE,contact:{channel:'email',value:'v'.repeat(501)}}}});
  cases.push({method:'createRecord',submission:{text:'a',provenance:PROVENANCE},options:{id:'fixed-1',receivedAt:'2026-01-01T00:00:00.000Z'}});
  // workProvenance / fingerprint / markdown over stable legacy records
  const stable=LEGACY_RECORD();
  cases.push({method:'workProvenance',record:stable});
  cases.push({method:'fingerprint',record:stable});
  cases.push({method:'fingerprint',record:LEGACY_RECORD({attachments:[{id:'attachment-1',reference:'r',mimeType:'image/png',sizeBytes:5}]})});
  cases.push({method:'fingerprint',record:LEGACY_RECORD({userContent:{text:'other'}})});
  cases.push({method:'renderMarkdown',record:stable});
  cases.push({method:'renderMarkdown',record:LEGACY_RECORD({attachments:[{id:'attachment-1',reference:'oss://b/x.png',mimeType:'image/png',sizeBytes:12345,sha256:'e'.repeat(64)}]})});
  const expected=cases.map(nodePure);
  const results=await parity(cases.map(f=>({op:'certFeedback',...f})));
  compare(cases,expected,results,'pure helper');
  console.log('Verified',cases.length,'original Node/Rust feedback pure helper cases');
});
test('feedback FileFeedbackStore real-filesystem differential',async()=>{
  const cases=[];
  const nodeRoot=mkdtempSync(join(tmpdir(),'rust2-fb-node-'));
  const rustRoot=mkdtempSync(join(tmpdir(),'rust2-fb-rust-'));
  try{
    const dataBytes=[104,101,106]; // 'hej'
    const store=new FileFeedbackStore(nodeRoot);
    const nodeRun=async fixture=>{
      try{
        if(fixture.method==='storeSubmit'){
          const submission={text:fixture.text,
            attachments:(fixture.attachments??[]).map(a=>({
              filename:a.filename,mediaType:a.mediaType,
              data:new Uint8Array(a.dataBytes??dataBytes)})),
            provenance:fixture.provenance??PROVENANCE,
            ...(fixture.idempotencyKey?{idempotencyKey:fixture.idempotencyKey}:{})};
          const limits=fixture.limits?normalizeLimits(fixture.limits):undefined;
          const result=limits
            ?await new FileFeedbackStore(nodeRoot,limits).submit(submission)
            :await store.submit(submission);
          const normalized=jsonable(result.record);
          return {ok:true,record:normalized,
            recordRef:result.recordRef.slice(nodeRoot.length)
              .replaceAll('\\','/')
              .replaceAll(result.record.id,'<dynamic>')};
        }
        if(fixture.method==='storeRead'){
          const record=await new FileFeedbackStore(nodeRoot).read(fixture.id);
          return {ok:true,record:jsonable(record)};
        }
        if(fixture.method==='readAttachment'){
          const bytes=await readFeedbackAttachment(nodeRoot,fixture.attachment);
          return {ok:true,bytes:[...bytes]};
        }
      }catch(error){
        let message=error?.message??String(error);
        // Filesystem transport errors differ between stacks (Node embeds
        // the absolute path); normalize to the bare io error class.
        if(message.startsWith('ENOENT'))message='No such file or directory (os error 2)';
        return {ok:false,error:message};
      }
      throw new Error('unreachable '+fixture.method);
    };
    const normalizeLimits=limits=>({
      maxTextLength:limits.maxTextLength,
      maxAttachments:limits.maxAttachments,
      maxAttachmentBytes:limits.maxAttachmentBytes,
      allowedMediaTypes:limits.allowedMediaTypes,
    });
    // happy path
    cases.push({method:'storeSubmit',text:'hello world'});
    cases.push({method:'storeSubmit',text:'with attachment',
      attachments:[{filename:'shot.png',mediaType:'image/png'}]});
    cases.push({method:'storeSubmit',text:'two attachments',
      attachments:[{filename:'a.png',mediaType:'image/png'},{filename:'b.jpg',mediaType:'image/jpeg'}]});
    // filename sanitization
    cases.push({method:'storeSubmit',text:'x',
      attachments:[{filename:'weird name/../../é!.png',mediaType:'image/png'}]});
    cases.push({method:'storeSubmit',text:'x',attachments:[{filename:'',mediaType:'image/png'}]});
    // validation
    cases.push({method:'storeSubmit',text:'  '});
    cases.push({method:'storeSubmit',text:'x'.repeat(20001)});
    cases.push({method:'storeSubmit',text:'x',attachments:[{filename:'a',mediaType:'image/bmp'}]});
    cases.push({method:'storeSubmit',text:'x',
      attachments:[{filename:'a',mediaType:'image/png',dataBytes:[]}]});
    cases.push({method:'storeSubmit',text:'x',
      attachments:Array.from({length:6},(_,i)=>({filename:`f${i}.png`,mediaType:'image/png'}))});
    cases.push({method:'storeSubmit',text:'x',
      attachments:[{filename:'a',mediaType:'IMAGE/PNG'}]});
    // custom limits
    cases.push({method:'storeSubmit',text:'short',limits:{maxTextLength:5}});
    cases.push({method:'storeSubmit',text:'toolong',limits:{maxTextLength:5}});
    cases.push({method:'storeSubmit',text:'x',
      attachments:[{filename:'a',mediaType:'image/gif'}],limits:{allowedMediaTypes:['image/gif']}});
    cases.push({method:'storeSubmit',text:'x',limits:{maxAttachments:0}});
    // provenance failures propagate inside submit
    cases.push({method:'storeSubmit',text:'x',provenance:{...PROVENANCE,product:''}});
    // idempotency: same key twice in a FRESH root
    // (handled below with dedicated roots)
    // read + attachment integrity
    const first=await new FileFeedbackStore(nodeRoot)
      .submit({text:'read me',attachments:[{filename:'r.png',mediaType:'image/png',
        data:new Uint8Array([1,2,3,4])}],provenance:PROVENANCE});
    cases.push({method:'storeRead',id:first.record.id});
    cases.push({method:'storeRead',id:'not-a-uuid'});
    cases.push({method:'storeRead',id:'00000000-0000-4000-8000-000000000000'});
    const attachment=first.record.attachments[0];
    cases.push({method:'readAttachment',attachment});
    cases.push({method:'readAttachment',
      attachment:{...attachment,sizeBytes:attachment.sizeBytes+1}});
    cases.push({method:'readAttachment',
      attachment:{...attachment,sha256:'0'.repeat(64)}});
    cases.push({method:'readAttachment',
      attachment:{...attachment,storageRef:'../outside.bin'}});
    const expected=[];
    for(const fixture of cases)expected.push(await nodeRun(fixture));
    // idempotency differential: fresh roots per stack
    const idemNode=mkdtempSync(join(tmpdir(),'rust2-fb-idn-'));
    const idemRust=mkdtempSync(join(tmpdir(),'rust2-fb-idr-'));
    const sub={text:'idem',idempotencyKey:'same-key',
      provenance:PROVENANCE};
    const n1=await new FileFeedbackStore(idemNode).submit(sub);
    const n2=await new FileFeedbackStore(idemNode).submit(
      {...sub,text:'different text'});
    const idemCases=[
      {method:'storeSubmit',text:'idem',idempotencyKey:'same-key'},
      {method:'storeSubmit',text:'different text',idempotencyKey:'same-key'},
    ];
    const idemExpected=[
      {ok:true,record:jsonable(n1.record),recordRef:'/records/'+n1.record.id+'.json'},
      {ok:true,record:jsonable(n2.record),recordRef:'/records/'+n2.record.id+'.json'},
    ];
    const allCases=cases.concat(idemCases);
    const allExpected=expected.concat(idemExpected);
    // Rust side mirrors Node: submits run against rustRoot (or idemRust for
    // the idempotency pair); read/attachment cases need the same first
    // record materialized inside rustRoot first.
    const mirror=await new Promise((resolvePromise,reject)=>{
      const child=spawn(binary,[],{cwd:root});
      let out='',err='';
      child.stdout.on('data',c=>out+=c);
      child.stderr.on('data',c=>err+=c);
      child.on('error',reject);
      child.on('close',code=>{
        if(code!==0)return reject(new Error(err||`parity mirror exited ${code}`));
        try{const parsed=JSON.parse(out.trim());
          const inner=parsed.value;
          if(!inner.record)throw new Error('parity mirror error: '
            +JSON.stringify(parsed).slice(0,200));
          resolvePromise(inner);}catch(e){
          reject(new Error(`parity mirror JSON: ${e.message}: ${out.slice(0,200)}`));}
      });
      child.stdin.end(JSON.stringify({op:'certFeedback',method:'storeSubmitRaw',
        root:rustRoot,text:'read me',
        attachments:[{filename:'r.png',mediaType:'image/png',data:[1,2,3,4]}],
        provenance:PROVENANCE})+'\n');
    });
    assert.ok(mirror.record,'mirror record missing');
    const mirroredAttachment={...first.record.attachments[0],
      storageRef:mirror.record.attachments[0].storageRef};
    const rustCases=allCases.map(f=>{
      const rootPath=f.method==='storeSubmit'
        ?(f.idempotencyKey?idemRust:rustRoot)
        :f.method==='readAttachment'?rustRoot
        :f.method==='storeRead'?rustRoot:rustRoot;
      const fixture={op:'certFeedback',root:rootPath,...f,
        provenance:f.provenance??PROVENANCE,
        attachments:f.attachments?.map(a=>({filename:a.filename,
          mediaType:a.mediaType,data:a.dataBytes??[104,101,106]}))};
      if(f.method==='readAttachment'){
        // Only the pristine case swaps in the mirrored storageRef; tampered
        // fixtures (size/sha/escape) keep their own storageRef override.
        const pristine=f.attachment.sizeBytes===attachment.sizeBytes
          &&f.attachment.sha256===attachment.sha256
          &&f.attachment.storageRef===attachment.storageRef;
        if(pristine)fixture.attachment=mirroredAttachment;
        else fixture.attachment={...f.attachment,
          storageRef:f.attachment.storageRef==='../outside.bin'
            ?'../outside.bin'
            :mirroredAttachment.storageRef};
      }
      if(f.method==='storeRead'&&f.id===first.record.id)
        fixture.id=mirror.record.id;
      if(f.method==='storeRead'&&f.id==='not-a-uuid'){
        // Both stacks reject this shape before touching the filesystem; the
        // Node guard runs inside read() as well, keep the fixture as-is.
      }
      return fixture;
    });
    const results=await parity(rustCases);
    compare(cases,expected,results.slice(0,cases.length),'store');
    // idempotency comparison: normalize record ids across stacks
    const idemGot=results.slice(cases.length);
    for(let i=0;i<idemExpected.length;i++){
      assert.equal(idemGot[i].ok,idemExpected[i].ok);
      if(idemGot[i].ok){
        assert.equal(idemGot[i].record.idempotencyKey,
          idemExpected[i].record.idempotencyKey);
        assert.equal(idemGot[i].record.userContent.text,
          idemExpected[i].record.userContent.text);
        assert.equal(idemGot[i].recordRef.startsWith('/records/'),true,
          idemGot[i].recordRef);
      }
    }
    console.log('Verified',allCases.length,'original Node/Rust feedback store cases');
  }finally{
    rmSync(nodeRoot,{recursive:true,force:true});
    rmSync(rustRoot,{recursive:true,force:true});
  }
});
