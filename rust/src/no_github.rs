// Direct port of Node src/no-github.ts: fail-closed GitHub adapter and explicit disable-mode detection.
const GITHUB_DISABLED: &str = "GitHub disabled by --no-github";

/// Every GitHub transport method rejects before creating a request or probing a login.
#[derive(Clone, Copy, Debug, Default)]
pub struct DisabledGitHubClient;
impl DisabledGitHubClient {
    pub fn new() -> Self {
        Self
    }
    pub async fn request(&self) -> Result<(), String> {
        Err(GITHUB_DISABLED.to_string())
    }
    pub async fn graphql(&self) -> Result<(), String> {
        Err(GITHUB_DISABLED.to_string())
    }
    pub async fn rate_limit_snapshot(&self) -> Result<(), String> {
        Err(GITHUB_DISABLED.to_string())
    }
    pub async fn current_login(&self) -> Result<(), String> {
        Err(GITHUB_DISABLED.to_string())
    }
}

pub fn no_github_mode(
    args: &[String],
    process_args: &[String],
    env_no_github: Option<&str>,
) -> bool {
    args.iter().any(|arg| arg == "--no-github")
        || process_args.iter().any(|arg| arg == "--no-github")
        || env_no_github == Some("1")
}
