#!/usr/bin/env python3
"""Generate the comprehensive CLI action summary directly from the parameter matrix."""
import csv,collections,pathlib,sys
root=pathlib.Path(__file__).resolve().parent.parent
rows=list(csv.DictReader((root/'docs/rust-cli-parameter-parity.csv').open()))
assert rows and all(row['mark'] for row in rows)
group=collections.defaultdict(list)
for row in rows:group[row['cli']].append(row)
tick=chr(96)
lines=[
'# Native Rust Relay CLI action-by-action parity','',
'Every CLI command and every parameter is checked and marked. The authoritative per-parameter data is in '+tick+'docs/rust-cli-parameter-parity.csv'+tick+' and '+tick+'docs/rust-cli-parameter-parity.md'+tick+'.',
'PASS means real Rust-native executable evidence; PARTIAL / MISSING / NODE_MISMATCH remain blockers. RETIRED requires a sourced Node-side deprecation.','',
'| CLI command | PASS | PARTIAL | MISSING | RETIRED | Other | Current acceptance |',
'|---|---:|---:|---:|---:|---:|---|'
]
for cmd,items in sorted(group.items()):
    counts=collections.Counter(item['mark'] for item in items)
    other=sum(v for k,v in counts.items() if k not in {'PASS','PARTIAL','MISSING','RETIRED'})
    if cmd=='job merge':state='RETIRED (Node already rejects legacy PR merge)'
    elif counts['MISSING'] or counts['PARTIAL'] or other:state='NOT COMPLETE'
    else:state='PASS'
    lines.append('| '+tick+cmd+tick+' | '+str(counts['PASS'])+' | '+str(counts['PARTIAL'])+' | '+str(counts['MISSING'])+' | '+str(counts['RETIRED'])+' | '+str(other)+' | '+state+' |')
lines.extend(['',
'## Full-parity gate','',
'The command '+tick+'python3 scripts/rust-cli-parity-audit.py --require-parity'+tick+' must exit 0 before claiming complete Node CLI replacement. The audit is intentionally failing until all uncovered active commands and options are implemented or authoritatively retired.','',
'The read-only workflow actions and status APIs do not grant Graph mutation permission. Node is used only as a differential reference, not as a production service or fallback.',''])
out=root/'docs/rust-cli-head-to-head.md'
content='\n'.join(lines)
if '--check' in sys.argv:
    if not out.is_file() or out.read_text()!=content:
        sys.exit('Rust CLI command summary drift: regenerate from current per-parameter CSV')
    print('Rust CLI command summary synced:',len(group))
else:
    out.write_text(content)
    print('Rust CLI command summary generated:',len(group))
