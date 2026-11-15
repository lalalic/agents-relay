// Node-compatible live status: native TCP client to the Rust Dashboard.
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

pub fn run(args: &[String]) -> Result<(), String> {
    let allowed = ["--host", "--port"];
    let mut options = HashMap::new();
    let mut pos = 0usize;
    while pos < args.len() {
        let key = args[pos].as_str();
        if !allowed.contains(&key) {
            return Err(format!("unknown status option {key}"));
        }
        if options.contains_key(key) {
            return Err(format!("duplicate {key}"));
        }
        let value = args
            .get(pos + 1)
            .filter(|v| !v.starts_with("--") && !v.is_empty())
            .ok_or_else(|| format!("{key} requires value"))?;
        options.insert(key, value.as_str());
        pos += 2;
    }
    let host = options.get("--host").copied().unwrap_or("127.0.0.1");
    // The Rust Dashboard is loopback-only; fail closed for remote status.
    if !matches!(host, "127.0.0.1" | "localhost") {
        return Err("Rust status only supports loopback --host; authenticated remote transport not implemented".into());
    }
    let port = options
        .get("--port")
        .copied()
        .unwrap_or("8787")
        .parse::<u16>()
        .map_err(|_| "--port must be an integer from 1 to 65535")?;
    if port == 0 {
        return Err("--port must be an integer from 1 to 65535".into());
    }
    let address = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("invalid status host: {e}"))?
        .find(|addr| addr.is_ipv4())
        .ok_or("status host has no IPv4 loopback address")?;
    let mut socket = TcpStream::connect_timeout(&address, Duration::from_secs(3))
        .map_err(|e| format!("Rust Relay unavailable at {host}:{port}: {e}"))?;
    socket
        .set_read_timeout(Some(Duration::from_secs(3)))
        .map_err(|e| e.to_string())?;
    socket
        .set_write_timeout(Some(Duration::from_secs(3)))
        .map_err(|e| e.to_string())?;
    socket
        .write_all(
            format!(
                "GET /api/runtime-summary HTTP/1.1\r\nHost: {host}:{port}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
            )
            .as_bytes(),
        )
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    socket
        .take(2_097_152)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let resp = String::from_utf8(bytes).map_err(|_| "status response is not UTF-8")?;
    let (head, body) = resp
        .split_once("\r\n\r\n")
        .ok_or("malformed Rust Relay status HTTP response")?;
    if !head
        .lines()
        .next()
        .is_some_and(|line| line.starts_with("HTTP/1.") && line.contains(" 200 "))
    {
        return Err(format!(
            "Rust Relay status HTTP error: {}",
            head.lines().next().unwrap_or("no status line")
        ));
    }
    let parsed: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("Rust Relay status invalid JSON: {e}"))?;
    if parsed["activeJobs"].as_u64().is_none()
        || parsed["runningTasks"].as_u64().is_none()
        || !parsed["workers"].is_object()
        || !parsed["running"].is_array()
        || !parsed["models"].is_array()
    {
        return Err("status response missing canonical RuntimeSummary fields".into());
    }
    println!("{parsed}");
    Ok(())
}
