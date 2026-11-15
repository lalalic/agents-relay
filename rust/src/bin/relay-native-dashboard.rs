use agents_relay_rust::native_daemon::isolated_store_root;
use agents_relay_rust::store::RelayReader;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::{thread, time::Duration};

const HTML: &str = include_str!("../../assets/rust-live-dashboard.html");
const JOB_PAGE_SIZE: usize = 20;

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

fn summarize(job: Value) -> Value {
    let tasks = job["tasks"]
        .as_array()
        .map(|all| {
            all.iter()
                .map(|task| {
                    json!({
                        "id": task["id"], "title": task["title"],
                        "state": task["state"], "agent": task["agentName"]
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    json!({
        "id": job["id"], "title": job["title"], "state": job["state"],
        "runtimeStatus": job["runtimeStatus"], "createdAt": job["createdAt"],
        "updatedAt": job["updatedAt"], "repository": job["repository"], "tasks": tasks
    })
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn decode_query_component(value: &str) -> Result<String, String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => decoded.push(b' '),
            b'%' if index + 2 < bytes.len() => {
                let high = hex_value(bytes[index + 1]).ok_or("malformed query escape")?;
                let low = hex_value(bytes[index + 2]).ok_or("malformed query escape")?;
                decoded.push((high << 4) | low);
                index += 2;
            }
            b'%' => return Err("malformed query escape".into()),
            byte => decoded.push(byte),
        }
        index += 1;
    }
    String::from_utf8(decoded).map_err(|_| "query is not valid UTF-8".into())
}

fn query_parameters(target: &str) -> Result<HashMap<String, Vec<String>>, String> {
    let Some((_, raw)) = target.split_once('?') else {
        return Ok(HashMap::new());
    };
    let mut parameters: HashMap<String, Vec<String>> = HashMap::new();
    for pair in raw.split('&').filter(|pair| !pair.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let key = decode_query_component(key)?;
        let value = decode_query_component(value)?;
        parameters.entry(key).or_default().push(value);
    }
    Ok(parameters)
}

fn values<'a>(parameters: &'a HashMap<String, Vec<String>>, keys: &[&str]) -> Vec<&'a str> {
    keys.iter()
        .filter_map(|key| parameters.get(*key))
        .flatten()
        .map(String::as_str)
        .collect()
}

fn first_value<'a>(parameters: &'a HashMap<String, Vec<String>>, key: &str) -> Option<&'a str> {
    parameters
        .get(key)
        .and_then(|items| items.first())
        .map(String::as_str)
}

fn positive_integer(value: Option<&str>, default: usize) -> usize {
    value
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}

fn all_jobs(reader: &RelayReader) -> Result<Vec<Value>, String> {
    let mut jobs = Vec::new();
    let mut offset = 0_u32;
    loop {
        let page = reader.list_jobs(1000, offset)?;
        let page_len = page.len();
        jobs.extend(page.into_iter().map(|snapshot| summarize(snapshot.job)));
        if page_len < 1000 {
            break;
        }
        offset = offset
            .checked_add(page_len as u32)
            .ok_or("Job inventory offset overflow")?;
    }
    Ok(jobs)
}

fn jobs_page(
    reader: &RelayReader,
    parameters: &HashMap<String, Vec<String>>,
) -> Result<Value, String> {
    let jobs = all_jobs(reader)?;
    let requested_status = values(parameters, &["status", "statuses"]);
    let statuses = requested_status
        .into_iter()
        .flat_map(|value| value.split(','))
        .map(|value| value.trim().to_ascii_uppercase())
        .filter(|value| {
            matches!(
                value.as_str(),
                "DRAFT" | "ACTIVE" | "COMPLETED" | "CANCELLED"
            )
        })
        .collect::<Vec<_>>();
    let statuses = if statuses.is_empty() {
        vec!["DRAFT".into(), "ACTIVE".into(), "COMPLETED".into()]
    } else {
        statuses
    };
    let repositories = jobs
        .iter()
        .filter_map(|job| job["repository"].as_str())
        .filter(|repository| !repository.is_empty())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .map(str::to_string)
        .collect::<Vec<_>>();
    let selected_repositories = values(parameters, &["repo", "repositories", "repos"]);
    let search = first_value(parameters, "q")
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    let mut matching = jobs
        .into_iter()
        .filter(|job| {
            let state = job["state"].as_str().unwrap_or_default();
            let repository = job["repository"].as_str().unwrap_or_default();
            let title = job["title"].as_str().unwrap_or_default();
            let id = job["id"].as_str().unwrap_or_default();
            let status_match = statuses.iter().any(|status| status == state);
            let repository_match =
                selected_repositories.is_empty() || selected_repositories.contains(&repository);
            let search_match = search.is_empty()
                || title.to_lowercase().contains(&search)
                || id.to_lowercase().contains(&search);
            status_match && repository_match && search_match
        })
        .collect::<Vec<_>>();
    matching.sort_by(|left, right| {
        let lifecycle_group = |job: &Value| {
            if matches!(job["state"].as_str(), Some("COMPLETED" | "CANCELLED")) {
                1
            } else {
                0
            }
        };
        lifecycle_group(left)
            .cmp(&lifecycle_group(right))
            .then_with(|| {
                right["updatedAt"]
                    .as_str()
                    .unwrap_or_default()
                    .cmp(left["updatedAt"].as_str().unwrap_or_default())
            })
            .then_with(|| {
                left["repository"]
                    .as_str()
                    .unwrap_or_default()
                    .cmp(right["repository"].as_str().unwrap_or_default())
            })
            .then_with(|| {
                left["id"]
                    .as_str()
                    .unwrap_or_default()
                    .cmp(right["id"].as_str().unwrap_or_default())
            })
    });

    let total = matching.len();
    let page_size =
        positive_integer(first_value(parameters, "pageSize"), JOB_PAGE_SIZE).min(JOB_PAGE_SIZE);
    let total_pages = total.div_ceil(page_size).max(1);
    let page = positive_integer(first_value(parameters, "page"), 1).min(total_pages);
    let start = (page - 1) * page_size;
    let selected = matching
        .into_iter()
        .skip(start)
        .take(page_size)
        .collect::<Vec<_>>();
    Ok(json!({
        "backend": "rust-native", "namespace": "rust-live", "jobs": selected,
        "repositories": repositories, "total": total, "page": page,
        "pageSize": page_size, "totalPages": total_pages
    }))
}

fn respond(tcp: &mut TcpStream, status: &str, ctype: &str, payload: &[u8]) -> Result<(), String> {
    let head=format!("HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\nContent-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'\r\nConnection: close\r\n\r\n",payload.len());
    tcp.write_all(head.as_bytes()).map_err(|e| e.to_string())?;
    tcp.write_all(payload).map_err(|e| e.to_string())
}

fn respond_json(tcp: &mut TcpStream, status: &str, value: &Value) -> Result<(), String> {
    respond(
        tcp,
        status,
        "application/json; charset=utf-8",
        value.to_string().as_bytes(),
    )
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
    if fields[1].len() > 2048 {
        return respond(&mut tcp, "400 Bad Request", "text/plain", b"Bad request");
    }
    let path = fields[1].split('?').next().unwrap_or("/");
    if path.len() > 120 {
        return respond(&mut tcp, "404 Not Found", "text/plain", b"Not found");
    }
    let parameters = match query_parameters(fields[1]) {
        Ok(parameters) => parameters,
        Err(error) => {
            return respond_json(&mut tcp, "400 Bad Request", &json!({"error": error}));
        }
    };
    match path {
        "/" => respond(
            &mut tcp,
            "200 OK",
            "text/html; charset=utf-8",
            HTML.as_bytes(),
        ),
        "/api/health" => respond_json(
            &mut tcp,
            "200 OK",
            &json!({"backend":"rust-native","namespace":"rust-live","ok":true}),
        ),
        "/api/jobs" => {
            match RelayReader::open(db).and_then(|reader| jobs_page(&reader, &parameters)) {
                Ok(page) => respond_json(&mut tcp, "200 OK", &page),
                Err(error) => respond_json(
                    &mut tcp,
                    "500 Internal Server Error",
                    &json!({"error":error}),
                ),
            }
        }
        "/api/events" => {
            let Some(job_id) = first_value(&parameters, "job") else {
                return respond_json(
                    &mut tcp,
                    "400 Bad Request",
                    &json!({"error":"job is required"}),
                );
            };
            if job_id.is_empty()
                || !job_id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
            {
                return respond_json(
                    &mut tcp,
                    "400 Bad Request",
                    &json!({"error":"Invalid job id"}),
                );
            }
            let task_id = first_value(&parameters, "task");
            let limit = match first_value(&parameters, "limit") {
                None => 60,
                Some(value) => {
                    let parsed = if value.trim().is_empty() {
                        Some(0.0)
                    } else {
                        value.parse::<f64>().ok()
                    };
                    match parsed {
                        None => 60,
                        Some(number) if !number.is_finite() => 60,
                        Some(number)
                            if number.fract() != 0.0 || number.abs() > 9_007_199_254_740_991.0 =>
                        {
                            return respond_json(&mut tcp, "200 OK", &Value::Array(Vec::new()))
                        }
                        Some(number) => number.clamp(1.0, 60.0) as usize,
                    }
                }
            };
            let order = "desc";
            let task_id = task_id.filter(|task_id| !task_id.is_empty());
            let result = RelayReader::open(db)
                .and_then(|reader| reader.task_events(job_id, task_id, limit, order, 0));
            match result {
                Ok(page) => respond_json(&mut tcp, "200 OK", &Value::Array(page.events)),
                Err(error) if error.contains("not found") => {
                    respond_json(&mut tcp, "404 Not Found", &json!({"error":error}))
                }
                Err(error) => respond_json(&mut tcp, "400 Bad Request", &json!({"error":error})),
            }
        }
        _ if path.starts_with("/api/jobs/") && path.ends_with("/tasks") => {
            let id = &path["/api/jobs/".len()..path.len() - "/tasks".len()];
            if id.is_empty() || id.len() > 20 || !id.bytes().all(|b| b.is_ascii_digit()) {
                return respond_json(&mut tcp, "404 Not Found", &json!({}));
            }
            match RelayReader::open(db).and_then(|reader| reader.list_tasks(id)) {
                Ok(Some(tasks)) => respond_json(&mut tcp, "200 OK", &Value::Array(tasks)),
                Ok(None) => respond_json(&mut tcp, "404 Not Found", &json!({})),
                Err(error) if error.contains("not found") => {
                    respond_json(&mut tcp, "404 Not Found", &json!({"error":error}))
                }
                Err(error) => respond_json(
                    &mut tcp,
                    "500 Internal Server Error",
                    &json!({"error":error}),
                ),
            }
        }
        _ if path.starts_with("/api/jobs/") && path.contains("/tasks/") => {
            let Some((id, task_id)) = path["/api/jobs/".len()..].split_once("/tasks/") else {
                return respond_json(&mut tcp, "404 Not Found", &json!({}));
            };
            if id.is_empty()
                || id.len() > 20
                || !id.bytes().all(|b| b.is_ascii_digit())
                || task_id.is_empty()
                || task_id.len() > 20
                || !task_id.bytes().all(|b| b.is_ascii_digit())
            {
                return respond_json(&mut tcp, "404 Not Found", &json!({}));
            }
            match RelayReader::open(db).and_then(|reader| reader.get_task(id, task_id)) {
                Ok(Some(task)) => respond_json(&mut tcp, "200 OK", &task),
                Ok(None) => respond_json(&mut tcp, "404 Not Found", &json!({})),
                Err(error) if error.contains("not found") => {
                    respond_json(&mut tcp, "404 Not Found", &json!({"error":error}))
                }
                Err(error) => respond_json(
                    &mut tcp,
                    "500 Internal Server Error",
                    &json!({"error":error}),
                ),
            }
        }
        _ if path.starts_with("/api/jobs/") => {
            let id = &path["/api/jobs/".len()..];
            if id.is_empty() || id.len() > 20 || !id.bytes().all(|b| b.is_ascii_digit()) {
                return respond_json(&mut tcp, "404 Not Found", &json!({}));
            }
            match RelayReader::open(db).and_then(|reader| reader.get_job(id)) {
                Ok(Some(snapshot)) => respond_json(&mut tcp, "200 OK", &summarize(snapshot.job)),
                Ok(None) => respond_json(&mut tcp, "404 Not Found", &json!({})),
                Err(error) => respond_json(
                    &mut tcp,
                    "500 Internal Server Error",
                    &json!({"error":error}),
                ),
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
