// Companion mechanical helper for Node src/cli-support.ts used by cli-blocker and cli-revision.
// The Rust ports retain the same HTTP boundary and never touch the production Relay store.
use serde_json::Value;

pub fn arg<'a>(args: &'a [String], flag: &str, fallback: &'a str) -> &'a str {
    args.iter()
        .position(|s| s == flag)
        .and_then(|n| args.get(n + 1))
        .map(String::as_str)
        .unwrap_or(fallback)
}
pub fn has_arg(args: &[String], flag: &str) -> bool {
    args.iter().any(|s| s == flag)
}
pub fn repository(args: &[String]) -> Result<&str, String> {
    let repo = arg(args, "--repo", "");
    if repo.is_empty() {
        Err("--repo must name the local Git root directory".into())
    } else {
        Ok(repo)
    }
}
// Node fs/promises readFile errors are part of public CLI error parity.
pub fn read_file_utf8(path: &str) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => format!("ENOENT: no such file or directory, open '{path}'"),
        std::io::ErrorKind::PermissionDenied => format!("EACCES: permission denied, open '{path}'"),
        _ => e.to_string(),
    })
}
pub fn text_option(
    args: &[String],
    inline: &str,
    file: &str,
    stdin: Option<&str>,
) -> Result<String, String> {
    if has_arg(args, inline) && has_arg(args, file) {
        return Err(format!("{inline} and {file} are mutually exclusive"));
    }
    if has_arg(args, file) {
        let path = arg(args, file, "");
        if path.is_empty() {
            return Err(format!("{file} requires a path or - for stdin"));
        }
        if path == "-" {
            return Ok(stdin.unwrap_or("").to_string());
        }
        return read_file_utf8(path);
    }
    Ok(arg(args, inline, "").to_string())
}
fn endpoint(args: &[String], route: &str) -> Result<(String, String, String), String> {
    let host = arg(args, "--host", "127.0.0.1");
    let text = arg(args, "--port", "8787");
    let port: f64 = text.parse().unwrap_or(f64::NAN);
    if !port.is_finite() || port.fract() != 0. || !(1. ..=65535.).contains(&port) {
        return Err("--port must be an integer between 1 and 65535".into());
    }
    Ok((
        format!("http://{host}:{}{}", port as u16, route),
        host.to_string(),
        (port as u16).to_string(),
    ))
}
pub fn control(args: &[String], payload: &Value) -> Result<Value, String> {
    let (url, host, port) = endpoint(args, "/api/control")?;
    // These two Graph+SQLite transitions have execution-ID fencing and an
    // explicit idempotent replay contract. Other writes (create, cancel,
    // review) must never retry an uncertain HTTP POST automatically.
    let replay_safe=matches!(payload.get("command").and_then(Value::as_str),
        Some("job.reconcile"|"plan.apply"));
    for attempt in 0..3 {
        let once = (||{
            let response = ureq::post(&url)
                .config()
                .http_status_as_error(false)
                .build()
                .header("content-type", "application/json")
                .send_json(payload);
            match response {
                Ok(mut response) => {
                    if !response.status().is_success() {
                        let code = response.status();
                        let body = response.body_mut().read_to_string().unwrap_or_default();
                        return Err(format!(
                            "Agents Relay control command failed: {}",
                            if body.is_empty() {
                                format!("HTTP {code}")
                            } else {body}
                        ));
                    }
                    response.body_mut().read_json::<Value>()
                        .map_err(|e|e.to_string())
                }
                Err(err) => Err(format!(
                    "Agents Relay service unavailable at {host}:{port}: {err}"
                )),
            }
        })();
        let transient=replay_safe && attempt<2 && once.as_ref().err()
            .is_some_and(|error|error.contains("Resource temporarily unavailable")
                ||error.contains("operation would block")
                ||error.contains("WouldBlock")
                ||error.contains("Broken pipe")
                ||error.contains("Connection reset by peer")
                ||error.contains("connection reset")
                ||error.contains("unexpected EOF")
                ||error.contains("UnexpectedEof"));
        if !transient{return once;}
        std::thread::sleep(std::time::Duration::from_millis(25*(attempt+1)));
    }
    unreachable!("bounded idempotent control retry always returns")
}

pub fn job(args: &[String], job_id: &str) -> Result<Value, String> {
    let (url, host, port) = endpoint(args, "/api/job")?;
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    query.append_pair("id", job_id);
    let repo = arg(args, "--repo", "");
    if !repo.is_empty() {
        query.append_pair("repo", repo);
    }
    if has_arg(args, "--pr") {
        let value = arg(args, "--pr", "");
        let number = value.parse::<i64>().unwrap_or(0);
        if number <= 0 || number.to_string() != value {
            return Err(
                "--pr must be a positive integer (deprecated; use --id for normal operations)"
                    .into(),
            );
        }
        query.append_pair("pr", value);
    }
    let response = ureq::get(&format!("{url}?{}", query.finish()))
        .config()
        .http_status_as_error(false)
        .build()
        .call();
    match response {
        Ok(mut response) => {
            if !response.status().is_success() {
                let code = response.status();
                let body = response.body_mut().read_to_string().unwrap_or_default();
                return Err(format!(
                    "Agents Relay job request failed: {}",
                    if body.is_empty() {
                        format!("HTTP {code}")
                    } else {
                        body
                    }
                ));
            }
            response
                .body_mut()
                .read_json::<Value>()
                .map_err(|e| e.to_string())
        }
        Err(err) => Err(format!(
            "Agents Relay service unavailable at {host}:{port}: {err}"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn strict_argument_order_and_file_controls() {
        let a = vec!["--foo".into(), "v".into(), "--foo".into(), "later".into()];
        assert_eq!(arg(&a, "--foo", ""), "v");
        assert_eq!(text_option(&a, "--foo", "--from", None).unwrap(), "v");
        assert_eq!(
            repository(&a).unwrap_err(),
            "--repo must name the local Git root directory"
        );
    }
}
