#!/usr/bin/env python3
"""Offline, non-destructive one-database consolidation of numeric Relay Job stores.

Produces a candidate database, not a runtime cutover. Stop writers before invoking
for a coherent snapshot; retain source stores until runtime has been migrated.
"""
import argparse
import json
import pathlib
import sqlite3

TABLES = ('relay_meta', 'job_snapshot', 'pull_request_facts', 'publication_state',
          'publication_delivery', 'agent_snapshot', 'event_receipt',
          'execution_process', 'projection_outbox', 'host_invocation_event',
          'host_invocation_decision', 'projection_receipt')

def q(name):
    return '"' + name.replace('"', '""') + '"'

def consolidate(directory, target):
    if target.exists():
        raise RuntimeError(f'Destination exists: {target}. Refusing overwrite')
    source_files = sorted(directory.glob('*.db'))
    if not source_files:
        raise RuntimeError('No source SQLite databases')
    target.parent.mkdir(parents=True, exist_ok=True)
    dst = sqlite3.connect(target)
    dst.execute('PRAGMA foreign_keys=ON')
    dst.execute('PRAGMA journal_mode=WAL')
    dst.execute('PRAGMA busy_timeout=10000')
    counts = {}
    try:
        dst.execute('BEGIN IMMEDIATE')
        dst.execute('CREATE TABLE source_registry (job_id TEXT PRIMARY KEY, source_file TEXT NOT NULL UNIQUE, repository TEXT NOT NULL, pr_number INTEGER NOT NULL)')
        dst.execute('CREATE TABLE migration_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
        dst.execute('CREATE INDEX source_registry_repo_pr ON source_registry(repository,pr_number)')
        # Old schemas do not all have the same tables. Each logical table gains
        # scope_job_id to avoid colliding primary keys from different Jobs.
        specs = {}
        seen = set()
        for source in source_files:
            src = sqlite3.connect(source)
            try:
                jobs = src.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='job_snapshot'").fetchone()
                if not jobs:
                    continue
                job_rows = src.execute('SELECT job_id,json FROM job_snapshot').fetchall()
                if len(job_rows) != 1:
                    raise RuntimeError(f'Expected one Job per source, found {len(job_rows)}: {source}')
                jid, snapshot = job_rows[0]
                job = json.loads(snapshot)
                if not jid.isdecimal() or job.get('id') != jid:
                    raise RuntimeError(f'Source is not fully numeric-migrated: {source}')
                if jid in seen:
                    raise RuntimeError(f'Duplicate Job ID {jid}')
                seen.add(jid)
                dst.execute('INSERT INTO source_registry VALUES (?,?,?,?)', (jid, source.name, job['repository'], job['prNumber']))
                for table in TABLES:
                    if not src.execute('SELECT 1 FROM sqlite_master WHERE type="table" AND name=?',(table,)).fetchone():
                        continue
                    info = src.execute('PRAGMA table_info('+q(table)+')').fetchall()
                    if table not in specs:
                        specs[table] = [(col[1],col[2] or 'BLOB') for col in info]
                        cols = ', '.join(q(n)+' '+t for n,t in specs[table])
                        pk_cols=[row[1] for row in sorted(info,key=lambda r:r[5]) if row[5]]
                        has_job_id='job_id' in dict(specs[table])
                        # Tables already keyed by globally unique job_id need no extra scope.
                        # Legacy singleton tables are partitioned with a composite primary key.
                        scope_cols=[] if has_job_id else ['scope_job_id']
                        pk=[*scope_cols,*pk_cols]
                        prefix='' if has_job_id else 'scope_job_id TEXT NOT NULL REFERENCES source_registry(job_id), '
                        pk_sql=', PRIMARY KEY('+','.join(map(q,pk))+')' if pk_cols else ''
                        dst.execute('CREATE TABLE '+q(table)+' ('+prefix+cols+pk_sql+')')
                        if table=='projection_outbox':
                            dst.execute('CREATE UNIQUE INDEX projection_unified_idempotency ON projection_outbox(scope_job_id,idempotency_key)')
                            dst.execute('CREATE INDEX projection_unified_due ON projection_outbox(scope_job_id,status,next_attempt_at,priority DESC,id)')
                            dst.execute('CREATE INDEX projection_unified_coalesce ON projection_outbox(scope_job_id,coalesce_key,status)')
                        if table=='host_invocation_decision':
                            dst.execute('CREATE UNIQUE INDEX host_invocation_event_unique ON host_invocation_decision(job_id,task_id,event_id)')
                        if table=='job_snapshot':
                            dst.execute('CREATE INDEX job_snapshot_updated ON job_snapshot(updated_at)')
                        idx_col='job_id' if has_job_id else 'scope_job_id'
                        dst.execute('CREATE INDEX '+q('ix_'+table+'_job')+' ON '+q(table)+'('+idx_col+')')
                    elif specs[table] != [(col[1],col[2] or 'BLOB') for col in info]:
                        raise RuntimeError('Conflicting source schema for '+table)
                    cols = [name for name,_ in specs[table]]
                    rows = src.execute('SELECT '+','.join(map(q,cols))+' FROM '+q(table)).fetchall()
                    if rows:
                        if 'job_id' in cols:
                            dst.executemany('INSERT INTO '+q(table)+' ('+','.join(map(q,cols))+') VALUES ('+','.join('?' for _ in cols)+')',rows)
                        else:
                            dst.executemany('INSERT INTO '+q(table)+' (scope_job_id,'+','.join(map(q,cols))+') VALUES ('+','.join('?' for _ in range(len(cols)+1))+')',[(jid,*row) for row in rows])
                    counts[table] = counts.get(table,0)+len(rows)
            finally:
                src.close()
        sequence = directory/'entity-id-sequences.sqlite'
        if not sequence.is_file():
            raise RuntimeError('Global ID sequence database missing')
        with sqlite3.connect(sequence) as ids:
            for table in ('sequences','idempotency'):
                info = ids.execute('PRAGMA table_info('+q(table)+')').fetchall()
                cols = [(col[1],col[2] or 'BLOB') for col in info]
                pk_cols=[row[1] for row in sorted(info,key=lambda r:r[5]) if row[5]]
                pk_sql=', PRIMARY KEY('+','.join(map(q,pk_cols))+')' if pk_cols else ''
                dst.execute('CREATE TABLE '+q(table)+' ('+', '.join(q(n)+' '+t for n,t in cols)+pk_sql+')')
                rows = ids.execute('SELECT '+','.join(q(n) for n,_ in cols)+' FROM '+q(table)).fetchall()
                if rows:
                    dst.executemany('INSERT INTO '+q(table)+' ('+','.join(q(n) for n,_ in cols)+') VALUES ('+','.join('?' for _ in cols)+')',rows)
                counts[table] = len(rows)
        highwater = dst.execute("SELECT value FROM sequences WHERE repository='*' AND kind='job'").fetchone()
        if not highwater or highwater[0] < max(map(int,seen)):
            raise RuntimeError('Allocator sequence would reuse an existing Job ID')
        dst.execute('INSERT INTO migration_metadata VALUES (?,?)', ('schema','single-sqlite-staging-v1'))
        dst.execute('INSERT INTO migration_metadata VALUES (?,?)', ('job_count',str(len(seen))))
        dst.commit()
        dst.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        if dst.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise RuntimeError('Destination SQLite integrity check failed')
        if dst.execute('SELECT COUNT(*) FROM source_registry').fetchone()[0] != len(seen):
            raise RuntimeError('Destination Job registry count mismatch')
        if dst.execute('SELECT COUNT(*) FROM job_snapshot').fetchone()[0] != len(seen):
            raise RuntimeError('Destination snapshots count mismatch')
        print(json.dumps({'status':'candidate_validated','path':str(target),'jobs':len(seen),'source_files':len(source_files),'table_rows':counts},indent=2))
    except Exception:
        dst.rollback()
        dst.close()
        target.unlink(missing_ok=True)
        for suffix in ('-wal','-shm'):
            pathlib.Path(str(target)+suffix).unlink(missing_ok=True)
        raise
    finally:
        try:dst.close()
        except:pass

if __name__=='__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('source_dir', type=pathlib.Path)
    parser.add_argument('target_db', type=pathlib.Path)
    args = parser.parse_args()
    consolidate(args.source_dir,args.target_db)
