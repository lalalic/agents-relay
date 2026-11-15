//! Read-only execution context and prompt CLI commands.
use agents_relay_rust::store::RelayReader;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::{Component, Path, PathBuf};

fn options(args: &[String], allowed: &[&str]) -> Result<BTreeMap<String, String>, String> {
    let mut result = BTreeMap::new();
    let mut i = 0;
    while i < args.len() {
        let key = args[i].as_str();
        if !allowed.contains(&key) {
            return Err(format!("unrecognized option {key}"));
        }
        if result.contains_key(key) {
            return Err(format!("duplicate option {key}"));
        }
        let value = args
            .get(i + 1)
            .filter(|v| !v.starts_with("--"))
            .ok_or_else(|| format!("missing value for {key}"))?;
        result.insert(key.to_owned(), value.clone());
        i += 2;
    }
    Ok(result)
}
fn no_traversal(path: &Path, label: &str) -> Result<(), String> {
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(format!("{label} must not contain '..'"));
    }
    Ok(())
}
fn canonical_dir(path: &Path, label: &str, required: bool) -> Result<PathBuf, String> {
    no_traversal(path, label)?;
    match path.canonicalize() {
        Ok(path) if path.is_dir() => Ok(path),
        Ok(_) => Err(format!("{label} is not a directory")),
        Err(e) if !required && e.kind() == std::io::ErrorKind::NotFound => Ok(path.to_path_buf()),
        Err(e) => Err(format!("{label} does not exist: {e}")),
    }
}
fn home() -> Result<PathBuf, String> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "HOME is not configured".into())
}
fn configured_root(
    explicit: Option<&String>,
    variable: &str,
    fallback: PathBuf,
    label: &str,
    required: bool,
) -> Result<PathBuf, String> {
    let value = explicit
        .map(PathBuf::from)
        .or_else(|| env::var_os(variable).map(PathBuf::from))
        .unwrap_or(fallback);
    canonical_dir(&value, label, required)
}
fn within(path: &Path, root: &Path) -> bool {
    path == root || path.starts_with(root)
}
fn safe_file(path: &Path, root: &Path) -> Option<PathBuf> {
    let canonical = path.canonicalize().ok()?;
    (canonical.is_file() && within(&canonical, root)).then_some(canonical)
}
fn layers(
    project: &Path,
    workspace: &Path,
    shared: Option<&Path>,
    global: &Path,
) -> Vec<(PathBuf, &'static str)> {
    let mut layers = vec![(global.to_path_buf(), "global")];
    if let Some(root) = shared {
        layers.push((root.to_path_buf(), "shared"));
    }
    if within(project, workspace) {
        let rel = project.strip_prefix(workspace).unwrap_or(Path::new(""));
        let parts = rel.components().collect::<Vec<_>>();
        let mut cursor = workspace.to_path_buf();
        layers.push((cursor.clone(), "parent"));
        for part in parts.iter().take(parts.len().saturating_sub(1)) {
            cursor.push(part);
            layers.push((cursor.clone(), "parent"));
        }
    }
    layers.push((project.to_path_buf(), "project"));
    let mut result = Vec::new();
    for layer in layers {
        if !result.iter().any(|(root, _)| root == &layer.0) {
            result.push(layer);
        }
    }
    result
}
fn frontmatter(path: &Path) -> BTreeMap<String, String> {
    let Ok(raw) = fs::read_to_string(path) else {
        return BTreeMap::new();
    };
    let mut lines = raw.lines();
    if lines.next() != Some("---") {
        return BTreeMap::new();
    }
    let mut fields = BTreeMap::new();
    for line in lines {
        if line == "---" {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            fields.insert(
                k.trim().to_owned(),
                v.trim().trim_matches(['\'', '"']).to_owned(),
            );
        }
    }
    fields
}
fn agent_body(raw: &str) -> Result<&str, String> {
    if !raw.starts_with("---\n") && !raw.starts_with("---\r\n") {
        return Ok(raw.trim());
    }
    let end = raw.find("\n---").ok_or("malformed Agent frontmatter")?;
    if raw[..end].lines().any(|line| {
        line.starts_with("extends:") || line.starts_with("mode:") || line.starts_with("sections:")
    }) {
        return Err("Rust prompt cannot safely merge layered Agent contracts yet".into());
    }
    Ok(raw[end + 4..].trim())
}
fn list(value: Option<&String>) -> Vec<String> {
    value
        .map(|v| {
            v.trim()
                .trim_start_matches('[')
                .trim_end_matches(']')
                .split([',', '|'])
                .map(|x| x.trim().trim_matches(['\'', '"']).to_owned())
                .filter(|x| !x.is_empty())
                .collect()
        })
        .unwrap_or_default()
}
fn csv(opts: &BTreeMap<String, String>, key: &str) -> Vec<String> {
    opts.get(key)
        .map(|v| {
            v.split(',')
                .filter(|x| !x.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}
fn add_files(
    root: &Path,
    source: &str,
    subdir: &str,
    extension: &str,
    output: &mut Vec<(PathBuf, String)>,
) {
    let dir = root.join(subdir);
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for item in entries.flatten() {
        let path = item.path();
        if path.extension().and_then(|x| x.to_str()) == Some(extension) {
            if let Some(path) = safe_file(&path, root) {
                output.push((path, source.to_owned()));
            }
        }
    }
}
fn project_root(path: &Path) -> Result<(PathBuf, PathBuf), String> {
    let project = canonical_dir(path, "--project-path", true)?;
    let mut cursor = project.as_path();
    let mut git_root = project.clone();
    loop {
        if cursor.join(".git").exists() {
            git_root = cursor.to_path_buf();
            break;
        }
        match cursor.parent() {
            Some(parent) => cursor = parent,
            None => break,
        }
    }
    if !within(&project, &git_root) {
        return Err("Project path escapes its canonical Git root".into());
    }
    Ok((project, git_root))
}
fn resolve_context(opts: &BTreeMap<String, String>, role: &str) -> Result<Value, String> {
    let project_arg = opts
        .get("--project-path")
        .ok_or("context resolve requires --project-path")?;
    let (project, git_root) = project_root(Path::new(project_arg))?;
    let home = home()?;
    let workspace = configured_root(
        opts.get("--workspace-root"),
        "AGENTS_RELAY_WORKSPACE_ROOT",
        home.join("Workspace"),
        "--workspace-root",
        opts.contains_key("--workspace-root")
            || env::var_os("AGENTS_RELAY_WORKSPACE_ROOT").is_some(),
    )?;
    let shared_value = opts
        .get("--shared-root")
        .map(PathBuf::from)
        .or_else(|| env::var_os("AGENTS_RELAY_SHARED_ROOT").map(PathBuf::from));
    let shared = shared_value
        .as_deref()
        .map(|p| canonical_dir(p, "shared capability root", true))
        .transpose()?;
    let global = configured_root(
        opts.get("--global-root"),
        "AGENTS_HOME",
        home.join(".agents"),
        "--global-root",
        false,
    )?;
    let layers = layers(&project, &workspace, shared.as_deref(), &global);
    let mut instructions: Vec<Value> = Vec::new();
    let mut instruction_roots = vec![(global.clone(), "global")];
    if within(&project, &workspace) {
        let relative = project.strip_prefix(&workspace).unwrap_or(Path::new(""));
        let mut cursor = workspace.clone();
        let source = if shared.as_deref().is_some_and(|root| within(&cursor, root)) {
            "shared"
        } else {
            "project"
        };
        instruction_roots.push((cursor.clone(), source));
        for part in relative.components() {
            cursor.push(part);
            let source = if cursor != project
                && shared.as_deref().is_some_and(|root| within(&cursor, root))
            {
                "shared"
            } else {
                "project"
            };
            instruction_roots.push((cursor.clone(), source));
        }
    } else {
        instruction_roots.push((project.clone(), "project"));
    }
    for (root, source) in instruction_roots {
        if let Some(path) = safe_file(&root.join("AGENTS.md"), &root) {
            if !instructions
                .iter()
                .any(|v| v["path"].as_str() == Some(path.to_string_lossy().as_ref()))
            {
                instructions.push(json!({"path":path,"source":source}));
            }
        }
    }
    if let Some(path) = safe_file(&project.join("README.md"), &project) {
        instructions.push(json!({"path":path,"source":"project"}));
    }
    let mut skills = BTreeMap::<String, Value>::new();
    for (root, source) in &layers {
        let Ok(entries) = fs::read_dir(root.join("skills")) else {
            continue;
        };
        for entry in entries.flatten() {
            if !entry.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let fallback = entry.file_name().to_string_lossy().to_string();
            let Some(path) = safe_file(&entry.path().join("SKILL.md"), root) else {
                continue;
            };
            let fields = frontmatter(&path);
            let name = fields
                .get("name")
                .filter(|n| !n.is_empty())
                .cloned()
                .unwrap_or(fallback);
            let mut item = json!({"name":name,"path":path,"source":source});
            if let Some(desc) = fields.get("description").filter(|x| !x.is_empty()) {
                item["description"] = json!(desc);
            }
            skills.insert(name, item);
        }
    }
    let explicit_skills = csv(opts, "--skills");
    let skills = if explicit_skills.is_empty() {
        skills.into_values().collect::<Vec<_>>()
    } else {
        explicit_skills
            .iter()
            .map(|name| {
                skills.get(name).cloned().ok_or_else(|| {
                    format!(
                        "Explicit skill {name} is not visible in the resolved execution context"
                    )
                })
            })
            .collect::<Result<Vec<_>, _>>()?
    };
    let mut agents_by_name = BTreeMap::<String, Value>::new();
    let bundled_agents = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or("Rust manifest parent missing")?
        .join("skills/agents-relay/agents");
    if bundled_agents.is_dir() {
        let mut files = Vec::new();
        add_files(&bundled_agents, "builtin", ".", "md", &mut files);
        for (path, source) in files {
            agent_item(path, source, &mut agents_by_name);
        }
    }
    for (root, source) in &layers {
        let mut files = Vec::new();
        add_files(root, source, "agents", "md", &mut files);
        let Ok(skill_dirs) = fs::read_dir(root.join("skills")) else {
            for (p, s) in files {
                agent_item(p, s, &mut agents_by_name);
            }
            continue;
        };
        for entry in skill_dirs.flatten() {
            if safe_file(&entry.path().join("SKILL.md"), root).is_some() {
                add_files(&entry.path(), source, "agents", "md", &mut files);
            }
        }
        for (p, s) in files {
            agent_item(p, s, &mut agents_by_name);
        }
    }
    let explicit_agents = csv(opts, "--agents");
    let agents = if explicit_agents.is_empty() {
        agents_by_name.into_values().collect::<Vec<_>>()
    } else {
        explicit_agents
            .iter()
            .map(|name| {
                agents_by_name.get(name).cloned().ok_or_else(|| {
                    format!(
                        "Explicit agent {name} is not visible in the resolved execution context"
                    )
                })
            })
            .collect::<Result<Vec<_>, _>>()?
    };
    Ok(
        json!({"project":{"name":project.file_name().and_then(|s|s.to_str()).unwrap_or("").to_owned(),"path":project,"gitRoot":git_root,"workspaceRoot":workspace,"sharedRoot":shared,"globalRoot":global},"role":role,"instructions":instructions,"skills":skills,"agents":agents,"runtimes":[],"delegation":{"mode":"relay-child-task","parentTaskIdRequired":role=="nested-worker"}}),
    )
}
fn agent_item(path: PathBuf, source: String, out: &mut BTreeMap<String, Value>) {
    let fields = frontmatter(&path);
    let name = fields.get("name").cloned().unwrap_or_else(|| {
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .trim_end_matches(".agent.md")
            .trim_end_matches(".md")
            .to_owned()
    });
    let values = |key: &str| list(fields.get(key));
    let mut item = json!({"name":name,"path":path,"source":source,"capabilities":values("capabilities"),"trustDomains":list(fields.get("trustDomains").or_else(||fields.get("trust_domains")).or_else(||fields.get("trust"))),"delegation":values("delegation"),"restrictions":list(fields.get("restrictions").or_else(||fields.get("boundaries")))});
    for (key, json_key) in [
        ("description", "description"),
        ("runtime", "runtime"),
        ("model", "preferredModel"),
        ("reasoning", "preferredReasoning"),
    ] {
        if let Some(v) = fields.get(key).filter(|v| !v.is_empty()) {
            item[json_key] = json!(v);
        }
    }
    if let Some(r) = fields
        .get("runtimes")
        .and_then(|v| list(Some(v)).first().cloned())
    {
        if item.get("runtime").is_none() {
            item["runtime"] = json!(r)
        }
    }
    item["suggestedSkills"] = json!(values("skills"));
    out.insert(name, item);
}
fn role_for(agent: &str) -> &'static str {
    if agent == "planner" {
        "planner"
    } else if agent == "troubleshooter" {
        "troubleshooter"
    } else if agent == "review-chair" || agent == "reviewer" || agent == "job-acceptance-reviewer" {
        "reviewer"
    } else {
        "worker"
    }
}
fn prompt(opts: &BTreeMap<String, String>) -> Result<String, String> {
    let adapter = opts.get("--adapter").map(String::as_str).unwrap_or("codex");
    if !["codex", "chatgpt", "z"].contains(&adapter) {
        return Err("prompt --adapter must be codex|chatgpt|z".into());
    }
    if opts.contains_key("--eval-file") {
        return Err("prompt --eval-file is not supported by the Rust CLI".into());
    }
    let task_id = opts.get("--task-id").ok_or("prompt requires --task-id")?;
    let job_id = opts.get("--id").ok_or("prompt requires --id")?;
    let db = PathBuf::from(
        opts.get("--db")
            .ok_or("prompt requires --db (read-only existing Relay SQLite snapshot)")?,
    );
    no_traversal(&db, "--db")?;
    if !db.is_absolute() {
        return Err("--db must be absolute".into());
    }
    let db = db
        .canonicalize()
        .map_err(|e| format!("--db does not exist: {e}"))?;
    let reader = RelayReader::open(&db)?;
    let job = reader
        .get_job(job_id)?
        .ok_or_else(|| format!("Job {job_id} not found"))?
        .job;
    if opts
        .get("--repo")
        .is_some_and(|r| job["repository"].as_str() != Some(r))
    {
        return Err("repository identity mismatch".into());
    }
    let task = job["tasks"]
        .as_array()
        .and_then(|items| items.iter().find(|t| t["id"].as_str() == Some(task_id)))
        .ok_or_else(|| format!("Task {task_id} not found in Job {job_id}"))?;
    let execution = task["executionId"]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| format!("Task {task_id} has no execution ID"))?;
    if job["repository"].as_str().is_none_or(str::is_empty) {
        return Err("Task prompt requires a recorded Job repository".into());
    }
    if !["codex", "chatgpt", "z"].contains(&task["adapter"].as_str().unwrap_or("")) {
        return Err(format!(
            "Task {task_id} does not have a supported recorded adapter"
        ));
    }
    if task["output"].is_null() {
        return Err(format!(
            "Task {task_id} requires an explicit output contract"
        ));
    }
    let agent = task["agentName"].as_str().unwrap_or("implementation");
    let role = role_for(agent);
    let project_path = opts
        .get("--project-path")
        .map(PathBuf::from)
        .or_else(|| job["projectPath"].as_str().map(PathBuf::from))
        .ok_or("Job has no projectPath; provide --project-path")?;
    let (project, git_root) = project_root(&project_path)?;
    if let Some(explicit) = opts.get("--project-path") {
        if Path::new(explicit)
            .canonicalize()
            .map_err(|e| e.to_string())?
            != project
        {
            return Err("invalid project path".into());
        }
    }
    let mut context_opts = opts.clone();
    context_opts.insert(
        "--project-path".into(),
        project.to_string_lossy().to_string(),
    );
    let context = resolve_context(&context_opts, role)?;
    let layersv = context["agents"].as_array().cloned().unwrap_or_default();
    let agent_file = layersv
        .iter()
        .find(|a| a["name"].as_str() == Some(agent))
        .and_then(|a| a["path"].as_str())
        .ok_or_else(|| format!("Agent {agent} is not visible in the resolved execution context"))?;
    let agent_raw = fs::read_to_string(agent_file).map_err(|e| format!("Agent file: {e}"))?;
    let agent_content = agent_body(&agent_raw)?;
    let contracts_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or("Rust manifest parent missing")?
        .join("skills/agents-relay/contracts");
    let mut contract_paths = vec![
        contracts_root.join("task-job-contract.md"),
        contracts_root.join("event-contract.md"),
    ];
    let visible_skills = context["skills"].as_array().cloned().unwrap_or_default();
    if let Some(path) = visible_skills
        .iter()
        .find(|s| s["name"] == "events-bus")
        .and_then(|s| s["path"].as_str())
    {
        let protocol = Path::new(path)
            .parent()
            .ok_or("events-bus Skill path missing parent")?
            .join("references/protocol.md");
        if protocol.is_file() {
            contract_paths.insert(0, protocol);
        }
    }
    if role == "troubleshooter" {
        contract_paths.extend([
            contracts_root.join("task-recovery-flows.md"),
            contracts_root.join("blocker-job-recovery.md"),
        ]);
    }
    if role == "worker" && visible_skills.iter().any(|s| s["name"] == "ponytail") {
        if let Some(path) = visible_skills
            .iter()
            .find(|s| s["name"] == "ponytail")
            .and_then(|s| s["path"].as_str())
        {
            contract_paths.push(Path::new(path).to_path_buf());
        }
    }
    if role == "worker" && task["review"].is_null() && agent != "review-chair" {
        contract_paths.push(contracts_root.join("worker-self-review.md"));
    }
    for path in &contract_paths {
        if !path.is_file() {
            return Err(format!(
                "required prompt contract unavailable: {}",
                path.display()
            ));
        }
    }
    let title = task["title"].as_str().unwrap_or("");
    let agent_fields = frontmatter(Path::new(agent_file));
    let suggested = list(agent_fields.get("skills"));
    let references = contract_paths
        .iter()
        .map(|p| {
            p.canonicalize()
                .map(|c| c.to_string_lossy().to_string())
                .map_err(|e| e.to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let context_refs = context["instructions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|v| {
            v["source"] != "global"
                && v["path"]
                    .as_str()
                    .is_some_and(|p| p.ends_with("/AGENTS.md"))
        })
        .map(|v| {
            (
                v["source"].as_str().unwrap_or("").to_owned(),
                v["path"].as_str().unwrap_or("").to_owned(),
            )
        })
        .collect::<Vec<_>>();
    let mut lines=vec!["# Role".into(),format!("You are {agent} with responsibility at {}.",agent_file),"".into(),"## Selected Agent contract".into(),agent_content.trim().to_owned(),"".into(),"## Bootstrap".into(),format!("Git repository working directory (cwd): {}",git_root.display()),"Use this repository as cwd for local execution. For remote execution, access it only through the configured file/tool provider.".into(),"Read the immutable Agent and Task contracts listed below. Follow configured provider guidance only when supplied by the Job Execution Context.".into(),"".into(),"## Contracts".into()];
    lines.push(if agent=="planner"{"MANDATORY: Read the listed Plan/Task contract before planning. A Plan does not publish Task events.".into()}else{"MANDATORY: Read every listed Task and Events contract before execution.".into()});
    lines.push("Read independently, in order. Later, more specific contracts take precedence over general rules.".into());
    lines.extend(
        references
            .iter()
            .enumerate()
            .map(|(i, p)| format!("{}. {}", i + 1, p)),
    );
    if agent == "planner" {
        lines.push("Planner lifecycle: use the execution-bound `plan context` from the matching Relay CLI described by the Skill. Run the returned same-version `apply_cli`, and return the exact PLAN_APPLIED receipt. Do not emit Task events for a Plan.".into());
    } else {
        lines.extend([format!("EVENT SOURCE (exact): job/{job_id}/task/{task_id}/execution/{execution}"),"START: After Bootstrap and the minimal event-contract preflight, publish `task.started` through the canonical events-bus before beginning Task work. Verify the publish response.".into(),"PROGRESS: Publish `task.progress` with concrete progress/evidence during long-running work and before the inactivity timeout. Progress is not completion.".into(),"TERMINAL: After verifying durable output, publish exactly ONE `task.completed`; if you cannot fulfill the Task, publish `task.failed` with phase, reason and evidence. Do not silently exit or treat a process/browser receipt as completion.".into(),"INTERACTIVE REVIEW: If this Job requires review, use only the review action and binding supplied by its Execution Context. Relay owns the suspension and resume state. Never invent a review tool or emit a terminal event while awaiting review. After resumption read the authoritative Task Context for the decision.".into(),"Every event MUST use the exact source above. Do not publish `task.blocked` or `task.unblocked`; those are Relay-owned states. Relay must accept the correlated event.".into()]);
    }
    lines.extend(["".into(), "## Contexts".into()]);
    if context_refs.is_empty() {
        lines.push("None required at startup. Read files only when selected by the Agent contract or the current Task.".into())
    } else {
        lines.push("Read only these additional role-relevant rules. Bootstrap and inherited Agent rules are not duplicated here.".into());
        for (i, (s, p)) in context_refs.iter().enumerate() {
            lines.push(format!("{}. [{s}] {p}", i + 1));
        }
    }
    lines.extend(["".into(),"## Task".into(),"Use the agents-relay skill to read authoritative Job and Task/Plan details via the Relay CLI.".into(),"All Relay state reads and operations use that version-matched CLI. Publish only required Task events through the configured events-bus protocol; never inspect Relay backing storage or HTTP APIs.".into(),format!("Job: {job_id}"),format!("Task: {task_id}"),format!("Execution: {execution}"),"".into(),"## User Assignment".into()]);
    if !suggested.is_empty() {
        lines.push(format!(
            "Suggested skills (optional, use only when relevant and available): {}",
            suggested.join(", ")
        ));
    }
    if !title.trim().is_empty() {
        lines.push(format!(
            "Assigned Task title (locator): {}",
            serde_json::to_string(title).unwrap_or_default()
        ));
    }
    lines.push(if agent=="planner" {"Read the full authoritative Plan Context through the matching Relay CLI. Apply the actual Plan, not merely its context lookup.".into()} else {"Read the FULL authoritative Task input, output, and acceptance criteria through the matching Relay CLI. Fulfill THAT Task: reading context, starting, or summarizing it is preparation only.".into()});
    let _ = project;
    Ok(lines.join("\n"))
}
pub fn dispatch(args: &[String]) -> Result<(), String> {
    match args.first().map(String::as_str){
        Some("context") if args.get(1).map(String::as_str)==Some("resolve")=>{
            let allowed=["--project-path","--role","--workspace-root","--global-root","--shared-root","--skills","--agents"];
            let opts=options(&args[2..],&allowed)?; let role=opts.get("--role").map(String::as_str).unwrap_or("orchestrator");
            if !["orchestrator","planner","reviewer","troubleshooter","worker","nested-worker"].contains(&role){return Err("--role must be orchestrator, planner, reviewer, troubleshooter, worker, or nested-worker".into())}
            let value=resolve_context(&opts,role)?; println!("{}",serde_json::to_string_pretty(&value).map_err(|e|e.to_string())?); Ok(())
        }
        Some("prompt")=>{
            let allowed=["--id","--repo","--db","--task-id","--plan-id","--adapter","--project-path","--output","--eval-file"];
            let opts=options(&args[1..],&allowed)?;
            if opts.contains_key("--plan-id"){return Err("Rust prompt currently supports recorded Tasks only; Plan prompt requires an immutable recorded execution input".into())}
            if let Some(out) = opts.get("--output") {
                let output = PathBuf::from(out);
                no_traversal(&output, "--output")?;
                let parent = output.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
                let canonical_parent = parent.canonicalize().map_err(|e| format!("--output parent: {e}"))?;
                let output = if output.exists() { output.canonicalize().map_err(|e| e.to_string())? } else {
                    canonical_parent.join(output.file_name().ok_or("--output filename missing")?)
                };
                fs::write(output, prompt(&opts)? + "\n").map_err(|e| e.to_string())?;
            } else { println!("{}", prompt(&opts)?); }
            Ok(())
        }
        _=>Err("usage: context resolve --project-path PATH [--role ROLE] [--workspace-root PATH] [--shared-root PATH] [--global-root PATH] [--skills CSV] [--agents CSV]; prompt --id JOB --task-id TASK --db SQLITE [--adapter codex|chatgpt|z]".into())
    }
}
