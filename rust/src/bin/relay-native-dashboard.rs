use agents_relay_rust::native_daemon::isolated_store_root;
use agents_relay_rust::store::RelayReader;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::{thread, time::Duration};
const HTML: &str = include_str!("../../assets/rust-live-dashboard.html");
fn argument(args: &[String], name: &str) -> Result<String, String> {
    if args.iter().filter(|a| a.as_str() == name).count() != 1 {
        return Err(format!("one {name} required"));
    }
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .cloned()
        .ok_or("missing argument value".into())
}
fn summarize(j: Value) -> Value {
    let tasks =
        j["tasks"]
            .as_array()
            .map(|all| {
                all.iter().map(|t|json!({
        "id":t["id"],"title":t["title"],"state":t["state"],"agent":t["agentName"]
    })).collect::<Vec<_>>()
            })
            .unwrap_or_default();
    json!({"id":j["id"],"title":j["title"],"state":j["state"],"runtimeStatus":j["runtimeStatus"],
        "createdAt":j["createdAt"],"updatedAt":j["updatedAt"],"repository":j["repository"],"tasks":tasks})
}
fn respond(tcp: &mut TcpStream, status: &str, ctype: &str, payload: &[u8]) -> Result<(), String> {
    let head=format!("HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\nContent-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'\r\nConnection: close\r\n\r\n",payload.len());
    tcp.write_all(head.as_bytes()).map_err(|e| e.to_string())?;
    tcp.write_all(payload).map_err(|e| e.to_string())
}
fn handle(mut tcp: TcpStream, db: &Path) -> Result<(), String> {
    tcp.set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|e| e.to_string())?;
    tcp.set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(tcp.try_clone().map_err(|e| e.to_string())?);
    let mut head = String::new();
    let bytes = reader.read_line(&mut head).map_err(|e| e.to_string())?;
    if bytes == 0 || bytes > 2048 {
        return respond(&mut tcp, "400 Bad Request", "text/plain", b"Bad request");
    }
    let fields = head.split_whitespace().collect::<Vec<_>>();
    if fields.len() != 3 || !matches!(fields[2], "HTTP/1.1" | "HTTP/1.0") {
        return respond(&mut tcp, "400 Bad Request", "text/plain", b"Bad request");
    }
    if fields[0] != "GET" {
        return respond(
            &mut tcp,
            "405 Method Not Allowed",
            "text/plain",
            b"Read only",
        );
    }
    let path = fields[1].split('?').next().unwrap_or("/");
    if path.len() > 120 {
        return respond(&mut tcp, "404 Not Found", "text/plain", b"Not found");
    }
    let reader = RelayReader::open(db)?;
    match path {
        "/" => respond(
            &mut tcp,
            "200 OK",
            "text/html; charset=utf-8",
            HTML.as_bytes(),
        ),
        "/api/health" => respond(
            &mut tcp,
            "200 OK",
            "application/json",
            json!({"backend":"rust-native","namespace":"rust-live","ok":true})
                .to_string()
                .as_bytes(),
        ),
        "/api/jobs" => {
            let jobs = reader
                .list_jobs(20, 0)?
                .into_iter()
                .map(|v| summarize(v.job))
                .collect::<Vec<_>>();
            respond(
                &mut tcp,
                "200 OK",
                "application/json",
                json!({"backend":"rust-native","namespace":"rust-live","jobs":jobs})
                    .to_string()
                    .as_bytes(),
            )
        }
        _ if path.starts_with("/api/jobs/") => {
            let id = &path["/api/jobs/".len()..];
            if id.is_empty() || id.len() > 20 || !id.bytes().all(|b| b.is_ascii_digit()) {
                return respond(&mut tcp, "404 Not Found", "application/json", b"{}");
            }
            match reader.get_job(id)? {
                Some(v) => respond(
                    &mut tcp,
                    "200 OK",
                    "application/json",
                    summarize(v.job).to_string().as_bytes(),
                ),
                None => respond(&mut tcp, "404 Not Found", "application/json", b"{}"),
            }
        }
        _ => respond(&mut tcp, "404 Not Found", "text/plain", b"Not found"),
    }
}
fn run() -> Result<(), String> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let db = PathBuf::from(argument(&args, "--db")?);
    isolated_store_root(&db)?;
    let port: u16 = argument(&args, "--port")?.parse().map_err(|_| "bad port")?;
    if port == 0 {
        return Err("port must be nonzero".into());
    }
    let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port))
        .map_err(|e| e.to_string())?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let stopped = Arc::new(AtomicBool::new(false));
    signal_hook::flag::register(signal_hook::consts::SIGTERM, Arc::clone(&stopped))
        .map_err(|e| e.to_string())?;
    signal_hook::flag::register(signal_hook::consts::SIGINT, Arc::clone(&stopped))
        .map_err(|e| e.to_string())?;
    println!(
        "{}",
        json!({"type":"ready","backend":"rust-native","port":port})
    );
    while !stopped.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((client, _)) => {
                if let Err(e) = handle(client, &db) {
                    eprintln!("native dashboard: {e}");
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(30))
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}
fn main() {
    if let Err(e) = run() {
        eprintln!("relay-native-dashboard: {e}");
        std::process::exit(2);
    }
}
