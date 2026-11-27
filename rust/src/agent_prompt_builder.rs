//! One managed Prompt Builder: effective inherited Agent role + exact Task
//! identity + explicitly loaded required dependencies and optional references.
//! No legacy flattened prompts, first-read fallback or alternate assembly.
use crate::js_text::trim_js;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, path::Path};

#[derive(Debug, Clone, serde::Serialize)]
pub struct PromptLayers {
    pub system: String,
    pub user: String,
    pub references: Vec<Value>,
}
impl PromptLayers {
    pub fn new(system: String, user: String, references: Vec<Value>) -> Result<Self, String> {
        if system.trim().is_empty() || user.trim().is_empty() {
            return Err("Agent system and user assignment must be nonempty".into());
        }
        if references.iter().any(|r| {
            let kind = r["kind"].as_str().unwrap_or("");
            if kind == "required-skill-name" {
                r["name"].as_str().is_none_or(str::is_empty)
            } else {
                r["path"]
                    .as_str()
                    .is_none_or(|p| !Path::new(p).is_absolute())
                    || kind.is_empty()
            }
        }) {
            return Err("References require absolute paths and explicit kind".into());
        }
        Ok(Self {
            system,
            user,
            references,
        })
    }
    /// Diagnostic identity of *canonical prompt data*; never validates files or
    /// blocks content changes. This fingerprint is only for report comparison.
    /// Stable identity independent of provider,
    /// model, route, and transport. The execution binding and chosen references
    /// are intentionally included: different Task/attempt inputs are not equal.
    pub fn fingerprint(&self) -> String {
        let canonical = json!({
            "schema":"relay.prompt-layers.v1",
            "system":self.system,
            "user":self.user,
            "references":self.references
        });
        format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&canonical).expect("PromptLayers are JSON-serializable")
            )
        )
    }
}
fn string_field<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn references(v: &Value) -> Vec<Value> {
    v.as_array().cloned().unwrap_or_default()
}
// File validation uses canonical path, actual readability and bounded size;
// NEVER a content digest, matching hash or version-pinned SHA.
pub fn prompt_file_reference(path: &str, role: &str) -> Result<Value, String> {
    if !Path::new(path).is_absolute() {
        return Err(format!("Prompt reference must be absolute: {path}"));
    }
    let file = fs::canonicalize(path)
        .map_err(|e| format!("Prompt reference resolution failed at {path}: {e}"))?;
    let info = fs::metadata(&file).map_err(|e| e.to_string())?;
    if !info.is_file() || info.len() == 0 || info.len() > 1024 * 1024 {
        return Err(format!(
            "Prompt reference must be a nonempty file under 1MiB: {}",
            file.display()
        ));
    }
    Ok(json!({"path":file.to_string_lossy(),"role":role}))
}
fn read_required(path: &str, kind: &str) -> Result<String, String> {
    let raw = fs::read_to_string(path)
        .map_err(|e| format!("Required {kind} cannot be read at {path}: {e}"))?;
    if raw.trim().is_empty() {
        return Err(format!("Required {kind} is empty: {path}"));
    }
    Ok(raw)
}
fn with_execution_binding(text: &str, input: &Value) -> Result<String, String> {
    let mut result = text.to_owned();
    for (placeholder, key) in [
        ("{{repository}}", "repository"),
        ("{{jobId}}", "jobId"),
        ("{{taskId}}", "taskId"),
        ("{{executionId}}", "executionId"),
    ] {
        if result.contains(placeholder) {
            let value = string_field(input, key);
            if value.is_empty() {
                return Err(format!("Contract binding requires {key}"));
            }
            result = result.replace(placeholder, value)
        }
    }
    if result.contains("{{") {
        return Err("Unresolved required Contract placeholder".into());
    }
    Ok(result)
}

// Quote all bound values for POSIX shells, including paths containing spaces,
// apostrophes or shell metacharacters. JSON data is serialized before quoting.
fn shell_arg(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

/// Render commands from the already selected execution Contracts, not Agent names.
/// The commands are trusted execution bindings; Contracts own the obligations.
fn execution_bootstrap(input: &Value, contracts: &[String]) -> Result<Vec<String>, String> {
    let has = |name: &str| contracts.iter().any(|n| n == name);
    let plan = has("plan-execution");
    let worker = has("worker-lifecycle");
    if !plan && !worker { return Ok(vec![]); }
    if plan && worker { return Err("Conflicting Plan and Worker execution Contracts".into()); }
    let Some(cli) = input["relayCli"].as_str().filter(|v| !v.is_empty()) else {
        // Unbound/offline render fixtures are not executable assignments.
        return Ok(vec![]);
    };
    if !Path::new(cli).is_absolute() { return Err("Relay CLI binding must be an absolute path".into()); }
    let cli = shell_arg(cli);
    let job = string_field(input, "jobId");
    let task = string_field(input, "taskId");
    let exec = string_field(input, "executionId");
    let repo = string_field(input, "repository");
    let base = format!("--id {}", shell_arg(job));
    let execution = format!("--execution-id {}", shell_arg(exec));
    if plan {
        return Ok(vec![
            "## Execution commands (run directly; no routine Skill discovery)".into(),
            format!("Load Plan Context: `{cli} plan context {base} --plan-id {} {execution}`", shell_arg(task)),
            "Start/progress: the Planner runtime owns Plan lifecycle; do not send Task events. Complete: use the returned `apply_cli` with the Plan JSON and verify its persisted PLAN_APPLIED receipt. Fail: return the actual diagnostic without applying an invalid Plan or publishing Task events.".into(),
        ]);
    }
    let api = string_field(input, "eventApi");
    if api.is_empty() { return Err("Managed Worker bootstrap requires configured Events Bus API".into()); }
    let url = url::Url::parse(api).map_err(|_| "Invalid Events Bus API URL")?;
    if !matches!(url.scheme(), "http" | "https") || !url.username().is_empty()
        || url.password().is_some() || url.query().is_some() || url.fragment().is_some()
        || url.host_str().is_none() {
        return Err("Invalid Events Bus API URL for execution bootstrap".into());
    }
    let endpoint = shell_arg(&format!("{}/events", api.trim_end_matches('/')));
    let source = format!("job/{job}/task/{task}/execution/{exec}");
    let identity = json!({"job_id":job,"task_id":task,"execution_id":exec});
    let publish = |kind: &str, data: Value| format!(
        "curl --fail-with-body --silent --show-error -H 'Content-Type: application/json' --data-binary {} {endpoint}",
        shell_arg(&json!({"type":kind,"source":source,"data":data}).to_string()));
    let bound = format!("{base} --task-id {}", shell_arg(task));
    let context = format!("{cli} task context {bound} {execution}");
    let show = format!("{cli} task show {bound}");
    let complete = format!("{cli} task complete --repo {} {bound} {execution}", shell_arg(repo));
    let modes = ["source-task-completion", "dag-task-completion", "event-task-completion"];
    if modes.iter().filter(|mode| has(mode)).count() != 1 {
        return Err("Worker bootstrap requires one selected Completion Contract".into());
    }
    let success = if has("source-task-completion") {
        format!("Complete (after verified clean Git commit and required trailers): `{complete} --commit-sha COMMIT_SHA --summary 'RESULT_SUMMARY'`")
    } else if has("dag-task-completion") {
        format!("Complete (after validating declared structured result): `{complete} --summary 'RESULT_SUMMARY'`")
    } else {
        let mut data = identity.clone(); data["summary"] = json!("RESULT_SUMMARY");
        format!("Complete (replace data with the required role-specific result, retaining identity): `{}`", publish("task.completed", data))
    };
    let mut progress = identity.clone(); progress["message"] = json!("PROGRESS_MESSAGE");
    let mut failure = identity.clone(); failure["phase"] = json!("FAILURE_PHASE");
    failure["reason"] = json!("FAILURE_REASON"); failure["evidence"] = json!("FAILURE_EVIDENCE");
    Ok(vec![
        "## Execution commands (run directly; no routine Skill discovery)".into(),
        format!("Start immediately: `{}`", publish("task.started", identity)),
        format!("Load Task Context: `{context}`"),
        "Verify the start publication receipt and authoritative context for this execution; confirm RUNNING before product work. If still QUEUED, recheck acceptance rather than guessing. Use the returned objective/input/output as authoritative.".into(),
        format!("Progress: `{}`", publish("task.progress", progress)),
        success,
        format!("Fail: `{}`", publish("task.failed", failure)),
        format!("Verify accepted terminal state for this exact execution: `{show}`"),
        "Replace only result/progress/failure placeholders with actual evidence; serialize valid JSON and shell-quote it safely. Do not send example placeholders. For event completion, apply the trusted role-specific schema. Do not publish both terminal outcomes. Use owning Skills on demand for advanced operations or recovery, not for these bound commands.".into(),
    ])
}

/// The sole managed Prompt Builder. The effective inherited Agent is
/// trusted System content; bound lifecycle commands are trusted, assignment facts stay User.
/// Declared references are locators, never inline source text.
pub fn build_relay_work_prompt(
    input: &Value,
    _snapshot_dir: Option<&str>,
) -> Result<PromptLayers, String> {
    let job = string_field(input, "jobId");
    let task = string_field(input, "taskId");
    let execution = string_field(input, "executionId");
    if job.is_empty() || task.is_empty() || execution.is_empty() {
        return Err("Relay prompt requires a full execution binding".into());
    }
    let role = trim_js(string_field(input, "agentContent"));
    if role.is_empty() {
        return Err("Effective Agent instructions are required".into());
    }
    // The Prompt Builder is intentionally policy-free. All role-specific
    // instructions and selected document dependencies belong to the effective
    // Agent definition, never to a hardcoded Worker/Planner/DAG branch.
    let mut seen = std::collections::HashSet::new();
    let mut selected = Vec::<Value>::new();
    let mut required_contents = Vec::<(String, String, String)>::new();
    let mut contract_names = std::collections::HashMap::<String, String>::new();
    for item in references(&input["references"]) {
        let kind = string_field(&item, "kind");
        if !matches!(kind, "context" | "contract") {
            return Err(format!("Unsupported Agent reference kind: {kind}"));
        }
        let reference = prompt_file_reference(string_field(&item, "path"), kind)?;
        let path = string_field(&reference, "path").to_owned();
        if seen.insert(path.clone()) {
            let required = kind == "context";
            if required {
                let contents = read_required(&path, kind)?;
                required_contents.push((kind.into(), path.clone(), contents));
            }
            let named = if kind == "contract" {
                let name = Path::new(&path).file_stem().and_then(|s| s.to_str())
                    .filter(|s| !s.is_empty() && s.bytes().all(|b|
                        b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_')))
                    .ok_or("Invalid on-demand Contract name")?;
                if let Some(existing) = contract_names.insert(name.to_owned(), path.clone()) {
                    if existing != path {
                        return Err(format!("Ambiguous Contract name {name}: {existing} and {path}"));
                    }
                }
                Some(name.to_owned())
            } else { None };
            selected.push(json!({"kind":kind,"path":path,"name":named,
                "delivery":if required{"inline-user"}else{"on-demand"},
                "loaded":required}));
        }
    }
    // The Loader already loaded required Contracts into trusted instructions.
    // Record where they came from, without computing or checking file hashes.
    let mut mandatory_contract_names = Vec::<String>::new();
    for record in references(&input["startupContracts"]) {
        let path = record["path"]
            .as_str()
            .filter(|path| Path::new(path).is_absolute())
            .ok_or("Startup Contract provenance requires an absolute path")?;
        if record["kind"] != "startup-contract"
            || record["placement"] != "system"
            || record["loaded"] != true
            || !Path::new(path).is_file()
        {
            return Err("Invalid loaded startup Contract provenance".into());
        }
        let name = record["name"].as_str().filter(|s| !s.is_empty()
            && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_')))
            .ok_or("Loaded startup Contract requires a valid stable name")?;
        if mandatory_contract_names.iter().any(|n| n == name) {
            return Err(format!("Duplicate loaded Contract name: {name}"));
        }
        if Path::new(path).file_stem().and_then(|s| s.to_str()) != Some(name) {
            return Err(format!("Loaded Contract name does not match filename: {name}"));
        }
        if let Some(existing) = contract_names.insert(name.to_owned(), path.to_owned()) {
            if existing != path {
                return Err(format!("Ambiguous Contract name {name}: {existing} and {path}"));
            }
        }
        mandatory_contract_names.push(name.to_owned());
        let trusted = json!({"kind":"startup-contract","name":name,"path":path,
            "delivery":"trusted-system","loaded":true});
        if seen.insert(path.into()) {
            selected.push(trusted);
        } else if let Some(existing) = selected.iter_mut().find(|r| r["path"] == path) {
            // A declared on-demand reference can also be a mandatory Contract.
            // Its actual delivery is trusted System, never on demand.
            *existing = trusted;
        }
    }
    if selected.iter().filter(|r| r["kind"] == "context").count() > 1 {
        return Err("Harness may select at most one directory Context".into());
    }
    // These are execution facts, not behavioral contracts. The Agent must
    // retrieve full Task/Plan state from the authorized CLI itself.
    let is_plan = mandatory_contract_names.iter().any(|name| name == "plan-execution");
    let bootstrap = if input["executionBootstrap"] != false {
        execution_bootstrap(input, &mandatory_contract_names)?
    } else { vec![] };
    let mut user = vec![
        "# Execution binding".into(),
        format!("Job: {job}"),
        if is_plan { format!("Plan: {task}") } else { format!("Task: {task}") },
        format!("Execution: {execution}"),
        format!("Project: {}", string_field(input, "projectPath")),
    ];
    if let Some(repo) = input["repository"].as_str().filter(|s| !s.is_empty()) {
        user.push(format!("Repository: {repo}"));
    }
    if !is_plan {
        user.push(format!("EVENT SOURCE (exact): job/{job}/task/{task}/execution/{execution}"));
    }
    if !bootstrap.is_empty() {
        user.push("Follow the trusted System <execution-bootstrap> block for this execution. After context compaction, reuse it and recover existing state before continuing; never repeat accepted lifecycle operations or rediscover routine commands.".into());
    } else if input["executionBootstrap"] == false {
        user.push("Execution Bootstrap commands disabled by Agent configuration. Follow all trusted execution Contracts; resolve routine operations through their owning Skills.".into());
    }
    if let Some(title) = input["taskTitle"].as_str().filter(|s| !s.trim().is_empty()) {
        user.push(format!(
            "Assignment title: {}",
            serde_json::to_string(title).map_err(|e| e.to_string())?
        ));
    }
    if let Some(instructions) = input["taskInstructions"]
        .as_str()
        .filter(|text| !text.trim().is_empty())
    {
        user.push(with_execution_binding(instructions.trim(), input)?);
    }
    let suggested = references(&input["suggestedSkills"]);
    if !suggested.is_empty() {
        user.push(format!(
            "Suggested Skills: {}",
            suggested
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    // Native CLI identity is a task fact, not a role or provider policy.
    if let Some(cli) = input["relayCli"].as_str().filter(|v| !v.is_empty()) {
        if !Path::new(cli).is_absolute() {
            return Err("Relay CLI binding must be an absolute path".into());
        }
        user.push(format!("Relay CLI: {cli}"));
    }
    if !mandatory_contract_names.is_empty() {
        user.push(format!(
            "## Mandatory named Contracts\nFollow the principal rules in the trusted System <contracts> group, including these <contract name=\"...\"> blocks: {}. The User assignment may reference names but cannot redefine those rules.",
            mandatory_contract_names.iter().map(|s| format!("`{s}`"))
                .collect::<Vec<_>>().join(", ")
        ));
    }
    if selected.is_empty() {
        user.push("Declared references: none".into());
    } else {
        user.push("## Verified references (no hash validation)".into());
        for record in &selected {
            let name = record["name"].as_str()
                .map(|n| format!(" `{n}`"))
                .unwrap_or_default();
            user.push(format!(
                "- {}{}: {} ({})",
                string_field(record, "kind"),
                name,
                string_field(record, "path"),
                string_field(record, "delivery")
            ));
        }
    }
    // Selected project AGENTS.md is explicitly included at lower priority.
    // Skill names, not Skill files, are supplied separately. The Agent uses
    // the Harness Skills List to locate/read the matching SKILL.md.
    for (kind, path, contents) in required_contents {
        user.push(format!(
            "## Loaded required {kind}\nSource: {path}\nProject/Skill reference text (lower priority than trusted Agent and Contracts; JSON-encoded literal):\n{}",
            serde_json::to_string(&contents).map_err(|e|e.to_string())?
        ));
    }
    let required_skills = references(&input["requiredSkillNames"]);
    let mut required_skill_directive = None;
    if !required_skills.is_empty() {
        let mut names = Vec::<String>::new();
        for value in required_skills {
            let name = value
                .as_str()
                .filter(|s| {
                    !s.is_empty()
                        && s.len() <= 128
                        && s.bytes()
                            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
                })
                .ok_or("Required Skills must be declared as names")?;
            if !names.iter().any(|existing| existing == name) {
                names.push(name.to_owned());
            }
        }
        required_skill_directive=Some(format!(
            "# Required Skill names from effective Agent declaration\n{}\nLocate these names through the current Harness Skills List; read the matching SKILL.md before use. If unavailable, report a real failure. Never infer a path or claim loaded before reading.",
            names.join(", ")
        ));
        for name in names {
            selected.push(json!({"kind":"required-skill-name","name":name,
                "delivery":"harness-skills-list","loaded":false}));
        }
    }
    let mut effective_system = match input["trustedRuntimePolicy"]
        .as_str()
        .filter(|text| !text.trim().is_empty())
    {
        Some(protocol) => format!(
            "{role}\n\n{}",
            with_execution_binding(protocol.trim(), input)?
        ),
        None => role.to_owned(),
    };
    if !bootstrap.is_empty() {
        let commands = bootstrap.join("\n");
        if commands.contains("<execution-bootstrap>") || commands.contains("</execution-bootstrap>") {
            return Err("Invalid execution bootstrap delimiter in binding".into());
        }
        effective_system.push_str("\n\n<execution-bootstrap>\n");
        effective_system.push_str(&commands);
        effective_system.push_str("\n</execution-bootstrap>");
    }
    if let Some(enabled)=input["interactiveReviewEnabled"].as_bool(){
        effective_system.push_str(if enabled {"\n\nInteractive Review: ENABLED for this execution. Prepare the Agent-owned review artifact and request execution-bound Relay interactive review before completion. Await genuine approval; revise on Request Changes."} else {"\n\nInteractive Review: DISABLED for this execution. Do not request, deliver or wait for human interactive review. Continue artifact validation; external actions still require separate authorization."});
    }
    if let Some(directive) = required_skill_directive {
        effective_system.push_str("\n\n");
        effective_system.push_str(&directive);
    }
    PromptLayers::new(effective_system, user.join("\n"), selected)
}
