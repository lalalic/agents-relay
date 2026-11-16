// New rust2 autonomous-port planner: select still-PENDING baseline Node modules by unported dependency count and source size.
import { readFileSync } from 'node:fs';
import { join, dirname, normalize, resolve } from 'node:path';
import assert from 'node:assert/strict';

const repo = resolve(import.meta.dirname, '..');
const checklist = readFileSync(join(repo,'docs/RUST2_HEAD_TO_HEAD_CHECKLIST.md'),'utf8');
const pattern = /^\| `(src\/[^`]+\.(?:ts|js))` \| `(rust\/src\/[^`]+\.rs)` \| (PENDING|PORTING|PASS|EXCLUDED) \| ([^\n]+) \|$/gm;
const rows=[...checklist.matchAll(pattern)].map(([,source,target,status,evidence])=>({source,target,status,evidence}));
assert.equal(rows.length,227,'Unexpected Node baseline inventory: stop rather than silently skip files');
const bySource=new Map(rows.map(row=>[row.source,row]));
for(const row of rows){
 const text=readFileSync(join(repo,row.source),'utf8');
 row.lines=text.split('\n').length;
 row.dependsOn = [];
 // Count static Node import/re-export dependencies, including `import type`.
 for(const match of text.matchAll(/\bfrom\s*['"](\.\.?\/[^'"\s]+)['"]/g)){
  const candidate=normalize(join(dirname(row.source),match[1])).replace(/\.js$/,'.ts');
  if(bySource.has(candidate)&&!row.dependsOn.includes(candidate)) row.dependsOn.push(candidate);
 }
 row.unportedDependencies=row.dependsOn.filter(source=>bySource.get(source)?.status!=='PASS').length;
}
const limitIndex=process.argv.indexOf('--limit');
const limit=limitIndex<0?12:Number(process.argv[limitIndex+1]);
assert(Number.isSafeInteger(limit)&&limit>0&&limit<=227,'--limit must be 1–227');
const pending=rows.filter(row=>row.status==='PENDING').sort((a,b)=>
 a.unportedDependencies-b.unportedDependencies || a.lines-b.lines || a.source.localeCompare(b.source));
if(process.argv.includes('--json')){
 console.log(JSON.stringify({pass:rows.filter(x=>x.status==='PASS').length,pending:pending.length,batch:pending.slice(0,limit)},null,2));
}else{
 console.log(`rust2 pending ${pending.length}/${rows.length}; next ${Math.min(limit,pending.length)} by dependency readiness:`);
 for(const row of pending.slice(0,limit)) console.log(`${String(row.unportedDependencies).padStart(2)} deps  ${String(row.lines).padStart(4)} LOC  ${row.source}`);
}
