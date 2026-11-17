// Source: Node src/**/*.ts and Rust rust/src/**/*.rs, pinned by the Rust2
// migration ledger. Static parity coverage audit only; it never runs Workers
// and never treats a matching symbol name as behavioral equivalence.
import ts from 'typescript';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');
const read = path => readFileSync(join(root, path), 'utf8');
const ledger = read('docs/RUST2_HEAD_TO_HEAD_CHECKLIST.md');
const rows = [...ledger.matchAll(/^\| `(src\/[^\x60]+\.(?:ts|js))` \| `(rust\/src\/[^\x60]+\.rs)` \| (PENDING|PORTING|PASS|EXCLUDED) \| ([^\n]+) \|$/gm)]
  .map(([,node, rust, status, evidence]) => ({node, rust, status, evidence}));
assert.equal(rows.length, 228, 'Unexpected Rust2 baseline ledger; do not silently skip sources');
const target = rows.filter(row => row.status === 'PORTING');
// The scope is always the current PORTING rows; do not freeze the count as PASS progresses.
for (const row of target) assert(existsSync(join(root,row.rust)), 'Missing Rust source for '+row.node);

const isExport = node => ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some(m => m.kind === ts.SyntaxKind.ExportKeyword);
const isDefault = node => ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some(m => m.kind === ts.SyntaxKind.DefaultKeyword);
const nonPublic = node => ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some(m =>
    m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword);
const nameOf = (node, source) => node?.name?.getText(source) ?? '';
function variableNames(name) {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap(item => variableNames(item.name));
}
function collectNodeExports(path) {
  const source = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true);
  const exports = [];
  const add = (name, kind, parent = null) => {
    if (!name) return;
    exports.push({name, kind, ...(parent ? {parent} : {})});
  };
  for (const node of source.statements) {
    if (ts.isExportDeclaration(node)) {
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const item of node.exportClause.elements)
          add(item.name.text, 'reexport');
      } else add('*', 'reexport-all');
      continue;
    }
    if (ts.isExportAssignment(node)) {
      add('default', 'default-expression');
      continue;
    }
    if (!isExport(node)) continue;
    if (ts.isFunctionDeclaration(node)) {
      add(node.name?.text ?? (isDefault(node) ? 'default' : ''), 'function');
    } else if (ts.isClassDeclaration(node)) {
      const className = node.name?.text ?? 'default';
      add(className, 'class');
      for (const member of node.members) {
        if (nonPublic(member)) continue;
        if (ts.isConstructorDeclaration(member)) {
          add('constructor', 'class-constructor', className);
        } else if (ts.isMethodDeclaration(member) ||
            ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
          const n = nameOf(member, source);
          if (!n.startsWith('[')) add(n, 'class-method', className);
        } else if (ts.isPropertyDeclaration(member)) {
          const n = nameOf(member, source);
          if (!n.startsWith('[')) add(n, 'class-property', className);
        }
      }
    } else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations)
        for (const name of variableNames(decl.name)) add(name, 'variable');
    } else if (ts.isInterfaceDeclaration(node)) {
      add(node.name.text, 'interface');
      // Interface members are type contracts, not directly runnable APIs.
    } else if (ts.isTypeAliasDeclaration(node)) {
      add(node.name.text, 'type');
    } else if (ts.isEnumDeclaration(node)) {
      add(node.name.text, 'enum');
    } else if (ts.isModuleDeclaration(node)) {
      add(node.name.text, 'namespace');
    }
  }
  return exports;
}
const canonical = s => s.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
const has = (list, symbol) => list.some(item => canonical(item) === canonical(symbol));
function collectRustSurface(path) {
  // Constrain to declaration-like syntax and omit doc comments. A symbol
  // occurrence in a string or unrelated impl can still be a false positive.
  // The result is a candidate match, NOT an AST-level semantic proof.
  const text = read(path).replace(/^\s*\/\/[^\n]*$/gm, '');
  const collect = re => [...text.matchAll(re)].map(match => match[1]);
  return {
    functions: collect(/\bpub(?:\([^)]*\))?\s+(?:(?:async|unsafe)\s+)*fn\s+([A-Za-z_]\w*)\b/g),
    methods: collect(/\b(?:pub(?:\([^)]*\))?\s+)?(?:(?:async|unsafe)\s+)*fn\s+([A-Za-z_]\w*)\b/g),
    types: collect(/\bpub(?:\([^)]*\))?\s+(?:(?:struct|enum|trait|type|union))\s+([A-Za-z_]\w*)\b/g),
    values: collect(/\bpub(?:\([^)]*\))?\s+(?:const|static)\s+([A-Za-z_]\w*)\b/g),
    source: text,
  };
}
function classification(api, rust) {
  const name = api.name;
  if (['function'].includes(api.kind)) return has(rust.functions, name) ? 'name-match' : 'unmapped';
  if (api.kind === 'variable') return has([...rust.functions,...rust.values], name) ? 'name-match' : 'unmapped';
  if (api.kind === 'class') return has(rust.types, name) ? 'name-match' : 'unmapped';
  if (api.kind === 'enum') return has(rust.types, name) ? 'name-match' : 'unmapped';
  if (api.kind === 'class-method') return has(rust.methods, name) ? 'name-match' : 'unmapped';
  if (api.kind === 'class-constructor') return has(rust.methods,'new') || has(rust.methods,'default') ? 'name-match' : 'review';
  if (api.kind === 'class-property') return 'review';
  if (api.kind === 'type' || api.kind === 'interface') return has(rust.types, name) ? 'name-match' : 'review';
  return 'review';
}
const testDir = join(root, 'rust/tests');
const diffTests = readdirSync(testDir).filter(file => /^head_to_head.*\.mjs$/.test(file))
  .map(file => ({file: 'rust/tests/'+file, text: read('rust/tests/'+file)}));
// Scan every Rust source directory, including workflow/ and bin/.
function listRustSourcePaths(directory) {
  return readdirSync(join(root,directory),{withFileTypes:true}).flatMap(entry => {
    const path=directory+'/'+entry.name;
    return entry.isDirectory() ? listRustSourcePaths(path) :
      entry.isFile() && path.endsWith('.rs') ? [path] : [];
  });
}
const rustFiles = listRustSourcePaths('rust/src').map(path => ({path,text:read(path)}));
const rustModuleName = path => basename(path,'.rs');
function findTestReferences(path) {
  const module = path.replace(/^src\//, '').replace(/\.(ts|js)$/, '.js');
  const suffix = 'dist/'+module;
  return diffTests.filter(t => t.text.includes(suffix)).map(t => t.file);
}
function findReferences(path) {
  const module = rustModuleName(path);
  const pattern = new RegExp('\\b'+module+'\\s*::|\\b'+module+'\\s*::\\s*\\{');
  return rustFiles.filter(f => f.path !== path && f.path !== 'rust/src/lib.rs' &&
    pattern.test(f.text)).map(f => f.path);
}
function countItems(items, value) { return items.filter(item => item.static === value).length; }
const inventory = target.map(row => {
  const rust = collectRustSurface(row.rust);
  const api = collectNodeExports(row.node).map(symbol => ({
    ...symbol, static: classification(symbol, rust)
  }));
  const runtime = api.filter(a => ['function','class','class-method','class-constructor','variable','enum'].includes(a.kind));
    return {
    source: row.node, target: row.rust, ledgerStatus: row.status,
    runtimeExports: runtime.length,
    directNameMatches: countItems(runtime, 'name-match'),
    unmappedRuntime: runtime.filter(x => x.static === 'unmapped').map(x =>
      (x.parent ? x.parent+'.' : '')+x.name),
    typeOrShapeReview: api.filter(x => x.static === 'review').map(x =>
      (x.parent ? x.parent+'.' : '')+x.name),
    directDiffImports: findTestReferences(row.node),
    otherRustModuleReferences: findReferences(row.rust),
    exports: api,
  };
});
const summary = {
  sourceTree: execFileSync('git',['rev-parse','HEAD:src'],{cwd:root,encoding:'utf8'}).trim(),
  rustTree: execFileSync('git',['rev-parse','HEAD:rust/src'],{cwd:root,encoding:'utf8'}).trim(),
  sourceCount: inventory.length,
  runtimeExportSymbols: inventory.reduce((sum,r) => sum+r.runtimeExports,0),
  directNameMatches: inventory.reduce((sum,r) => sum+r.directNameMatches,0),
  unmappedRuntimeSymbols: inventory.reduce((sum,r) => sum+r.unmappedRuntime.length,0),
  runtimeConstructorReviews: inventory.reduce((sum,r) => sum+r.exports.filter(x => x.kind==='class-constructor' && x.static==='review').length,0),
  typeOrShapeReviewSymbols: inventory.reduce((sum,r) => sum+r.typeOrShapeReview.length,0),
  filesWithUnmappedRuntime: inventory.filter(r => r.unmappedRuntime.length>0).length,
  filesWithoutDirectDiffImport: inventory.filter(r => !r.directDiffImports.length).length,
  filesWithoutOtherRustReferences: inventory.filter(r => !r.otherRustModuleReferences.length).length,
};
const output = {disclaimer: 'Static inventory only. Name matches and test imports do not establish behavior/API/side-effect parity.',summary,files:inventory};
function markdownEscape(s) {return String(s).replaceAll('|','\\|').replaceAll('\n',' ');}
const report = [
 '# Rust2 PORTING API surface audit',
 '',
 '> Generated with `node scripts/rust2-api-parity-audit.mjs --write`. Static candidate checks only: **do not upgrade a ledger row to PASS using this report alone**.',
 '',
 '## Interpretation',
 '',
 'This audit reads actual TypeScript exports, including exported class methods, and identifies plausible Rust declaration names. Missing names need investigation: Rust may implement them via a differently named method or adapter, so a missing direct match is **not** proof that an API is absent. Matched names are also not proof of matching signatures, effects or semantics.',
 '',
 'The exported class properties and interface/type aliases need additional structural or semantic review even when a name looks similar. This is not signature checking.',
 '',
 'A listed direct differential import only means a head-to-head test imports the compiled Node module; it does **not** show that every symbol or edge case is covered. A Rust module reference does **not** establish actual production wiring.',
 '',
 '## Snapshot',
 '',
 '| Metric | Count |',
 '|---|---:|',
 ...Object.entries(summary).filter(([key]) => !key.endsWith('Tree'))
   .map(([key,val]) => `| ${key} | ${val} |`),
 '',
 `Source tree: \`${summary.sourceTree.slice(0,12)}\`; Rust source tree: \`${summary.rustTree.slice(0,12)}\`. Rust module rows in scope: ${summary.sourceCount}. Full symbol details: [RUST2_API_PARITY_MATRIX.json](RUST2_API_PARITY_MATRIX.json).`,
 '',
 `## Per-file candidate surface (all ${summary.sourceCount} PORTING files)`,
 '',
 '| Node source | Runtime exports | Named Rust candidates | Unmapped runtime names | Direct diff imports | Other Rust refs |',
 '|---|---:|---:|---:|---:|---:|',
 ...inventory.map(r => `| \`${r.source}\` | ${r.runtimeExports} | ${r.directNameMatches} | ${r.unmappedRuntime.length} | ${r.directDiffImports.length} | ${r.otherRustModuleReferences.length} |`),
 '',
 '## Priority review: unmapped exported runtime symbols',
 '',
 ...inventory.filter(r => r.unmappedRuntime.length).sort((a,b) =>
    b.unmappedRuntime.length-a.unmappedRuntime.length || a.source.localeCompare(b.source))
    .map(r => `- **${r.source}** (${r.unmappedRuntime.length}): ${markdownEscape(r.unmappedRuntime.join(', '))}`),
 '',
 '## Required next verification',
 '',
 'For each file: inventory every runtime export and applicable type contract; map to the actual Rust signature/dispatch implementation; compare behavior on the same positive, negative, boundary and randomized fixtures; compare durable SQLite, files, Graph decisions, HTTP, events and restart/idempotency effects as applicable; test a real Rust entry point/caller. Only then consider ledger PASS.',
 '',
];
if (process.argv.includes('--write')) {
  mkdirSync(join(root,'docs'),{recursive:true});
  writeFileSync(join(root,'docs/RUST2_API_PARITY_MATRIX.json'), JSON.stringify(output,null,2)+'\n');
  writeFileSync(join(root,'docs/RUST2_API_PARITY_AUDIT.md'), report.join('\n').trimEnd()+'\n');
}
if (process.argv.includes('--check')) {
  assert.equal(read('docs/RUST2_API_PARITY_MATRIX.json'),JSON.stringify(output,null,2)+'\n','Stale JSON matrix: rerun --write');
  assert.equal(read('docs/RUST2_API_PARITY_AUDIT.md'),report.join('\n').trimEnd()+'\n','Stale Markdown audit: rerun --write');
}
if (process.argv.includes('--json')) console.log(JSON.stringify(summary,null,2));
else console.log('Rust2 PORTING API parity candidate audit:', summary);
