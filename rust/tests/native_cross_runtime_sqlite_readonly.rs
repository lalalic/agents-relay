//! Original Node-created SQLite database opens read-only from Rust after a
//! clean Node close. Offline WAL/-shm missing-owner edge is a separate HOLD.
use rusqlite::{Connection,OpenFlags};
use std::{fs,path::PathBuf,process::Command};
#[test]
fn cleanly_closed_node_unified_sqlite_opens_strictly_readonly_from_rust(){
    let root=PathBuf::from("/tmp").join(format!("r2-cross-sqlite-{}",std::process::id()));
    let _=fs::remove_dir_all(&root);fs::create_dir_all(root.join("stores")).unwrap();
    let db=root.join("relay.sqlite");
    let code=r#"import {SQLiteRelayStore} from './dist/relay-store.js';
      const scoped=new SQLiteRelayStore(process.env.TEST_DB,'101');
      await scoped.saveJob({id:'101',title:'Fixture',repository:'fixture',prNumber:0,
        state:'ACTIVE',projectRoot:'/tmp/test',tasks:[],plans:[],
        createdAt:'2026-11-18T19:00:00.000Z',updatedAt:'2026-11-18T19:00:00.000Z'});
      scoped.close();"#;
    let out=Command::new("node").current_dir("..").arg("--input-type=module").arg("--eval").arg(code)
        .env("TEST_DB",&db).output().unwrap();
    assert!(out.status.success(),"{}",String::from_utf8_lossy(&out.stderr));
    let ro=Connection::open_with_flags(&db,OpenFlags::SQLITE_OPEN_READ_ONLY);
    let rw=Connection::open_with_flags(&db,OpenFlags::SQLITE_OPEN_READ_WRITE);
    eprintln!("CROSS_RUNTIME: ro={:?}; rw={:?}; db={} size={}",
        ro.as_ref().map(|_|"OK").map_err(|e|format!("{e:?}")),
        rw.as_ref().map(|_|"OK").map_err(|e|format!("{e:?}")),
        db.display(),fs::metadata(&db).unwrap().len());
    assert!(ro.is_ok(),"Read-only inventory of original Node SQLite must be possible");
    fs::remove_dir_all(root).unwrap();
}
