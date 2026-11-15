#!/usr/bin/env python3
"""Bundle current canonical workflow Graph sources into native read-only CLI."""
from pathlib import Path
import sys
root=Path(__file__).resolve().parent.parent
paths=sorted(p.name for p in (root/'workflow').glob('*.mmd') if p.name!='main.mmd')
assert paths and all(name.endswith('.mmd') for name in paths)
lines=[
 '// Embedded executable Graph declarations from Node workflow/ (except dispatcher main.mmd).',
 '// Regenerate/check using scripts/rust-cli-graph-bundle.py --check.',
 'pub(super) const GRAPHS: &[(&str, &str)] = &[',
]
for name in paths:
    lines.extend(['    (','        "'+name+'",','        include_str!("../../../../workflow/'+name+'"),','    ),'])
lines.extend(['];',''])
output=root/'rust/src/bin/relay-native-job/workflow_graphs.rs'
desired='\n'.join(lines)
if '--check' in sys.argv:
    if not output.is_file() or output.read_text()!=desired:
        sys.exit('Rust workflow Graph bundle drift: regenerate and test before release')
    print('workflow bundle synced',len(paths))
else:
    output.write_text(desired)
    print('workflow bundle regenerated',len(paths))
