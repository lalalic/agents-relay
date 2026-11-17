// Direct port of src/github-auth.ts. GitHub App is optional historical
// compatibility, never a Job/PR lifecycle prerequisite. No network probe
// occurs unless the explicit caller-supplied adapter requests one.
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::Path,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GithubAppConfig {
    pub app_id: String,
    pub installation_id: String,
    pub private_key_file: String,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GithubAuthContext {
    pub app_auth: bool,
    pub trusted_authors: HashSet<String>,
}
fn flag(args: &[String], name: &str) -> String {
    args.iter()
        .position(|s| s == name)
        .and_then(|i| args.get(i + 1))
        .cloned()
        .unwrap_or_default()
}
fn env_value(env: &HashMap<String, String>, name: &str) -> String {
    env.get(name).cloned().unwrap_or_default()
}
pub fn github_app_config(
    args: &[String],
    env: &HashMap<String, String>,
) -> Result<Option<GithubAppConfig>, String> {
    let app_id = {
        let cli = flag(args, "--github-app-id");
        if cli.is_empty() {
            env_value(env, "AGENTS_RELAY_GITHUB_APP_ID")
        } else {
            cli
        }
    };
    let installation_id = {
        let cli = flag(args, "--github-app-installation-id");
        if cli.is_empty() {
            env_value(env, "AGENTS_RELAY_GITHUB_APP_INSTALLATION_ID")
        } else {
            cli
        }
    };
    let private_key_file = {
        let cli = flag(args, "--github-app-private-key-file");
        if cli.is_empty() {
            env_value(env, "AGENTS_RELAY_GITHUB_APP_PRIVATE_KEY_FILE")
        } else {
            cli
        }
    };
    let configured = [&app_id, &installation_id, &private_key_file]
        .into_iter()
        .filter(|s| !s.is_empty())
        .count();
    if configured == 0 {
        return Ok(None);
    }
    if configured != 3 {
        return Err(
            "GitHub App auth requires app id, installation id, and private key file".into(),
        );
    }
    Ok(Some(GithubAppConfig {
        app_id,
        installation_id,
        private_key_file,
    }))
}
/// make_client builds a host-owned GitHub API client; current_login and
/// local_login are injectable for deterministic tests. Without probe_login
/// no identity query reaches a cloud endpoint.
pub fn github_auth_context<C, Make, Current, Local>(
    args: &[String],
    env: &HashMap<String, String>,
    probe_login: bool,
    mut make_client: Make,
    mut current_login: Current,
    mut local_login: Local,
) -> Result<(C, GithubAuthContext), String>
where
    Make: FnMut(Option<(&str, &str, &str)>) -> Result<C, String>,
    Current: FnMut(&C) -> Result<String, String>,
    Local: FnMut(&C) -> Result<Option<String>, String>,
{
    let config = github_app_config(args, env)?;
    let key = if let Some(cfg) = &config {
        // Node readFile(file, 'utf8') replaces malformed UTF-8 rather than
        // failing before the client's App credential validator sees the key.
        let bytes = fs::read(Path::new(&cfg.private_key_file)).map_err(|e| e.to_string())?;
        Some(String::from_utf8_lossy(&bytes).into_owned())
    } else {
        None
    };
    let client = make_client(config.as_ref().zip(key.as_ref()).map(|(cfg, key)| {
        (
            cfg.app_id.as_str(),
            cfg.installation_id.as_str(),
            key.as_str(),
        )
    }))?;
    let mut authors = HashSet::new();
    if probe_login {
        authors.insert(current_login(&client)?);
    }
    let trusted = {
        let cli = flag(args, "--trusted-authors");
        if cli.is_empty() {
            env_value(env, "AGENTS_RELAY_TRUSTED_AUTHORS")
        } else {
            cli
        }
    };
    for entry in trusted.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        authors.insert(entry.to_owned());
    }
    if key.is_some() && probe_login {
        if let Some(local) = local_login(&client)? {
            if !local.is_empty() {
                authors.insert(local);
            }
        }
    }
    Ok((
        client,
        GithubAuthContext {
            app_auth: key.is_some(),
            trusted_authors: authors,
        },
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn config_precedence_and_no_partial_credentials() {
        let env = HashMap::from([
            ("AGENTS_RELAY_GITHUB_APP_ID".into(), "from-env".into()),
            (
                "AGENTS_RELAY_GITHUB_APP_INSTALLATION_ID".into(),
                "23".into(),
            ),
            (
                "AGENTS_RELAY_GITHUB_APP_PRIVATE_KEY_FILE".into(),
                "/tmp/missing-key".into(),
            ),
        ]);
        let args = vec!["--github-app-id".into(), "from-cli".into()];
        let config = github_app_config(&args, &env).unwrap().unwrap();
        assert_eq!(config.app_id, "from-cli");
        assert_eq!(config.installation_id, "23");
        assert_eq!(github_app_config(&[], &HashMap::new()).unwrap(), None);
        assert!(github_app_config(&args, &HashMap::new()).is_err());
    }
    #[test]
    fn optional_probe_and_trusted_authors() {
        let env = HashMap::from([(
            "AGENTS_RELAY_TRUSTED_AUTHORS".into(),
            " alice ,bob,alice ".into(),
        )]);
        let (_, ctx) = github_auth_context(
            &[],
            &env,
            false,
            |_| Ok(()),
            |_| panic!("probe disabled"),
            |_| panic!("probe disabled"),
        )
        .unwrap();
        assert_eq!(ctx.trusted_authors.len(), 2);
        assert!(!ctx.app_auth);
    }
}

#[cfg(test)]
mod native_app_client_tests {
    use super::*;
    #[test]
    fn client_factory_receives_exact_lossy_node_utf8_and_probes_in_order() {
        let path = std::env::temp_dir().join(format!("rust2-auth-key-{}", std::process::id()));
        fs::write(&path, [0xff, 0xfe, b'k', b'e', b'y']).unwrap();
        let args = vec![
            "--github-app-id".into(),
            "app1".into(),
            "--github-app-installation-id".into(),
            "7".into(),
            "--github-app-private-key-file".into(),
            path.to_string_lossy().to_string(),
            "--trusted-authors".into(),
            " alice, bob,alice ".into(),
        ];
        let calls = std::cell::RefCell::new(Vec::new());
        let (client, context) = github_auth_context(
            &args,
            &HashMap::new(),
            true,
            |opt| {
                calls.borrow_mut().push("construct");
                let (id, installation, key) = opt.unwrap();
                assert_eq!((id, installation), ("app1", "7"));
                assert_eq!(key, "\u{fffd}\u{fffd}key");
                Ok("fixture-client")
            },
            |_| {
                calls.borrow_mut().push("current");
                Ok("viewer".into())
            },
            |_| {
                calls.borrow_mut().push("local");
                Ok(Some("localuser".into()))
            },
        )
        .unwrap();
        assert_eq!(client, "fixture-client");
        assert_eq!(&*calls.borrow(), &["construct", "current", "local"]);
        assert_eq!(context.trusted_authors.len(), 4);
        assert!(context.trusted_authors.contains("viewer"));
        assert!(context.trusted_authors.contains("localuser"));
        assert!(context.app_auth);
        let _ = fs::remove_file(path);
    }
}
