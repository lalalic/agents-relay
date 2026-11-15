//! Read-only local Git HEAD discovery for the native shadow CLI.
//! No process is spawned and no ref or worktree state is mutated.
use std::fs;
use std::path::{Component, Path, PathBuf};

fn valid_sha(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn read_regular(path: &Path) -> Result<Option<String>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("{}: {error}", path.display())),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 1_048_576 {
        return Err(format!(
            "unsafe or oversized Git metadata file: {}",
            path.display()
        ));
    }
    let canonical = path.canonicalize().map_err(|error| error.to_string())?;
    let text = fs::read_to_string(&canonical).map_err(|error| error.to_string())?;
    Ok(Some(text))
}

fn git_directory(repo: &Path) -> Result<(PathBuf, PathBuf), String> {
    let repo = repo
        .canonicalize()
        .map_err(|error| format!("Git repository missing: {error}"))?;
    if !repo.is_dir() {
        return Err("Git repository path is not a directory".into());
    }
    let dot_git = repo.join(".git");
    let metadata =
        fs::symlink_metadata(&dot_git).map_err(|error| format!(".git missing: {error}"))?;
    if metadata.file_type().is_symlink() {
        return Err(".git symlink is not accepted".into());
    }
    let git_dir = if metadata.is_dir() {
        dot_git.canonicalize().map_err(|error| error.to_string())?
    } else if metadata.is_file() {
        let contents = read_regular(&dot_git)?.ok_or(".git file missing")?;
        let target = contents
            .trim()
            .strip_prefix("gitdir: ")
            .filter(|value| !value.is_empty())
            .ok_or("invalid .git worktree pointer")?;
        let target = Path::new(target);
        let resolved = if target.is_absolute() {
            target.to_path_buf()
        } else {
            repo.join(target)
        };
        resolved
            .canonicalize()
            .map_err(|error| format!("Git directory missing: {error}"))?
    } else {
        return Err(".git must be a directory or worktree pointer file".into());
    };
    if !git_dir.is_dir() {
        return Err("Git metadata directory is not a directory".into());
    }
    let common = match read_regular(&git_dir.join("commondir"))? {
        Some(value) => {
            let path = Path::new(value.trim());
            let path = if path.is_absolute() {
                path.to_path_buf()
            } else {
                git_dir.join(path)
            };
            path.canonicalize()
                .map_err(|error| format!("Git common directory missing: {error}"))?
        }
        None => git_dir.clone(),
    };
    if !common.is_dir() {
        return Err("Git common metadata path is not a directory".into());
    }
    Ok((git_dir, common))
}

fn ref_name_is_safe(name: &str) -> bool {
    name.starts_with("refs/")
        && !name
            .bytes()
            .any(|byte| byte.is_ascii_control() || byte == b' ' || b"~^:?*[\\".contains(&byte))
        && Path::new(name)
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
        && !name.contains("..")
        && !name.contains("//")
        && !name.contains("@{")
        && !name.ends_with('/')
        && !name.ends_with('.')
        && !name.ends_with('@')
        && name
            .split('/')
            .all(|component| !component.is_empty() && !component.starts_with('.'))
        && name
            .split('/')
            .all(|component| !component.ends_with(".lock"))
}

fn loose_ref(git_dir: &Path, common: &Path, name: &str) -> Result<Option<String>, String> {
    for root in [git_dir, common] {
        let candidate = root.join(name);
        match fs::symlink_metadata(&candidate) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err("symbolic-link Git ref is not accepted".into())
            }
            Ok(_) => {
                let canonical = candidate
                    .canonicalize()
                    .map_err(|error| error.to_string())?;
                if !canonical.starts_with(root) {
                    return Err("Git ref escaped its metadata directory".into());
                }
                return read_regular(&canonical);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(None)
}

fn packed_ref(common: &Path, name: &str) -> Result<Option<String>, String> {
    let Some(contents) = read_regular(&common.join("packed-refs"))? else {
        return Ok(None);
    };
    for line in contents.lines() {
        if line.is_empty() || line.starts_with('#') || line.starts_with('^') {
            continue;
        }
        let mut fields = line.split_ascii_whitespace();
        let Some(sha) = fields.next() else { continue };
        if fields.next() == Some(name) && fields.next().is_none() {
            if !valid_sha(sha) {
                return Err("packed Git ref contains an invalid object ID".into());
            }
            return Ok(Some(sha.to_owned()));
        }
    }
    Ok(None)
}

fn resolve_ref(git_dir: &Path, common: &Path, name: &str) -> Result<String, String> {
    let mut current = name.to_owned();
    for _ in 0..8 {
        if !ref_name_is_safe(&current) {
            return Err("invalid symbolic Git ref".into());
        }
        let value = loose_ref(git_dir, common, &current)?
            .or(packed_ref(common, &current)?)
            .ok_or("Git HEAD ref is missing")?;
        let value = value.trim();
        if let Some(next) = value.strip_prefix("ref: ") {
            current = next.to_owned();
            continue;
        }
        if !valid_sha(value) {
            return Err("Git HEAD ref contains an invalid object ID".into());
        }
        return Ok(value.to_owned());
    }
    Err("Git symbolic ref chain is too deep".into())
}

/// Resolve an exact local worktree HEAD from Git metadata. Detached HEAD,
/// loose refs, packed refs, linked worktrees, and SHA-256 object IDs are read.
pub fn verified_local_head(repo: &Path) -> Result<String, String> {
    let (git_dir, common) = git_directory(repo)?;
    let head = read_regular(&git_dir.join("HEAD"))?.ok_or("Git HEAD missing")?;
    let head = head.trim();
    if let Some(reference) = head.strip_prefix("ref: ") {
        resolve_ref(&git_dir, &common, reference)
    } else if valid_sha(head) {
        Ok(head.to_owned())
    } else {
        Err("Git HEAD is neither a symbolic ref nor a full object ID".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    const SHA1: &str = "0123456789abcdef0123456789abcdef01234567";
    const SHA256: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn repository() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let dir = tempdir().unwrap();
        let repo = dir.path().join("repo");
        let git = repo.join(".git");
        fs::create_dir_all(&git).unwrap();
        (dir, repo, git)
    }

    #[test]
    fn reads_detached_and_loose_head() {
        let (_dir, repo, git) = repository();
        fs::write(git.join("HEAD"), format!("{SHA1}\n")).unwrap();
        assert_eq!(verified_local_head(&repo).unwrap(), SHA1);
        fs::write(git.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        fs::create_dir_all(git.join("refs/heads")).unwrap();
        fs::write(git.join("refs/heads/main"), format!("{SHA256}\n")).unwrap();
        assert_eq!(verified_local_head(&repo).unwrap(), SHA256);
    }

    #[test]
    fn reads_packed_refs_and_linked_worktree_head() {
        let (_dir, repo, git) = repository();
        fs::create_dir_all(git.join("refs/heads")).unwrap();
        fs::write(git.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        fs::write(
            git.join("packed-refs"),
            format!("# pack-refs\n{SHA1} refs/heads/main\n"),
        )
        .unwrap();
        assert_eq!(verified_local_head(&repo).unwrap(), SHA1);

        let worktree = repo.parent().unwrap().join("worktree");
        let worktree_git = git.join("worktrees/wt");
        fs::create_dir_all(&worktree_git).unwrap();
        fs::create_dir_all(&worktree).unwrap();
        fs::write(
            worktree.join(".git"),
            format!("gitdir: {}\n", worktree_git.display()),
        )
        .unwrap();
        fs::write(worktree_git.join("commondir"), "../..\n").unwrap();
        fs::write(worktree_git.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        assert_eq!(verified_local_head(&worktree).unwrap(), SHA1);
    }

    #[test]
    fn rejects_invalid_object_ids_and_symlinked_metadata() {
        let (_dir, repo, git) = repository();
        fs::write(git.join("HEAD"), "0123456\n").unwrap();
        assert!(verified_local_head(&repo).is_err());
        fs::remove_file(git.join("HEAD")).unwrap();
        let outside = repo.parent().unwrap().join("outside");
        fs::write(&outside, format!("{SHA1}\n")).unwrap();
        std::os::unix::fs::symlink(&outside, git.join("HEAD")).unwrap();
        assert!(verified_local_head(&repo).is_err());
    }

    #[test]
    fn rejects_malformed_ref_names_before_path_lookup() {
        for name in [
            "refs/heads/foo bar",
            "refs/heads/a//b",
            "refs/heads/a@{b",
            "refs/heads/.hidden",
            "refs/heads/name.lock",
        ] {
            assert!(!ref_name_is_safe(name), "accepted malformed ref {name}");
        }
        assert!(ref_name_is_safe("refs/heads/feature/clean-name"));
    }
}
