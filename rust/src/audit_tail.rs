// Node provenance: src/audit-tail.ts; reverse-reads JSONL records while ignoring malformed partial lines.
use serde_json::Value;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

pub fn read_jsonl_newest_first(path: impl AsRef<Path>) -> Result<Vec<Value>, String> {
    read_jsonl_latest(path, usize::MAX)
}

pub fn read_jsonl_latest(path: impl AsRef<Path>, limit: usize) -> Result<Vec<Value>, String> {
    if limit == 0 { return Ok(Vec::new()); }
    let mut file = match File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.to_string()),
    };
    let mut offset = file.metadata().map_err(|e| e.to_string())?.len();
    let mut prefix = Vec::new();
    let mut records = Vec::new();
    while offset > 0 {
        let len = std::cmp::min(64 * 1024, offset) as usize;
        offset -= len as u64;
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| e.to_string())?;
        let mut chunk = vec![0; len];
        file.read_exact(&mut chunk)
            .map_err(|_| "Short reverse audit read".to_string())?;
        chunk.extend_from_slice(&prefix);
        let mut end = chunk.len();
        for i in (0..chunk.len()).rev() {
            if chunk[i] != b'\n' {
                continue;
            }
            let line = &chunk[i + 1..end];
            end = i;
            if line.is_empty() {
                continue;
            }
            if let Ok(v) = serde_json::from_slice(line) {
                records.push(v);
                if records.len() == limit { return Ok(records); }
            }
        }
        prefix = chunk[..end].to_vec();
    }
    if !prefix.is_empty() {
        if let Ok(v) = serde_json::from_slice(&prefix) {
            records.push(v)
        }
    }
    Ok(records)
}
