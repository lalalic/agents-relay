//! Private same-user control socket for mutations owned by the native daemon.
//! Requests are deliberately typed and allowlisted; the daemon is the only
//! process that opens RelayAuthority for these production CLI mutations.
use crate::authority::{NativeObjectiveJobSpec, RelayAuthority};
use crate::native_daemon::isolated_store_root;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

const SOCKET_NAME: &str = ".rc.sock";
const MAX_REQUEST: usize = 64 * 1024;
const IO_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ControlRequest {
    pub version: u8,
    pub operation: String,
    pub repository: String,
    pub id: String,
    pub title: String,
    pub objective: String,
    pub project_root: String,
    pub project_path: Option<String>,
    pub priority: String,
    pub review_enabled: bool,
    pub auto_merge: bool,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ControlResponse {
    ok: bool,
    result: Option<Value>,
    error: Option<String>,
}

fn socket_path(db: &Path) -> Result<PathBuf, String> {
    let root = isolated_store_root(db)?;
    #[cfg(unix)]
    {
        let meta = fs::metadata(&root).map_err(|e| e.to_string())?;
        if meta.uid() != unsafe { libc::geteuid() } || meta.permissions().mode() & 0o777 != 0o700 {
            return Err("control socket root must be user-owned and mode 0700".into());
        }
    }
    Ok(root.join(SOCKET_NAME))
}
fn peer_uid(stream: &UnixStream) -> Result<u32, String> {
    #[cfg(target_os = "linux")]
    {
        let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
        let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        let result = unsafe {
            libc::getsockopt(
                stream.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                (&mut credentials as *mut libc::ucred).cast(),
                &mut length,
            )
        };
        if result != 0 || length as usize != std::mem::size_of::<libc::ucred>() {
            return Err("unable to authenticate control socket peer".into());
        }
        Ok(credentials.uid)
    }
    #[cfg(target_os = "macos")]
    {
        let mut credentials: libc::xucred = unsafe { std::mem::zeroed() };
        let mut length = std::mem::size_of::<libc::xucred>() as libc::socklen_t;
        let result = unsafe {
            libc::getsockopt(
                stream.as_raw_fd(),
                libc::SOL_LOCAL,
                libc::LOCAL_PEERCRED,
                (&mut credentials as *mut libc::xucred).cast(),
                &mut length,
            )
        };
        if result != 0 || length as usize != std::mem::size_of::<libc::xucred>() {
            return Err("unable to authenticate control socket peer".into());
        }
        Ok(credentials.cr_uid)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = stream;
        Err("same-user Unix peer credentials are unsupported on this platform".into())
    }
}
fn peer_is_authorized(peer: u32, expected: u32) -> bool {
    peer == expected
}
fn read_request(stream: &mut UnixStream) -> Result<ControlRequest, String> {
    stream
        .set_read_timeout(Some(IO_TIMEOUT))
        .map_err(|e| e.to_string())?;
    let mut data = Vec::with_capacity(1024);
    let mut byte = [0u8; 1];
    loop {
        match stream.read(&mut byte) {
            Ok(0) => return Err("incomplete control request".into()),
            Ok(_) if byte[0] == b'\n' => break,
            Ok(_) => {
                if data.len() == MAX_REQUEST {
                    return Err("control request exceeds 64 KiB".into());
                }
                data.push(byte[0]);
            }
            Err(e) => return Err(format!("control request read failed: {e}")),
        }
    }
    serde_json::from_slice(&data).map_err(|e| format!("invalid control request: {e}"))
}
fn write_response(stream: &mut UnixStream, response: ControlResponse) -> Result<(), String> {
    stream
        .set_write_timeout(Some(IO_TIMEOUT))
        .map_err(|e| e.to_string())?;
    let mut data = serde_json::to_vec(&response).map_err(|e| e.to_string())?;
    data.push(b'\n');
    stream
        .write_all(&data)
        .map_err(|e| format!("control response write failed: {e}"))
}
fn dispatch(db: &Path, request: ControlRequest) -> Result<Value, String> {
    if request.version != 1 || request.operation != "job.create" {
        return Err("unsupported native control operation".into());
    }
    if request.id.trim().is_empty() || request.id.len() > 128 {
        return Err("job.create requires an explicit Job ID of at most 128 bytes".into());
    }
    if request.repository.trim().is_empty() || request.repository.len() > 500 {
        return Err("repository identity must be nonempty and at most 500 bytes".into());
    }
    if request.title.trim().is_empty() || request.title.len() > 200 {
        return Err("title must be nonempty and at most 200 bytes".into());
    }
    if request.objective.trim().is_empty() || request.objective.len() > 1_048_576 {
        return Err("objective must be nonempty and at most 1 MB".into());
    }
    if !matches!(request.priority.as_str(), "P0" | "P1" | "P2" | "P3") {
        return Err("priority must be P0, P1, P2, or P3".into());
    }
    let project_root = PathBuf::from(&request.project_root);
    if !project_root.is_absolute() {
        return Err("project root must be absolute".into());
    }
    // Exact ID makes retries safe across daemon restart. A matching existing
    // Job is a readback; any identity/content mismatch is rejected.
    let mut authority = RelayAuthority::open_existing(db)?;
    if let Some(existing) = authority.read_job(&request.id)? {
        let matches = existing["repository"] == request.repository
            && existing["title"] == request.title
            && existing["objective"] == request.objective
            && existing["projectRoot"] == request.project_root
            && existing["projectPath"] == json!(request.project_path)
            && existing["priority"] == request.priority
            && existing["reviewEnabled"] == request.review_enabled
            && existing["autoMerge"] == request.auto_merge;
        if !matches {
            return Err("Job ID already exists with different immutable create identity".into());
        }
        return Ok(json!({"job":existing,"created":false,"deduplicated":true}));
    }
    let at = crate::supervised_script::current_time();
    let job = authority.create_native_objective_job(NativeObjectiveJobSpec {
        repository: &request.repository,
        id: Some(&request.id),
        title: &request.title,
        objective: &request.objective,
        project_root: &request.project_root,
        project_path: request.project_path.as_deref(),
        priority: &request.priority,
        review_enabled: request.review_enabled,
        auto_merge: request.auto_merge,
        at: &at,
    })?;
    Ok(json!({"job":job,"created":true,"deduplicated":false}))
}

/// Bound the daemon's listener lifetime to the daemon process. A stale socket
/// may be removed only after the single-writer daemon lock has been acquired.
pub struct NativeControlServer {
    listener: UnixListener,
    path: PathBuf,
}
impl NativeControlServer {
    pub fn bind(db: &Path) -> Result<Self, String> {
        let path = socket_path(db)?;
        if let Ok(meta) = fs::symlink_metadata(&path) {
            if !meta.file_type().is_socket() || meta.uid() != unsafe { libc::geteuid() } {
                return Err("refusing to replace non-owned control socket path".into());
            }
            fs::remove_file(&path).map_err(|e| format!("remove stale control socket: {e}"))?;
        }
        let listener =
            UnixListener::bind(&path).map_err(|e| format!("bind control socket: {e}"))?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("secure control socket: {e}"))?;
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        Ok(Self { listener, path })
    }

    /// Processes at most one queued request, synchronously between daemon ticks.
    pub fn serve_one(&self, db: &Path) -> Result<bool, String> {
        let (mut stream, _) = match self.listener.accept() {
            Ok(pair) => pair,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => return Ok(false),
            Err(e) => return Err(format!("control socket accept failed: {e}")),
        };
        let expected_uid = unsafe { libc::geteuid() };
        let response = match peer_uid(&stream) {
            Ok(uid) if peer_is_authorized(uid, expected_uid) => match read_request(&mut stream) {
                Ok(request) => match dispatch(db, request) {
                    Ok(result) => ControlResponse {
                        ok: true,
                        result: Some(result),
                        error: None,
                    },
                    Err(error) => ControlResponse {
                        ok: false,
                        result: None,
                        error: Some(error),
                    },
                },
                Err(error) => ControlResponse {
                    ok: false,
                    result: None,
                    error: Some(error),
                },
            },
            Ok(_) => ControlResponse {
                ok: false,
                result: None,
                error: Some("control socket peer UID mismatch".into()),
            },
            Err(error) => ControlResponse {
                ok: false,
                result: None,
                error: Some(error),
            },
        };
        write_response(&mut stream, response)?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::peer_is_authorized;

    #[test]
    fn control_socket_authorizes_only_the_daemon_uid() {
        assert!(peer_is_authorized(501, 501));
        assert!(!peer_is_authorized(502, 501));
    }
}
impl Drop for NativeControlServer {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

pub fn request(db: &Path, request: &ControlRequest) -> Result<Value, String> {
    let path = socket_path(db)?;
    let mut stream = UnixStream::connect(path)
        .map_err(|e| format!("native daemon control socket unavailable: {e}"))?;
    stream
        .set_write_timeout(Some(IO_TIMEOUT))
        .map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(IO_TIMEOUT))
        .map_err(|e| e.to_string())?;
    let mut data = serde_json::to_vec(request).map_err(|e| e.to_string())?;
    if data.len() > MAX_REQUEST {
        return Err("control request exceeds 64 KiB".into());
    }
    data.push(b'\n');
    stream
        .write_all(&data)
        .map_err(|e| format!("control request write failed: {e}"))?;
    let mut response = Vec::new();
    stream
        .take((MAX_REQUEST + 1) as u64)
        .read_to_end(&mut response)
        .map_err(|e| format!("control response read failed: {e}"))?;
    if response.len() > MAX_REQUEST {
        return Err("control response exceeds 64 KiB".into());
    }
    let response: ControlResponse =
        serde_json::from_slice(&response).map_err(|e| format!("invalid control response: {e}"))?;
    if !response.ok {
        return Err(response
            .error
            .unwrap_or_else(|| "daemon rejected control request".into()));
    }
    response
        .result
        .ok_or_else(|| "daemon returned no mutation readback".into())
}
