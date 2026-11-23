//! One operator-approved Codex execution permission profile for every Relay role.
//! This affects Codex subprocess isolation only; Relay Task state and review
//! gates remain authoritative, and macOS account/TCC permissions still apply.
pub const FULL_ACCESS_NO_APPROVALS: &str =
    "--dangerously-bypass-approvals-and-sandbox";

pub fn exec_args(json:bool)->Vec<String>{
    let mut args=vec!["exec".to_owned()];
    if json { args.push("--json".into()); }
    args.push(FULL_ACCESS_NO_APPROVALS.into());
    args
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn all_new_execs_have_full_access_without_duplicate_flags(){
        for json in [true,false] {
            let args=exec_args(json);
            assert_eq!(args[0],"exec");
            assert_eq!(args.iter().filter(|a|a.as_str()==FULL_ACCESS_NO_APPROVALS).count(),1);
            assert!(!args.contains(&"--sandbox".to_owned()));
            assert_eq!(args.contains(&"--json".to_owned()),json);
        }
    }
}
