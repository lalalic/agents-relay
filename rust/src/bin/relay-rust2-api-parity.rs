// Dedicated isolated SQLite API differential binary. Do not modify the
// shared Rust2 parity CLI while its legacy owner is still closing other APIs.
#[path = "relay-rust2-parity/sqlite_api.rs"]
mod sqlite_api;
use serde_json::{json,Value};
use std::io::{self,BufRead};
fn main(){
 for line in io::stdin().lock().lines(){
    let output=match line{
        Ok(line)=>match serde_json::from_str::<Value>(&line){
            Ok(request)=>match sqlite_api::invoke(&request){
                Ok(Some(raw))=>format!(r#"{{"ok":true,"value":{raw}}}"#),
                Ok(None)=>json!({"ok":false,"error":"unknown test API"}).to_string(),
                Err(error)=>json!({"ok":false,"error":error}).to_string(),
            },
            Err(error)=>json!({"ok":false,"error":error.to_string()}).to_string(),
        },
        Err(error)=>json!({"ok":false,"error":error.to_string()}).to_string(),
    };
    println!("{output}");
 }
}
