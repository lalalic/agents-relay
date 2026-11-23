import argparse,json,sqlite3
from pathlib import Path
parser=argparse.ArgumentParser()
parser.add_argument('--db',required=True)
args=parser.parse_args()
p=Path(args.db)
assert p.exists() and p.is_file()
conn=sqlite3.connect(p,timeout=30)
conn.execute('PRAGMA foreign_keys=ON')
assert conn.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='execution_process'").fetchone()[0]==1
cols=[r[1] for r in conn.execute('PRAGMA table_info(execution_process)')]
changed=[0]
def clean(v):
 if isinstance(v,dict):
  for k in ('leaseOwner','leaseExpiresAt'):
   if k in v:del v[k];changed[0]+=1
  for sub in v.values():clean(sub)
 elif isinstance(v,list):
  for sub in v:clean(sub)
rows=list(conn.execute('SELECT job_id,json FROM job_snapshot'))
conn.execute('BEGIN IMMEDIATE')
try:
 for job_id,raw in rows:
  doc=json.loads(raw)
  clean(doc)
  conn.execute('UPDATE job_snapshot SET json=? WHERE job_id=?',
               (json.dumps(doc,ensure_ascii=False,separators=(',',':')),job_id))
 if 'lease_owner' in cols:
  conn.execute('ALTER TABLE execution_process DROP COLUMN lease_owner')
 assert conn.execute('PRAGMA quick_check').fetchone()[0]=='ok'
 conn.commit()
except BaseException:
 conn.rollback()
 raise
print('migrated_jobs',len(rows),'removed_lease_json_keys',changed[0])
cols=[r[1] for r in conn.execute('PRAGMA table_info(execution_process)')]
print('process_columns',cols)
assert 'lease_owner' not in cols
assert conn.execute('SELECT COUNT(*) FROM job_snapshot WHERE json LIKE ? OR json LIKE ?',
                    ('%"leaseOwner"%','%"leaseExpiresAt"%')).fetchone()[0]==0
print('process_record_count',conn.execute('SELECT COUNT(*) FROM execution_process').fetchone()[0])
print('job720',conn.execute("SELECT json_extract(json,'$.tasks[1].state') FROM job_snapshot WHERE job_id='720'").fetchone())
conn.close()
