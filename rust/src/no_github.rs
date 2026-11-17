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

/// The latest Node local-Git-only CLI permanently disables GitHub-backed modes.
pub fn no_github_mode(
    _args: &[String],
    _process_args: &[String],
    _env_no_github: Option<&str>,
) -> bool {
    true
}
