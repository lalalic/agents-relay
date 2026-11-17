// Direct port of src/continuation.ts: three opt-in delivery transports.
// The host supplies an owned-process execution adapter and a fetch adapter.
// No CLI is invoked by this module; no credentials or endpoints are implicit.
pub enum Continuation<'a> {
    CodexThread { target: &'a str },
    Command { target: &'a str },
    Webhook { target: &'a str },
}
pub struct ContinuationAdapters<'a, Run, Post>
where
    Run: FnMut(&str, &[&str], &str) -> Result<i32, String>,
    Post: FnMut(&str, &str) -> Result<u16, String>,
{
    pub run_owned: &'a mut Run,
    pub post: &'a mut Post,
}
pub fn continue_with_adapters<Run, Post>(
    kind: &str,
    input: &str,
    continuation: Continuation<'_>,
    command_override: Option<&str>,
    adapters: &mut ContinuationAdapters<'_, Run, Post>,
) -> Result<(), String>
where
    Run: FnMut(&str, &[&str], &str) -> Result<i32, String>,
    Post: FnMut(&str, &str) -> Result<u16, String>,
{
    match (kind, continuation) {
        ("codex-thread", Continuation::CodexThread { target }) => {
            // Calling a host supplied owned-process adapter is the only spawn
            // boundary. The CLI itself is never launched in offline tests.
            let command = command_override.unwrap_or("codex");
            let code = (adapters.run_owned)(
                command,
                &["exec", "resume", target, input],
                "continuation.codex",
            )?;
            if code != 0 {
                return Err(format!("Codex continuation exited {code}"));
            }
        }
        ("command", Continuation::Command { target }) => {
            let code = (adapters.run_owned)(target, &[input], "continuation.command")?;
            if code != 0 {
                return Err(format!("Continuation exited {code}"));
            }
        }
        ("webhook", Continuation::Webhook { target }) => {
            let payload = serde_json::json!({"input":input}).to_string();
            let status = (adapters.post)(target, &payload)?;
            if !(200..=299).contains(&status) {
                return Err(format!("Continuation webhook returned {status}"));
            }
        }
        ("codex-thread", _) => return Err("Continuation is not a Codex thread".into()),
        ("command", _) => return Err("Continuation is not a command".into()),
        ("webhook", _) => return Err("Continuation is not a webhook".into()),
        (other, _) => return Err(format!("Unsupported continuation kind: {other}")),
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn command_success_and_exit_failure() {
        let mut seen = Vec::<(String, Vec<String>, String)>::new();
        let mut run = |cmd: &str, args: &[&str], invocation: &str| {
            seen.push((
                cmd.to_string(),
                args.iter().map(|s| s.to_string()).collect(),
                invocation.into(),
            ));
            Ok(0)
        };
        let mut post = |_: &str, _: &str| panic!("not a webhook");
        let mut adapters = ContinuationAdapters {
            run_owned: &mut run,
            post: &mut post,
        };
        continue_with_adapters(
            "command",
            "input",
            Continuation::Command {
                target: "/bin/echo",
            },
            None,
            &mut adapters,
        )
        .unwrap();
        assert_eq!(
            seen,
            vec![(
                "/bin/echo".into(),
                vec!["input".into()],
                "continuation.command".into()
            )]
        );
        let mut run = |_: &str, _: &[&str], _: &str| Ok(127);
        let mut adapters = ContinuationAdapters {
            run_owned: &mut run,
            post: &mut post,
        };
        assert_eq!(
            continue_with_adapters(
                "command",
                "input",
                Continuation::Command {
                    target: "/bin/false"
                },
                None,
                &mut adapters
            )
            .unwrap_err(),
            "Continuation exited 127"
        );
    }
    #[test]
    fn mismatched_kind_rejected_without_any_execution() {
        let mut run =
            |_: &str, _: &[&str], _: &str| -> Result<i32, String> { panic!("unexpected exec") };
        let mut post = |_: &str, _: &str| -> Result<u16, String> { panic!("unexpected request") };
        let mut adapters = ContinuationAdapters {
            run_owned: &mut run,
            post: &mut post,
        };
        assert_eq!(
            continue_with_adapters(
                "command",
                "input",
                Continuation::Webhook {
                    target: "https://not-called.invalid"
                },
                None,
                &mut adapters
            )
            .unwrap_err(),
            "Continuation is not a command"
        );
    }
    #[test]
    fn webhook_status_and_json_body() {
        let mut run =
            |_: &str, _: &[&str], _: &str| -> Result<i32, String> { panic!("unexpected exec") };
        let mut post = |target: &str, body: &str| -> Result<u16, String> {
            assert_eq!(target, "https://fixture.invalid");
            assert_eq!(body, r#"{"input":"message"}"#);
            Ok(503)
        };
        let mut adapters = ContinuationAdapters {
            run_owned: &mut run,
            post: &mut post,
        };
        assert_eq!(
            continue_with_adapters(
                "webhook",
                "message",
                Continuation::Webhook {
                    target: "https://fixture.invalid"
                },
                None,
                &mut adapters
            )
            .unwrap_err(),
            "Continuation webhook returned 503"
        );
    }
}

/// Native HTTP delivery transport. The caller still owns the local process
/// execution adapter, preventing an implicit Codex/CLI launch.
pub fn webhook_http_post(target: &str, body: &str) -> Result<u16, String> {
    let agent = ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .timeout_global(Some(std::time::Duration::from_secs(30)))
            .http_status_as_error(false)
            .build(),
    );
    agent
        .post(target)
        .header("content-type", "application/json")
        .send(body)
        .map(|response| response.status().as_u16())
        .map_err(|error| error.to_string())
}

pub fn continue_with_http<Run>(
    kind: &str,
    input: &str,
    continuation: Continuation<'_>,
    command_override: Option<&str>,
    mut run_owned: Run,
) -> Result<(), String>
where
    Run: FnMut(&str, &[&str], &str) -> Result<i32, String>,
{
    let mut post = webhook_http_post;
    continue_with_adapters(
        kind,
        input,
        continuation,
        command_override,
        &mut ContinuationAdapters {
            run_owned: &mut run_owned,
            post: &mut post,
        },
    )
}

#[cfg(test)]
mod native_webhook_tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
    };
    #[test]
    fn webhook_posts_json_and_reports_server_rejection() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            for reply in ["200 OK", "503 Service Unavailable"] {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(3)))
                    .unwrap();
                let mut data = Vec::new();
                let mut goal = None;
                loop {
                    let mut buf = [0u8; 4096];
                    let n = stream.read(&mut buf).unwrap();
                    if n == 0 {
                        break;
                    }
                    data.extend_from_slice(&buf[..n]);
                    if goal.is_none() {
                        if let Some(end) = data.windows(4).position(|v| v == b"\r\n\r\n") {
                            let header = String::from_utf8_lossy(&data[..end]);
                            let len = header
                                .lines()
                                .find_map(|l| {
                                    l.to_ascii_lowercase()
                                        .strip_prefix("content-length: ")
                                        .and_then(|n| n.trim().parse::<usize>().ok())
                                })
                                .unwrap_or(0);
                            goal = Some(end + 4 + len);
                        }
                    }
                    if goal.is_some_and(|total| data.len() >= total) {
                        break;
                    }
                }
                let req = String::from_utf8(data).unwrap();
                assert!(req.starts_with("POST /hook HTTP/1.1"));
                assert!(req
                    .to_lowercase()
                    .contains("content-type: application/json"));
                assert!(
                    req.ends_with(r#"{"input":"safe \u003ctext\u003e"}"#)
                        || req.ends_with(r#"{"input":"safe <text>"}"#)
                );
                stream
                    .write_all(
                        format!(
                            "HTTP/1.1 {reply}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        )
                        .as_bytes(),
                    )
                    .unwrap();
            }
        });
        let target = format!("http://{addr}/hook");
        assert!(continue_with_http(
            "webhook",
            "safe <text>",
            Continuation::Webhook { target: &target },
            None,
            |_, _, _| panic!("no process")
        )
        .is_ok());
        assert_eq!(
            continue_with_http(
                "webhook",
                "safe <text>",
                Continuation::Webhook { target: &target },
                None,
                |_, _, _| panic!("no process")
            )
            .unwrap_err(),
            "Continuation webhook returned 503"
        );
        server.join().unwrap();
    }
}
