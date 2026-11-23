// Direct port of src/continuation.ts: three opt-in delivery transports.
// The host supplies an owned-process execution adapter and a fetch adapter.
// No CLI is invoked by this module; no credentials or endpoints are implicit.
pub enum Continuation<'a> {
    CodexThread { target: &'a str },
    Command { target: &'a str },
    Webhook { target: &'a str },
}
// Node's three public ContinuationAdapter classes each select one concrete
// delivery transport. All effects stay behind the host-provided owned-process
// and HTTP adapters; no executable or HTTP destination is implicit.
#[derive(Clone,Debug)]
pub struct CodexThreadContinuation {
    command:String,
}
impl Default for CodexThreadContinuation {
    fn default()->Self{Self::new("codex")}
}
impl CodexThreadContinuation {
    pub fn new(command:impl Into<String>)->Self{Self{command:command.into()}}
    pub fn kind(&self)->&'static str{"codex-thread"}
    pub fn r#continue<Run,Post>(
        &self,input:&str,continuation:Continuation<'_>,
        adapters:&mut ContinuationAdapters<'_,Run,Post>,
    )->Result<(),String>
    where Run:FnMut(&str,&[&str],&str)->Result<i32,String>,
          Post:FnMut(&str,&str)->Result<u16,String>,
    {
        continue_with_adapters(self.kind(),input,continuation,
            Some(&self.command),adapters)
    }
}
#[derive(Clone,Copy,Debug,Default)]
pub struct CommandContinuation;
impl CommandContinuation {
    pub fn new()->Self{Self}
    pub fn kind(&self)->&'static str{"command"}
    pub fn r#continue<Run,Post>(
        &self,input:&str,continuation:Continuation<'_>,
        adapters:&mut ContinuationAdapters<'_,Run,Post>,
    )->Result<(),String>
    where Run:FnMut(&str,&[&str],&str)->Result<i32,String>,
          Post:FnMut(&str,&str)->Result<u16,String>,
    {
        continue_with_adapters(self.kind(),input,continuation,None,adapters)
    }
}
#[derive(Clone,Copy,Debug,Default)]
pub struct WebhookContinuation;
impl WebhookContinuation {
    pub fn new()->Self{Self}
    pub fn kind(&self)->&'static str{"webhook"}
    pub fn r#continue<Run,Post>(
        &self,input:&str,continuation:Continuation<'_>,
        adapters:&mut ContinuationAdapters<'_,Run,Post>,
    )->Result<(),String>
    where Run:FnMut(&str,&[&str],&str)->Result<i32,String>,
          Post:FnMut(&str,&str)->Result<u16,String>,
    {
        continue_with_adapters(self.kind(),input,continuation,None,adapters)
    }
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
                &["exec", "resume",
                    crate::codex_permissions::FULL_ACCESS_NO_APPROVALS, target, input],
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

/// Real owned-process transport used by the continuation and DAG verifier.
/// Every child is supervised as a process group and is bound to this manager;
/// no shell evaluation, environment credentials, or ambient process kill.
use crate::owned_process::{OwnedProcessManager, OwnedProcessOptions, TerminationReason};
use std::{
    io::Read,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};

#[derive(Clone, Copy, Default)]
pub struct DeliveryProcessOptions<'a> {
    pub timeout: Option<Duration>,
    pub cancelled: Option<&'a AtomicBool>,
    pub supervisor_path: Option<&'a Path>,
    /// Optional complete process environment (Node spawn env replacement).
    pub environment: Option<&'a std::collections::HashMap<String, String>>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct DeliveryProcessResult {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Runs the genuine native owned-process implementation. Output reader threads
/// continuously drain pipes while the child is executing (avoids pipe deadlock).
/// Cancellation and deadline kill only the newly owned group.
pub fn run_delivery_owned_process(
    manager: &mut OwnedProcessManager,
    command: &str,
    args: &[&str],
    cwd: Option<&Path>,
    invocation: &str,
    options: DeliveryProcessOptions<'_>,
) -> Result<DeliveryProcessResult, String> {
    if options.cancelled.is_some_and(|c| c.load(Ordering::Acquire)) {
        return Err(format!("{invocation} aborted before launch"));
    }
    let process_options = OwnedProcessOptions {
        invocation: invocation.into(),
        cwd: cwd.map(Path::to_path_buf),
        timeout_ms: None,
        grace_ms: 150,
        supervisor_path: options.supervisor_path.map(Path::to_path_buf),
    };
    let process = if let Some(environment) = options.environment {
        manager.spawn_owned_process_piped_with_env(command, args, process_options, environment)?
    } else {
        manager.spawn_owned_process_piped(command, args, process_options)?
    };
    let stdout = process
        .take_stdout()
        .ok_or("Owned stdout pipe unavailable")?;
    let stderr = process
        .take_stderr()
        .ok_or("Owned stderr pipe unavailable")?;
    let out = thread::spawn(move || {
        let mut bytes = Vec::new();
        std::io::BufReader::new(stdout)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let err = thread::spawn(move || {
        let mut bytes = Vec::new();
        std::io::BufReader::new(stderr)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let started = Instant::now();
    let mut terminated = None;
    let exit = loop {
        if let Some(status) = process.exit_status()? {
            break status.code().unwrap_or(-1);
        }
        if terminated.is_none() {
            if options.cancelled.is_some_and(|c| c.load(Ordering::Acquire)) {
                process.terminate(TerminationReason::Cancel, None);
                terminated = Some("Owned process cancelled");
            } else if options
                .timeout
                .is_some_and(|limit| started.elapsed() >= limit)
            {
                process.terminate(TerminationReason::Timeout, None);
                terminated = Some("Owned process timed out");
            }
        }
        if terminated.is_some()
            && started.elapsed() > options.timeout.unwrap_or_default() + Duration::from_secs(5)
        {
            return Err(terminated.unwrap_or("Owned process failed").to_owned());
        }
        thread::sleep(Duration::from_millis(10));
    };
    let stdout = out
        .join()
        .map_err(|_| "Owned stdout reader panicked")?
        .map_err(|e| e.to_string())?;
    let stderr = err
        .join()
        .map_err(|_| "Owned stderr reader panicked")?
        .map_err(|e| e.to_string())?;
    if let Some(reason) = terminated {
        return Err(reason.into());
    }
    Ok(DeliveryProcessResult {
        code: exit,
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
    })
}

/// Production-shaped continuation transport. The selected command is not
/// invoked unless its requested continuation kind matches, mirroring Node.
pub fn continue_with_owned_process(
    kind: &str,
    input: &str,
    continuation: Continuation<'_>,
    command_override: Option<&str>,
    manager: &mut OwnedProcessManager,
    options: DeliveryProcessOptions<'_>,
) -> Result<(), String> {
    let mut run = |command: &str, args: &[&str], invocation: &str| {
        let result = run_delivery_owned_process(manager, command, args, None, invocation, options)?;
        Ok(result.code)
    };
    continue_with_http(kind, input, continuation, command_override, &mut run)
}
