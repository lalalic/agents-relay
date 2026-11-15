#!/usr/bin/env python3
"""Enumerate and individually mark Node Relay CLI parameter coverage in native Rust."""
import collections,csv,pathlib,re,sys
ROOT=pathlib.Path(__file__).resolve().parent.parent
HELP=(ROOT/'src/cli-help.ts').read_text()
TICK=chr(96)
entries={}
blocks={}
for match in re.finditer(r"(?m)^  (?:'([^']+)'|([a-z-]+)): "+TICK,HELP):
    name=match.group(1) or match.group(2)
    end=HELP.find(TICK+',',match.end())
    if end<0:raise AssertionError('unclosed '+name)
    entries[name]=set(re.findall(r'--[a-z][a-z0-9-]*',HELP[match.end():end]))
    blocks[name]=(match.end(),HELP[match.end():end])
for name in ['root','job','task','review','artifact','blocker','context','projection']:
    entries.pop(name,None)
extra={
'task unblock':'--id --task-id --repo --reason --response',
'task escalate':'--id --task-id --repo --required-action --resolution-condition --context',
'task resume-troubleshooter':'--id --task-id --repo --response',
'task complete':'--id --task-id --repo --execution-id',
'task recover':'--id --task-id --repo --recovery-task-id --failure-kind --reason --evidence --reroute --exclude-current-route',
'task comments':'--id --task-id --repo',
'plan apply':'--repo --id --plan-id --execution-id --file',
'plan context':'--repo --id --plan-id --execution-id',
'artifact validate':'--artifact --schema',
'review interactive':'--path --id --task-id --execution-id',
'review interactive begin':'--id --task-id --execution-id',
'review interactive wait':'--id --task-id --execution-id',
'review interactive ready':'--id --task-id --execution-id',
'review interactive fail':'--id --task-id --execution-id --reason',
'review interactive abort':'--id --task-id --execution-id --reason',
'blocker show':'--repo --id',
'projection conflicts':'--repo --id',
'projection resolve':'--repo --id --projection-id --action --note',
'migrate-local-repositories':'--database --mapping',
'workflow discover':'','workflow actions':'','workflow where':'--id',
'workflow inspect':'--graph',
'workflow evaluate':'--graph --event --state --facts',
'workflow verify':'--sqlite --job --condition --task --execution',
'workflow trace':'--sqlite --attempt-key',
'workflow action':'--graph --job --task --event',
'task list':'--id --repo','task show':'--id --repo --task-id',
'task retry':'--id --repo --task-id','task cancel':'--id --repo --task-id',
'job run':'--id --task-id --repo --project-path --workspace-root --shared-root --global-root --foreground --concurrency --codex --owner --lease-ms --no-github',
'job create':'--id --repo --title --objective-file --objective --project-root --project-path --coordinator-graph --coordinator-input --no-github --idempotency-key --github-repo',
'job update':'--local-merge-source --local-merge-target --continue-kind --continue-target --continue-input',
'init':'--file --no-review --no-auto-merge --continue-kind --continue-target',
'agent-register':'--agent-id --endpoint-kind --boundaries --labels --trust-domains --regions --adapter --availability',
'agent-discover':'--trust-domain',
'serve':'--refresh-ms --projection-ms --github-webhook-secret --usage-window-days --nats-url --subject-prefix --owner --lease-ms --planner-command --codex',
'reconcile':'--host --port --nats-url --subject-prefix --owner --lease-ms',
'plan':'--planner-command --codex --no-github',
'context resolve':'--workspace-root --shared-root --global-root',
'task create':'--agent-graph --attachments --store-dir',
'task update':'--agent-graph --attachments --store-dir',
'task classify':'--evidence-file --reason-file'}
for cmd,flags in extra.items():
    entries.setdefault(cmd,set()).update(flags.split())
node_rejected='--content-only --no-content-only --shortcut-execution --shortcut-local --legacy-shortcut-runtime --event-json --mode --execution-mode --schedule --schedule-next-run --schedule-timezone --missed-run-policy --schedule-concurrency --schedule-cron --cron'
reject=set(node_rejected.split())
for cmd in ['job create','job update','init']:
    entries[cmd].update(x for x in reject if x in {
        '--mode','--execution-mode','--schedule','--schedule-next-run','--schedule-timezone',
        '--missed-run-policy','--schedule-concurrency','--schedule-cron','--cron'})
entries['job run'].update(x for x in reject if x in {
    '--shortcut-local','--legacy-shortcut-runtime','--event-json','--mode'})
entries['job create'].update({'--base','--body','--head','--start'})
for cmd in ['task create','task update']:entries[cmd].update({'--content-only','--no-content-only','--shortcut-execution','--shortcut-local'})
source_flags=collections.defaultdict(set)
for src in ROOT.glob('src/cli*.ts'):
    if src.name=='cli-help.ts':continue
    for f in re.findall(r'--[a-z][a-z0-9-]*',src.read_text()):
        source_flags[f].add(str(src.relative_to(ROOT)))
known=set().union(*entries.values())
internal={'--args-file','--handoff-file'}
unscoped=set(source_flags)-known-internal-{'--help'}
entries['global help']={'--help','-h'}
if unscoped: entries['source-only audit']=unscoped
proof={
'job run':'--id --task-id --repo --foreground --concurrency',
'job show':'--id --repo','job list':'--repo',
'task list':'--id --repo','task show':'--id --repo --task-id',
'task events':'--id --repo --task-id --limit --order',
'status':'--port'}
proof={k:set(v.split()) for k,v in proof.items()}
partial={
'job run':'--project-path --no-github',
'status':'--host',
'job create':'--title --project-root',
'job update':'--title --priority',
'task create':'--title --priority --story-size --deps --parent --draft --dependency-validity --input-file --input --output --output-path',
'task cancel':'--task-id','task retry':'--task-id'}
partial={k:set(v.split()) for k,v in partial.items()}
partial_commands=set(proof)|set(partial)|{'reconcile','serve','status','escalation'}
def source_ref(cmd,flag):
    if cmd in blocks:
        offset,txt=blocks[cmd]
        i=txt.find(flag)
        if i>=0:return 'src/cli-help.ts:'+str(HELP.count(chr(10),0,offset+i)+1)
    if flag=='(none)':return 'src/cli.ts'
    for rel in ['src/cli.ts','src/cli-coordinator.ts','src/cli-review.ts',
                'src/cli-workflow.ts','src/cli-support.ts','src/cli-prompt.ts',
                'src/cli-worker-task.ts','src/cli-escalation.ts','src/cli-context.ts',
                'src/cli-blocker.ts','src/cli-projection.ts']:
        text=(ROOT/rel).read_text()
        i=text.find(flag)
        if i>=0:return rel+':'+str(text.count(chr(10),0,i)+1)+' (source token; confirm branch)'
    return 'manual command-contract enumeration (source branch confirmation required)'
def rust_ref(cmd,status):
    if status not in {'PASS','PARTIAL'}:return ''
    if cmd=='job run':return 'rust/src/bin/relay-native-job/foreground.rs'
    if cmd=='status':return 'rust/src/bin/relay-native-job/status.rs'
    if cmd in {'job list','job show','task list','task show','task events','global help'}:
        return 'rust/src/bin/relay-native-job/node_compat.rs'
    return 'rust/src/bin/relay-native-job.rs (partial pilot path)'
rows=[]
for cmd in sorted(entries):
    for flag in sorted(entries[cmd] or {'(none)'}):
        if cmd=='source-only audit':status='NEEDS_SCOPE';reason='Node source literal not yet assigned to specific CLI action'
        elif cmd=='job merge':status='RETIRED';reason='Node CLI throws legacy merge error; Graph owns local merge'
        elif flag in reject or (cmd=='job create' and flag in {'--base','--body','--head','--start'}):
            status='RETIRED';reason='Node handler explicitly rejects deprecated or task-only option'
        elif cmd=='status' and flag=='--port':status='PASS';reason='Rust Dashboard native HTTP status on random port E2E'
        elif cmd=='status' and flag=='--host':status='PARTIAL';reason='Localhost E2E PASS; remote host not supported yet'
        elif flag in proof.get(cmd,set()):status='PASS';reason='Real Rust-only Calculator Job 7 and read-only CLI smoke on 2026-11-15'
        elif cmd=='task events' and flag=='--after':
            status='PARTIAL';reason='Rust accepted --after 0, but multi-page cursor equivalence with Node is not verified'
        elif flag in partial.get(cmd,set()):status='PARTIAL';reason='Native option exists, but Node-compatible semantics not fully verified'
        elif cmd=='task complete':status='NODE_MISMATCH';reason='Node help advertises Task complete, but runtime action validator omits it'
        elif cmd=='global help':status='PARTIAL';reason='Rust help routes work, but exact Node per-command help content is not equivalent'
        else:status='MISSING';reason='Unimplemented or no verified Rust-native parameter parity'
        rows.append({'cli':cmd,'parameter':flag,'mark':status,'node_source':source_ref(cmd,flag),'rust_source':rust_ref(cmd,status),
                     'rust_evidence_or_gap':reason})
for flag in sorted(internal):
    rows.append({'cli':'internal subprocess','parameter':flag,'mark':'INTERNAL_NOT_USER',
                 'node_source':','.join(sorted(source_flags[flag])),'rust_source':'',
                 'rust_evidence_or_gap':'Flag passed to external child provider, not a public Relay CLI switch'})
assert len({(r['cli'],r['parameter']) for r in rows})==len(rows)
assert all(r['mark'] in {'PASS','PARTIAL','MISSING','RETIRED','NEEDS_SCOPE','NODE_MISMATCH','INTERNAL_NOT_USER'} for r in rows)
assert set(source_flags).issubset({r['parameter'] for r in rows})
assert not unscoped, 'source-only Node option lacked CLI command classification'
assert '--foreground' in entries['job run'] and 'migrate-local-repositories' in entries
csvpath=ROOT/'docs/rust-cli-parameter-parity.csv'
prior_csv=csvpath.read_bytes() if csvpath.exists() else None
mdpath=ROOT/'docs/rust-cli-parameter-parity.md'
prior_md=mdpath.read_bytes() if mdpath.exists() else None
with csvpath.open('w',newline='') as out:
    writer=csv.DictWriter(out,fieldnames=rows[0].keys(),lineterminator="\n")
    writer.writeheader();writer.writerows(rows)
counts=collections.Counter(r['mark'] for r in rows)
md=['# Node to Rust Relay CLI: per-parameter parity checklist','',
'Source: Node cli-help.ts and all src/cli*.ts flag literals. Every listed parameter has a current mark. PASS requires actual executable E2E evidence. Rust-only CLI options are documented separately.','',
'Actions/groups: '+str(len(entries))+'; individual parameter cells: '+str(len(rows))+'.',
'Counts: '+', '.join(k+'='+str(v) for k,v in sorted(counts.items()))+'.','',
'Full machine-readable checklist: docs/rust-cli-parameter-parity.csv','',
'## CLI-by-CLI verification','']
for cmd in sorted(entries):
    subset=[r for r in rows if r['cli']==cmd]
    states=collections.Counter(r['mark'] for r in subset)
    overall='RETIRED' if cmd=='job merge' else 'PARTIAL' if cmd in partial_commands else 'MISSING'
    if cmd=='source-only audit':overall='NEEDS_SCOPE'
    md.extend(['### '+cmd,'','Overall: '+overall+'. '+', '.join(k+'='+str(v) for k,v in sorted(states.items()))+'.','','| Parameter | Mark | Evidence or gap |','|---|---|---|'])
    for row in subset:
        md.append('| '+TICK+row['parameter']+TICK+' | '+row['mark']+' | '+row['rust_evidence_or_gap']+' |')
    md.append('')
md.extend(['## Exit gate','',
'Every command and parameter must have a verified PASS or explicit documented RETIRED decision. Missing and partial items block claims of parity. SOURCE_ONLY flags require confirmed owner classification. Node is only a differential reference; no production Node fallback.',''])
mdpath.write_text('\n'.join(md))
if '--check' in sys.argv:
    if prior_csv!=csvpath.read_bytes() or prior_md!=mdpath.read_bytes():
        sys.exit('CLI AUDIT DRIFT: regenerate and review the complete per-parameter checklist')
if '--require-parity' in sys.argv:
    blockers=[r for r in rows if r['mark'] in {'MISSING','PARTIAL','NODE_MISMATCH','NEEDS_SCOPE'}]
    if blockers:
        sys.exit('CLI PARITY NOT COMPLETE: '+str(len(blockers))+' unverified command/parameter cells')
print('actions',len(entries),'cells',len(rows),'marks',dict(counts),'source flags',len(source_flags),'unscoped',sorted(unscoped))
