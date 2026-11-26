//! Native Codex Harness setup and trusted role delivery. The builder owns
//! first-use setup and prelaunch verification, never the Agent's dependencies.
use std::{
    fs, io,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SetupOutcome {
    AlreadyConfigured,
    LinkCreated,
    EmptyFileBackedUp,
}
fn canonical_source(global_home: &Path) -> Result<PathBuf, String> {
    if !global_home.is_absolute() {
        return Err("Global Agent root must be absolute".into());
    }
    let path = global_home.join("AGENTS.md");
    let source = fs::canonicalize(&path)
        .map_err(|e| format!("Global AGENTS.md unavailable at {}: {e}", path.display()))?;
    let info = fs::metadata(&source).map_err(|e| e.to_string())?;
    if !info.is_file() || info.len() == 0 || info.len() > 1024 * 1024 {
        return Err("Global AGENTS.md must be a nonempty document under 1 MiB".into());
    }
    let contents = fs::read(&source).map_err(|e| e.to_string())?;
    if contents.iter().all(u8::is_ascii_whitespace) {
        return Err("Global AGENTS.md contains no instructions".into());
    }
    Ok(source)
}
fn verify_link(link: &Path, source: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(link).map_err(|e| format!("Codex global link missing: {e}"))?;
    if !meta.file_type().is_symlink() {
        return Err(format!(
            "Codex AGENTS.md is not a symlink: {}",
            link.display()
        ));
    }
    if fs::canonicalize(link).map_err(|e| e.to_string())? != source {
        return Err(format!(
            "Codex Global AGENTS.md must point to {}",
            source.display()
        ));
    }
    Ok(())
}
/// Idempotently establish the native Global path, retaining any previous empty
/// regular file as a backup. Conflicting nonempty files, overrides and other
/// symlinks are errors, not inputs to be overwritten. No per-Task mutations
/// occur after successful first-use setup.
pub fn ensure_global(codex_home: &Path, global_home: &Path) -> Result<SetupOutcome, String> {
    if !codex_home.is_absolute() {
        return Err("CODEX_HOME must be absolute".into());
    }
    let source = canonical_source(global_home)?;
    match fs::symlink_metadata(codex_home) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            fs::create_dir_all(codex_home).map_err(|e| format!("Cannot create CODEX_HOME: {e}"))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(codex_home, fs::Permissions::from_mode(0o700))
                    .map_err(|e| format!("Cannot protect CODEX_HOME: {e}"))?;
            }
        }
        Err(e) => return Err(format!("Cannot inspect CODEX_HOME: {e}")),
        Ok(meta) if !meta.is_dir() || meta.file_type().is_symlink() => {
            return Err("CODEX_HOME must be a real directory".into())
        }
        _ => {}
    }
    // An override wins in Codex's actual instruction discovery. Never remove
    // it or claim that a symlink will be loaded when it is shadowed.
    match fs::symlink_metadata(codex_home.join("AGENTS.override.md")) {
        Ok(_) => return Err("Codex AGENTS.override.md shadows the canonical global rules".into()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("Cannot inspect Codex global override: {e}")),
    }
    let link = codex_home.join("AGENTS.md");
    match fs::symlink_metadata(&link) {
        Ok(meta) if meta.file_type().is_symlink() => {
            verify_link(&link, &source)?;
            return Ok(SetupOutcome::AlreadyConfigured);
        }
        Ok(meta) if meta.is_file() && meta.len() == 0 => {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_nanos();
            let backup = codex_home.join(format!(
                "AGENTS.md.empty-before-builder-{}-{stamp}",
                std::process::id()
            ));
            fs::rename(&link, &backup)
                .map_err(|e| format!("Cannot preserve old empty Codex AGENTS.md: {e}"))?;
            #[cfg(unix)]
            match std::os::unix::fs::symlink(&source, &link) {
                Ok(()) => {
                    verify_link(&link, &source)?;
                    return Ok(SetupOutcome::EmptyFileBackedUp);
                }
                Err(e) => {
                    // Restore only if the target is still absent; never
                    // replace another process's newly created symlink.
                    if fs::symlink_metadata(&link).is_err() {
                        let _ = fs::rename(&backup, &link);
                    }
                    return Err(format!("Cannot install Codex AGENTS.md link: {e}"));
                }
            }
            #[cfg(not(unix))]
            return Err("Automatic native Codex symlink setup requires Unix".into());
        }
        Ok(_) => {
            return Err(format!(
                "Refusing to overwrite existing Codex instructions: {}",
                link.display()
            ))
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("Cannot inspect Codex AGENTS.md: {e}")),
    }
    #[cfg(unix)]
    {
        match std::os::unix::fs::symlink(&source, &link) {
            Ok(()) => {
                verify_link(&link, &source)?;
                return Ok(SetupOutcome::LinkCreated);
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                verify_link(&link, &source)?;
                return Ok(SetupOutcome::AlreadyConfigured);
            }
            Err(e) => return Err(format!("Cannot install Codex global AGENTS.md: {e}")),
        }
    }
    #[cfg(not(unix))]
    Err("Automatic native Codex symlink setup requires Unix".into())
}
/// For Planner: the trusted runtime environment determines canonical Global
/// and CODEX_HOME, not Agent text, Job payload, or model provider hints.
pub fn ensure_host_global() -> Result<SetupOutcome, String> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or("Codex native setup requires HOME")?;
    let global = std::env::var_os("AGENTS_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".agents"));
    let codex = crate::model_routing::default_codex_home();
    let outcome = ensure_global(&codex, &global)?;
    if outcome != SetupOutcome::AlreadyConfigured {
        eprintln!("Codex Harness Global AGENTS.md configured: {outcome:?}");
    }
    Ok(outcome)
}
/// Exact native Codex transport settings for the trusted Prompt bundle.
/// Also consumed by offline Neo Eval, so that evaluation never re-implements
/// the System/User delivery policy.
pub fn delivery_flags(
    layers: &crate::agent_prompt_builder::PromptLayers,
) -> Result<Vec<String>, String> {
    if layers.system.trim().is_empty() || layers.user.trim().is_empty() {
        return Err("Codex requires both trusted Agent and current User Prompt".into());
    }
    // Native Codex exposes a local shell and the Neo Harness Skills List
    // command, but not necessarily a standalone Skill List tool. Keep
    // required_skills name-only in Relay; the Codex Harness tells the Agent
    // how to discover paths at execution time, without pre-reading SKILL.md.
    let has_required_skills = layers
        .references
        .iter()
        .any(|entry| entry["kind"] == "required-skill-name");
    let instructions = if has_required_skills {
        format!("{}\n\n# Codex Harness Skill discovery\nThe Harness Skills List is available via the read-only command 'neo skill list' (or 'neo skill list --project PATH' for the verified project). Use your native shell tool to inspect this list, match each required Skill name exactly, and then read the matching SKILL.md only when needed. Do not guess a path; report an unavailable required Skill as failure.",
            layers.system)
    } else {
        layers.system.clone()
    };
    let role = serde_json::to_string(&instructions).map_err(|e| e.to_string())?;
    Ok(vec![
        "-c".into(),
        "project_doc_max_bytes=0".into(),
        "-c".into(),
        format!("developer_instructions={role}"),
    ])
}
pub fn apply_prompt_layers(
    argv: &mut Vec<String>,
    layers: &crate::agent_prompt_builder::PromptLayers,
) -> Result<(), String> {
    if layers.system.trim().is_empty() || layers.user.trim().is_empty() {
        return Err("Codex requires a trusted Agent definition".into());
    }
    let index = argv
        .iter()
        .position(|v| v == "resume" || v == "--")
        .ok_or("Codex argv missing prompt boundary")?;
    if argv.last().map(String::as_str) != Some(layers.user.as_str()) {
        return Err("Codex User Prompt must be the exact final argument".into());
    }
    argv.splice(index..index, delivery_flags(layers)?);
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "codex-native-setup-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(root.join("global")).unwrap();
        fs::write(root.join("global/AGENTS.md"), "GLOBAL_CONTEXT_SENTINEL").unwrap();
        root
    }
    #[test]
    fn initial_setup_and_idempotent_validation() {
        let root = fixture();
        let home = root.join("codex");
        assert_eq!(
            ensure_global(&home, &root.join("global")).unwrap(),
            SetupOutcome::LinkCreated
        );
        assert_eq!(
            ensure_global(&home, &root.join("global")).unwrap(),
            SetupOutcome::AlreadyConfigured
        );
        assert_eq!(
            fs::canonicalize(home.join("AGENTS.md")).unwrap(),
            fs::canonicalize(root.join("global/AGENTS.md")).unwrap()
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn preserves_previous_empty_file() {
        let root = fixture();
        let home = root.join("codex");
        fs::create_dir_all(&home).unwrap();
        fs::write(home.join("AGENTS.md"), "").unwrap();
        assert_eq!(
            ensure_global(&home, &root.join("global")).unwrap(),
            SetupOutcome::EmptyFileBackedUp
        );
        let backups = fs::read_dir(&home)
            .unwrap()
            .flatten()
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("AGENTS.md.empty-before-builder")
            })
            .count();
        assert_eq!(backups, 1);
        assert_eq!(
            ensure_global(&home, &root.join("global")).unwrap(),
            SetupOutcome::AlreadyConfigured
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn protects_existing_conflicting_files_and_overrides() {
        let root = fixture();
        let home = root.join("codex");
        fs::create_dir_all(&home).unwrap();
        fs::write(home.join("AGENTS.md"), "CUSTOM").unwrap();
        assert!(ensure_global(&home, &root.join("global"))
            .unwrap_err()
            .contains("Refusing to overwrite"));
        assert_eq!(
            fs::read_to_string(home.join("AGENTS.md")).unwrap(),
            "CUSTOM"
        );
        fs::remove_file(home.join("AGENTS.md")).unwrap();
        fs::write(home.join("AGENTS.override.md"), "CUSTOM OVERRIDE").unwrap();
        assert!(ensure_global(&home, &root.join("global"))
            .unwrap_err()
            .contains("shadows"));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn native_flags_preserve_exact_role_and_project_suppression() {
        let layers = crate::agent_prompt_builder::PromptLayers::new(
            "PRIVATE_ROLE_713".into(),
            "TASK_713".into(),
            vec![],
        )
        .unwrap();
        let flags = delivery_flags(&layers).unwrap();
        assert_eq!(flags[1], "project_doc_max_bytes=0");
        assert_eq!(flags.len(), 4);
        let role = flags[3].strip_prefix("developer_instructions=").unwrap();
        assert_eq!(serde_json::from_str::<String>(role).unwrap(), layers.system);
        assert!(!flags.join(" ").contains("TASK_713"));
    }
    #[test]
    fn required_skills_announce_harness_discovery_without_paths_or_contents() {
        let layers = crate::agent_prompt_builder::PromptLayers::new(
            "EFFECTIVE_AGENT".into(),
            "TASK".into(),
            vec![serde_json::json!({"kind":"required-skill-name",
                "name":"ponytail","delivery":"harness-skills-list","loaded":false})],
        )
        .unwrap();
        let flags = delivery_flags(&layers).unwrap();
        let escaped = flags[3].strip_prefix("developer_instructions=").unwrap();
        let developer = serde_json::from_str::<String>(escaped).unwrap();
        assert!(developer.contains("neo skill list"));
        assert!(developer.contains("SKILL.md"));
        assert!(!developer.contains("/Users/"));
        assert!(!developer.contains("lite / full / ultra"));
        assert_eq!(layers.system, "EFFECTIVE_AGENT");
    }
    #[test]
    fn requires_trusted_agent_role() {
        let mut argv = vec!["exec".into(), "--json".into(), "--".into(), "task".into()];
        let layers = crate::agent_prompt_builder::PromptLayers::new(
            "ROLE_CONTEXT_SENTINEL".into(),
            "task".into(),
            vec![],
        )
        .unwrap();
        apply_prompt_layers(&mut argv, &layers).unwrap();
        assert_eq!(
            argv.iter()
                .filter(|v| v.starts_with("developer_instructions="))
                .count(),
            1
        );
        assert_eq!(
            argv.iter()
                .filter(|v| *v == "project_doc_max_bytes=0")
                .count(),
            1
        );
        assert!(
            crate::agent_prompt_builder::PromptLayers::new("".into(), "task".into(), vec![])
                .is_err()
        );
    }
}
