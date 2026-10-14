#!/usr/bin/env python3
"""One-time offline migration. Run while all Relay writers are stopped.

Atomic directory swap; old directory is retained as rollback. SQLite backups ensure
WAL content is included. Never treats arbitrary prose as structured references.
"""
import argparse, hashlib, json, pathlib, shutil, sqlite3, time

REF_KEYS={'jobId','job_id','blockerJobId','blocker_job','targetJobId','dependentJobId','p0Job','job'}

def rewrite(value, own_old, own_new, global_ids):
    if isinstance(value, list): return [rewrite(x, own_old, own_new, global_ids) for x in value]
    if isinstance(value, dict):
        result={}
        for key,item in value.items():
            if key=='id' and item==own_old: result[key]=own_new
            elif key in REF_KEYS and isinstance(item,str):
                if item==own_old: result[key]=own_new
                elif item in global_ids:
                    candidates=global_ids[item]
                    if len(candidates)!=1: raise ValueError('Ambiguous cross-store reference: '+item)
                    result[key]=candidates[0]
                else:result[key]=item
            else:result[key]=rewrite(item,own_old,own_new,global_ids)
        return result
    return value

def perform(directory):
    files=sorted(directory.glob('*.db'))
    jobs=[]
    for file in files:
        with sqlite3.connect(file) as db:
            if not db.execute("SELECT 1 FROM sqlite_master WHERE name='job_snapshot'").fetchone():continue
            for old,raw in db.execute('SELECT job_id,json FROM job_snapshot'):
                obj=json.loads(raw)
                if obj['id']!=old:raise ValueError('Snapshot id mismatch '+str(file))
                jobs.append((file,old,obj))
    if not jobs:raise ValueError('No jobs found')
    if any(old.isdecimal() for _,old,_ in jobs):raise ValueError('Numeric Job IDs already exist; migration refuses partial/repeated run')
    jobs.sort(key=lambda x:(x[2].get('createdAt',''),str(x[0]),x[1]))
    mapping={(f,old):str(i) for i,(f,old,_) in enumerate(jobs,1)}
    global_ids={}
    for (f,old),new in mapping.items():global_ids.setdefault(old,[]).append(new)
    stamp=time.strftime('%Y%m%d-%H%M%S',time.gmtime())
    staging=directory.parent/(directory.name+'.numeric-staging-'+stamp)
    backup=directory.parent/(directory.name+'.pre-numeric-'+stamp)
    if staging.exists() or backup.exists():raise ValueError('Staging/backup path exists')
    staging.mkdir()
    try:
        for file in files:
            with sqlite3.connect(file) as src, sqlite3.connect(staging/file.name) as dst:
                src.backup(dst)
        sequence_source=directory/'entity-id-sequences.sqlite'
        if not sequence_source.exists(): raise ValueError('Missing global ID allocator database')
        shutil.copy2(sequence_source, staging/sequence_source.name)
        for file,old,obj in jobs:
            new=mapping[file,old]
            target=staging/file.name
            with sqlite3.connect(target) as db:
                db.execute('BEGIN IMMEDIATE')
                for name in ['job_snapshot','publication_state','publication_delivery','execution_process','host_invocation_event','host_invocation_decision']:
                    if not db.execute('SELECT 1 FROM sqlite_master WHERE type="table" AND name=?',(name,)).fetchone():continue
                    cols=[row[1] for row in db.execute(f'PRAGMA table_info("{name}")')]
                    if 'job_id' in cols:db.execute(f'UPDATE "{name}" SET job_id=? WHERE job_id=?',(new,old))
                obj=rewrite(obj,old,new,global_ids)
                db.execute('UPDATE job_snapshot SET json=? WHERE job_id=?',(json.dumps(obj,separators=(',',':'),ensure_ascii=False),new))
                for name in ['publication_state','publication_delivery','projection_outbox','projection_receipt','host_invocation_event','host_invocation_decision']:
                    if not db.execute('SELECT 1 FROM sqlite_master WHERE type="table" AND name=?',(name,)).fetchone():continue
                    cols=[r[1] for r in db.execute(f'PRAGMA table_info("{name}")')]
                    for col in ['json','payload_json','detail_json','conflict_definition_json','conflict_evidence_json','conflict_resolution_json']:
                        if col not in cols:continue
                        rows=db.execute(f'SELECT rowid,"{col}" FROM "{name}" WHERE "{col}" IS NOT NULL').fetchall()
                        for rowid,val in rows:
                            try:data=json.loads(val)
                            except (ValueError,TypeError):continue
                            updated=rewrite(data,old,new,global_ids)
                            if updated!=data:db.execute(f'UPDATE "{name}" SET "{col}"=? WHERE rowid=?',(json.dumps(updated,separators=(',',':'),ensure_ascii=False),rowid))
                if db.execute('PRAGMA integrity_check').fetchone()[0]!='ok':raise ValueError('Integrity check failed '+str(file))
                db.commit()
                db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
                db.execute('PRAGMA journal_mode=DELETE')
            db.close()
            if file.name.startswith('job-'):
                newfilename='job-'+hashlib.sha256(new.encode()).hexdigest()+'.db'
                newpath=staging/newfilename
                if newpath.exists():raise ValueError('Target collision '+newfilename)
                target.rename(newpath)
        sequence=staging/'entity-id-sequences.sqlite'
        with sqlite3.connect(sequence) as db:
            db.execute('BEGIN IMMEDIATE')
            db.execute('INSERT INTO sequences(repository,kind,value) VALUES(?,?,?) ON CONFLICT(repository,kind) DO UPDATE SET value=MAX(value,excluded.value)',('*','job',len(jobs)))
            for old,ids in global_ids.items():
                if len(ids)>1:continue
                db.execute('UPDATE idempotency SET entity_id=? WHERE kind=? AND entity_id=?',(ids[0],'job',old))
            db.commit()
        observed=[]
        for file in sorted(staging.glob('*.db')):
            with sqlite3.connect(file) as db:
                if db.execute('PRAGMA integrity_check').fetchone()[0]!='ok':raise ValueError('Staged database invalid '+str(file))
                if db.execute("SELECT 1 FROM sqlite_master WHERE name='job_snapshot'").fetchone():
                    for old,raw in db.execute('SELECT job_id,json FROM job_snapshot'):
                        if not old.isdecimal() or json.loads(raw)['id']!=old:raise ValueError('Invalid migrated ID '+old)
                        observed.append(old)
        if len(observed)!=len(jobs) or len(set(observed))!=len(jobs):raise ValueError('Migrated Job count/uniqueness mismatch')
        print(json.dumps({'jobs':len(jobs),'stores':len(files),'backup':str(backup),'staging':str(staging),'sequence_high_water':len(jobs)},indent=2),flush=True)
        directory.rename(backup)
        try:staging.rename(directory)
        except BaseException:backup.rename(directory);raise
        print('MIGRATION_COMMITTED',flush=True)
    except BaseException:
        if staging.exists():shutil.rmtree(staging)
        raise

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('directory',type=pathlib.Path)
    args=parser.parse_args();perform(args.directory)
