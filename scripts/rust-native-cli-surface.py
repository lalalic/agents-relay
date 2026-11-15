#!/usr/bin/env python3
"""Inventory native Rust CLI flags independently of the Node compatibility matrix."""
import csv,pathlib,re,collections
ROOT=pathlib.Path(__file__).resolve().parent.parent
node=set()
for path in ROOT.glob('src/cli*.ts'):
    node.update(re.findall(r'--[a-z][a-z0-9-]*',path.read_text()))
sources={
 'relay-native-job':'rust/src/bin/relay-native-job.rs',
 'relay-native-job/foreground':'rust/src/bin/relay-native-job/foreground.rs',
 'relay-native-job/read-only':'rust/src/bin/relay-native-job/node_compat.rs',
 'relay-native-daemon':'rust/src/bin/relay-native-daemon.rs',
 'relay-native-dashboard':'rust/src/bin/relay-native-dashboard.rs',
 'agents-relay-rust/inspection':'rust/src/main.rs',
 'relay-worker-helper':'rust/src/bin/relay-worker-helper.rs',
}
rows=[]
for exe,rel in sorted(sources.items()):
    path=ROOT/rel
    assert path.exists(),rel
    text=path.read_text()
    flags=sorted(set(re.findall(r'--[a-z][a-z0-9-]*',text)))
    for flag in flags:
        i=text.find(flag)
        kind='NAME_OVERLAPS_NODE (not proof of semantics)' if flag in node else 'RUST_ONLY_OR_INTERNAL'
        rows.append(dict(binary_or_component=exe,flag=flag,classifier=kind,
                         rust_source=rel+':'+str(text.count(chr(10),0,i)+1)))
assert rows
out=ROOT/'docs/rust-native-cli-surface.csv'
with out.open('w',newline='') as f:
    w=csv.DictWriter(f,fieldnames=rows[0].keys(),lineterminator="\n");w.writeheader();w.writerows(rows)
print('native Rust CLI surface cells',len(rows),'components',len(sources),
      'Rust-only/internal',sum(r['classifier']=='RUST_ONLY_OR_INTERNAL' for r in rows))
