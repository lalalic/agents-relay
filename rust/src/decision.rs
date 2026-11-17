// Direct port of src/decision.ts: caller-owned fallback/choice contract.
// Pure parsing and mode semantics are exact; transports are injected adapters.
use serde_json::{json, Map, Value};
use std::{collections::HashSet, fs, future::Future, io::Read, path::Path, time::Instant};

fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn contract_choices(contract: &Value) -> Result<&[Value], String> {
    if contract["type"] != "choice" {
        return Err(format!(
            "Unsupported decision contract {}",
            contract
                .get("type")
                .map(|v| if let Some(s) = v.as_str() {
                    s.to_string()
                } else {
                    v.to_string()
                })
                .unwrap_or("undefined".into())
        ));
    }
    if s(contract, "question").trim().is_empty() {
        return Err("Decision choice question is required".into());
    }
    let choices = contract["choices"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    if choices.is_empty() {
        return Err("Decision choice contract requires at least one choice".into());
    }
    let mut seen = HashSet::new();
    for choice in choices {
        let name = choice.as_str().unwrap_or("");
        if !seen.insert(name) {
            return Err("Decision choice contract contains duplicate choices".into());
        }
    }
    if choices
        .iter()
        .any(|v| v.as_str().is_none_or(|s| s.trim().is_empty()))
    {
        return Err("Decision choice contract contains an empty choice".into());
    }
    Ok(choices)
}
pub fn validate_decision_request(_request: &Value, contract: &Value) -> Result<(), String> {
    contract_choices(contract)?;
    // serde_json::Value is already a recursively checked, finite JSON wire type;
    // undefined/NaN/infinite/non-JSON values cannot enter this function.
    Ok(())
}
fn valid_probabilities(raw: &Value, choices: &[Value]) -> Option<Value> {
    let source = raw.as_object()?;
    let mut scores = Map::new();
    for choice in choices {
        let key = choice.as_str()?;
        let number = source.get(key)?.as_f64()?;
        if !number.is_finite() || !(0.0..=1.0).contains(&number) {
            return None;
        }
        scores.insert(key.into(), source[key].clone());
    }
    if scores.len() == choices.len() {
        Some(Value::Object(scores))
    } else {
        None
    }
}
pub fn parse_choice_decision(raw: &Value, contract: &Value) -> Result<Value, String> {
    let choices = contract_choices(contract)?;
    if !raw.is_object() && !raw.is_array() {
        return Err("Decision output must be a JSON object".into());
    }
    let nested = raw.pointer("/answers/decision");
    let answer = nested.filter(|v| v.is_object()).unwrap_or(raw);
    let choice = s(answer, "choice");
    if !choices.iter().any(|value| value == choice) {
        return Err(format!(
            "Decision choice {} is outside the contract",
            if choice.is_empty() {
                "<missing>"
            } else {
                choice
            }
        ));
    }
    let mut response = json!({"type":"choice","choice":choice});
    if let Some(scores) = valid_probabilities(&answer["probabilities"], choices) {
        response["probabilities"] = scores;
    }
    Ok(response)
}
pub fn decision_mode() -> &'static str {
    "active"
}
pub fn laya_args_from_env(raw: Option<&str>) -> Result<Vec<String>, String> {
    let Some(raw) = raw.filter(|s| !s.is_empty()) else {
        return Ok(vec!["laya-mlx".into(), "predict".into()]);
    };
    let value: Value = serde_json::from_str(raw)
        .map_err(|_| "AGENTS_RELAY_LAYA_ARGS must be a JSON string array".to_string())?;
    let Some(array) = value.as_array() else {
        return Err("AGENTS_RELAY_LAYA_ARGS must be a JSON string array".into());
    };
    if array.iter().any(|v| !v.is_string()) {
        return Err("AGENTS_RELAY_LAYA_ARGS must be a JSON string array".into());
    }
    Ok(array
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect())
}
pub async fn choose_with_decision<Run, Fut, Fallback>(
    engine_name: Option<&str>,
    mut decide: Run,
    mode: &str,
    request: &Value,
    contract: &Value,
    fallback: Fallback,
) -> Result<Value, String>
where
    Run: FnMut(&Value, &Value) -> Fut,
    Fut: Future<Output = Result<Value, String>>,
    Fallback: FnOnce() -> String,
{
    validate_decision_request(request, contract)?;
    let deterministic = fallback();
    if !contract_choices(contract)?
        .iter()
        .any(|v| v == &deterministic)
    {
        return Err("Deterministic fallback is outside the decision contract".into());
    }
    if mode == "off" || engine_name.is_none() {
        return Ok(json!({"choice":deterministic,"evidence":{"mode":mode,"fallback":true}}));
    }
    let engine = engine_name.unwrap_or("");
    match decide(request, contract).await {
        Ok(result) => {
            if result["type"] != "choice" {
                return Ok(
                    json!({"choice":deterministic,"evidence":{"mode":mode,"engine":engine,
                    "fallback":true,"error":format!("Unexpected decision result {}",result.get("type").map(|v| if let Some(name)=v.as_str(){name.to_string()}else{v.to_string()}).unwrap_or_else(||"undefined".into()))}}),
                );
            }
            let mut evidence = json!({"mode":mode,"engine":engine,"proposed":result["choice"],
                "fallback":mode=="shadow"});
            if let Some(scores) = result.get("probabilities") {
                evidence["probabilities"] = scores.clone();
            }
            Ok(
                json!({"choice":if mode=="shadow"{json!(deterministic)}else{result["choice"].clone()},
                "evidence":evidence}),
            )
        }
        Err(error) => Ok(json!({"choice":deterministic,"evidence":{
            "mode":mode,"engine":engine,"fallback":true,"error":error}})),
    }
}

#[derive(Clone, Debug, Default)]
pub struct JevDecisionOptions {
    pub api_key: Option<String>,
    pub endpoint: Option<String>,
    pub model: Option<String>,
    pub timeout_ms: Option<u64>,
}
pub struct JevDecisionEngine {
    pub options: JevDecisionOptions,
}
impl JevDecisionEngine {
    pub const NAME: &'static str = "openrouter-jev";
    pub fn new(options: JevDecisionOptions) -> Self {
        Self { options }
    }
    pub fn request_body(request: &Value, contract: &Value, model: &str) -> Result<Value, String> {
        validate_decision_request(request, contract)?;
        let mapped = contract_choices(contract)?
            .iter()
            .enumerate()
            .map(|(i, v)| (format!("route_{}", i + 1), v.clone()))
            .collect::<Map<String, Value>>();
        Ok(json!({"model":model,"state":request["facts"],
            "questions":{"decision":{"type":"choice","instructions":contract["question"],"criteria":mapped}}}))
    }
    pub fn parse_response(
        raw: &Value,
        contract: &Value,
        latency_ms: u128,
    ) -> Result<Value, String> {
        let answer = raw.pointer("/answers/decision");
        let route = answer.and_then(|a| a["choice"].as_str());
        let choices = contract_choices(contract)?;
        let Some(route) = route else {
            return Err("Jev returned a choice outside the decision contract".into());
        };
        let Some(index) = route
            .strip_prefix("route_")
            .and_then(|n| n.parse::<usize>().ok())
            .and_then(|i| i.checked_sub(1))
            .filter(|&i| i < choices.len())
        else {
            return Err("Jev returned a choice outside the decision contract".into());
        };
        let mut probabilities = Map::new();
        if let Some(object) = answer.and_then(|a| a["probabilities"].as_object()) {
            for (key, value) in object {
                if let Some(pos) = key
                    .strip_prefix("route_")
                    .and_then(|n| n.parse::<usize>().ok())
                    .and_then(|n| n.checked_sub(1))
                    .filter(|&n| n < choices.len())
                {
                    probabilities.insert(choices[pos].as_str().unwrap_or("").into(), value.clone());
                }
            }
        }
        let mut result = parse_choice_decision(
            &json!({"choice":choices[index],
            "probabilities":Value::Object(probabilities)}),
            contract,
        )?;
        if let Some(usage) = raw.get("usage") {
            result["usage"] = usage.clone();
        }
        result["latencyMs"] = json!(latency_ms);
        if let Some(model) = raw.get("model") {
            result["model"] = model.clone();
        }
        Ok(result)
    }
    pub fn decide_with_fetcher(
        &self,
        request: &Value,
        contract: &Value,
        mut fetch: impl FnMut(&str, &str, &Value, u64) -> Result<(u16, Value), String>,
    ) -> Result<Value, String> {
        validate_decision_request(request, contract)?;
        let key = self
            .options
            .api_key
            .as_deref()
            .map(str::to_owned)
            .or_else(|| std::env::var("OPENROUTER_API_KEY").ok());
        let Some(key) = key.filter(|key| !key.is_empty()) else {
            return Err("OPENROUTER_API_KEY is required for Jev".into());
        };
        let body = Self::request_body(
            request,
            contract,
            self.options.model.as_deref().unwrap_or("typesafe/jev-1.13"),
        )?;
        let start = Instant::now();
        let (status, raw) = fetch(
            self.options
                .endpoint
                .as_deref()
                .unwrap_or("https://openrouter.ai/api/alpha/decisions"),
            &key,
            &body,
            self.options.timeout_ms.unwrap_or(12_000),
        )?;
        if !(200..300).contains(&status) {
            return Err(format!("Jev Decisions API returned HTTP {status}"));
        }
        Self::parse_response(&raw, contract, start.elapsed().as_millis())
    }
    /// Native HTTPS transport. Mock fetchers in tests keep credentials offline.
    pub fn decide(&self, request: &Value, contract: &Value) -> Result<Value, String> {
        self.decide_with_fetcher(request, contract, |endpoint, key, body, timeout_ms| {
            use std::time::Duration;
            let config = ureq::Agent::config_builder()
                .timeout_global(Some(Duration::from_millis(timeout_ms)))
                .build();
            let agent = ureq::Agent::new_with_config(config);
            let response = agent
                .post(endpoint)
                .header("Authorization", &format!("Bearer {key}"))
                .header("Content-Type", "application/json")
                .send_json(body);
            match response {
                Ok(mut response) => {
                    let status = response.status().as_u16();
                    let text = response
                        .body_mut()
                        .read_to_string()
                        .map_err(|e| e.to_string())?;
                    let parsed = serde_json::from_str(&text).map_err(|e| e.to_string())?;
                    Ok((status, parsed))
                }
                Err(ureq::Error::StatusCode(status)) => Ok((status, json!({}))),
                Err(error) => Err(error.to_string()),
            }
        })
    }
}
pub fn execution_decision_engine() -> JevDecisionEngine {
    JevDecisionEngine::new(JevDecisionOptions::default())
}

#[derive(Clone, Debug)]
pub struct LayaCliOptions {
    pub command: String,
    pub args: Vec<String>,
    pub timeout_ms: u64,
}
impl LayaCliOptions {
    pub fn from_env() -> Result<Self, String> {
        Ok(Self {
            command: "uvx".into(),
            args: laya_args_from_env(std::env::var("AGENTS_RELAY_LAYA_ARGS").ok().as_deref())?,
            timeout_ms: std::env::var("AGENTS_RELAY_LAYA_TIMEOUT_MS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(30_000),
        })
    }
}
pub struct LayaCliDecisionEngine {
    pub options: LayaCliOptions,
}
impl LayaCliDecisionEngine {
    pub const NAME: &'static str = "laya-cli";
    pub fn new(options: LayaCliOptions) -> Self {
        Self { options }
    }
    /// Production-compatible transport: uses the existing native
    /// OwnedProcessManager (isolated group + parent-death supervisor) rather
    /// than launching an untracked subprocess or a second process lifecycle.
    pub fn decide(&self, request: &Value, contract: &Value) -> Result<Value, String> {
        self.decide_with_env(request, contract, None)
    }
    /// Node's optional `spawn.env` replaces the inherited environment.
    pub fn decide_with_env(
        &self,
        request: &Value,
        contract: &Value,
        env: Option<&std::collections::HashMap<String, String>>,
    ) -> Result<Value, String> {
        use crate::owned_process::{OwnedProcessManager, OwnedProcessOptions, TerminationReason};
        use std::{io::Read as _, thread, time::Duration};
        self.decide_with_owned_runner(request, contract, |command, args, timeout| {
            let mut manager = OwnedProcessManager::default();
            let options = OwnedProcessOptions {
                invocation: "decision.laya".into(),
                timeout_ms: Some(timeout),
                grace_ms: 750,
                ..OwnedProcessOptions::default()
            };
            let borrowed = args.iter().map(String::as_str).collect::<Vec<_>>();
            let child = if let Some(env) = env {
                manager.spawn_owned_process_piped_with_env(command, &borrowed, options, env)
            } else {
                manager.spawn_owned_process_piped(command, &borrowed, options)
            }?;
            let mut stdout = child.take_stdout().ok_or("Laya stdout pipe unavailable")?;
            let mut stderr = child.take_stderr().ok_or("Laya stderr pipe unavailable")?;
            // Drain both pipes concurrently. A child writing a full stderr
            // pipe may never block progress or prevent timeout cleanup.
            let out = thread::spawn(move || {
                let mut bytes = Vec::new();
                stdout.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
                Ok::<_, String>(bytes)
            });
            let err = thread::spawn(move || {
                let mut bytes = Vec::new();
                stderr.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
                Ok::<_, String>(bytes)
            });
            if !child.wait_for_leader(Duration::from_millis(timeout.saturating_add(2000))) {
                child.terminate(TerminationReason::Timeout, Some(0));
                return Err(format!("Laya CLI timed out after {timeout}ms"));
            }
            if child.termination_reason() == Some(TerminationReason::Timeout) {
                return Err(format!("Laya CLI timed out after {timeout}ms"));
            }
            let status = child
                .exit_status()?
                .ok_or("Laya CLI leader exited without wait status")?;
            // No future can join forever on inherited descendant stdio:
            // OwnedProcess terminates the entire group on leader exit.
            let stdout = out.join().map_err(|_| "Laya stdout reader panicked")??;
            let stderr = err.join().map_err(|_| "Laya stderr reader panicked")??;
            if !status.success() {
                let code = status.code().map_or("null".into(), |v| v.to_string());
                let detail = String::from_utf8_lossy(&stderr).trim().to_string();
                return Err(format!(
                    "Laya CLI exited {code}{}",
                    if detail.is_empty() {
                        String::new()
                    } else {
                        format!(": {detail}")
                    }
                ));
            }
            Ok(String::from_utf8_lossy(&stdout).trim().to_string())
        })
    }
    /// Caller's shared OwnedProcess adapter MUST own the subprocess and
    /// provide stdout; this helper exclusively implements Laya's file contract.
    pub fn decide_with_owned_runner(
        &self,
        request: &Value,
        contract: &Value,
        runner: impl FnOnce(&str, &[String], u64) -> Result<String, String>,
    ) -> Result<Value, String> {
        validate_decision_request(request, contract)?;
        let directory = temp_directory()?;
        let response = (|| {
            fs::write(
                directory.join("state.json"),
                serde_json::to_string(&request["facts"]).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            let questions = json!({"decision":{"type":"choice","instructions":contract["question"],
                "criteria":contract["choices"]}});
            fs::write(directory.join("questions.json"), questions.to_string())
                .map_err(|e| e.to_string())?;
            let mut args = self.options.args.clone();
            args.extend([
                "--state-file".into(),
                directory.join("state.json").to_string_lossy().into(),
                "--questions".into(),
                directory.join("questions.json").to_string_lossy().into(),
            ]);
            let raw = runner(&self.options.command, &args, self.options.timeout_ms)?;
            let parsed: Value = serde_json::from_str(&raw)
                .map_err(|_| "Laya CLI returned invalid JSON".to_string())?;
            parse_choice_decision(&parsed, contract)
        })();
        let _ = fs::remove_dir_all(directory);
        response
    }
}
fn temp_directory() -> Result<std::path::PathBuf, String> {
    let mut bytes = [0u8; 12];
    fs::File::open("/dev/urandom")
        .map_err(|e| e.to_string())?
        .read_exact(&mut bytes)
        .map_err(|e| e.to_string())?;
    let id = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
    let path = std::env::temp_dir().join(format!("agents-relay-laya-{id}"));
    fs::create_dir(&path).map_err(|e| e.to_string())?;
    Ok(path)
}
pub fn request_contract_path_is_private(path: &Path) -> bool {
    path.starts_with(std::env::temp_dir())
}
