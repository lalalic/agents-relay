//! Detached entry to the same native Execution Router used by model Workers.
//! The caller owns execution; only read-only shared observations, no Job or audit writes.
use crate::{
    decision::{decision_mode, execution_decision_engine},
    execution_routing::select_execution_route_with,
    job_routing_preferences,
    model_routing::default_codex_home,
    routing_policy::execution_router_rules_path,
    worker_routing::native_codex_worker,
};
use serde_json::{json, Value};
use std::{
    io::Read,
    path::{Path, PathBuf},
};

const MAX_INPUT_BYTES: u64 = 1024 * 1024;
const USAGE: &str =
    "Usage: agents-relay route --input-file REQUEST.json|- [--execution-router-rules PATH] [--port PORT]";

fn parse_args(args: &[String]) -> Result<(&str, Option<&str>), String> {
    let (mut input, mut rules, mut port) = (None, None, None);
    for pair in args.chunks(2) {
        let [flag, value] = pair else {
            return Err(USAGE.into());
        };
        if value.is_empty() || value.starts_with("--") {
            return Err(USAGE.into());
        }
        match flag.as_str() {
            "--input-file" if input.is_none() => input = Some(value.as_str()),
            "--execution-router-rules" if rules.is_none() => rules = Some(value.as_str()),
            "--port" if port.is_none() => port = Some(value.as_str()),
            _ => return Err(USAGE.into()),
        }
    }
    crate::cli_support::endpoint(args)?;
    Ok((input.ok_or(USAGE)?, rules))
}

fn read_request(path: &str, stdin: Option<&str>) -> Result<Value, String> {
    let mut bytes = Vec::new();
    if path == "-" {
        if let Some(input) = stdin {
            if input.len() as u64 > MAX_INPUT_BYTES {
                return Err("Routing input exceeds 1 MiB".into());
            }
            bytes.extend_from_slice(input.as_bytes());
        } else {
            std::io::stdin()
                .lock()
                .take(MAX_INPUT_BYTES + 1)
                .read_to_end(&mut bytes)
                .map_err(|e| format!("Cannot read routing input: {e}"))?;
        }
    } else {
        std::fs::File::open(path)
            .map_err(|e| format!("Cannot open routing input: {e}"))?
            .take(MAX_INPUT_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| format!("Cannot read routing input: {e}"))?;
    }
    if bytes.len() as u64 > MAX_INPUT_BYTES {
        return Err("Routing input exceeds 1 MiB".into());
    }
    serde_json::from_slice(&bytes).map_err(|e| format!("Invalid routing JSON: {e}"))
}

fn object_field(input: &Value, key: &str) -> Result<Value, String> {
    match input.get(key) {
        None => Ok(json!({})),
        Some(v) if v.is_object() => Ok(v.clone()),
        _ => Err(format!("{key} must be an object")),
    }
}
fn identifiers(value: &Value, keys: &[&str], name: &str) -> Result<(), String> {
    let map = value
        .as_object()
        .ok_or_else(|| format!("{name} must be an object"))?;
    if map.iter().any(|(key, value)| {
        !keys.contains(&key.as_str())
            || !value
                .as_str()
                .is_some_and(|s| !s.trim().is_empty() && s.trim() == s)
    }) {
        return Err(format!("{name} contains an invalid identifier"));
    }
    Ok(())
}
fn options(input: &Value) -> Result<(Value, Value, Vec<Value>), String> {
    let fields = input.as_object().ok_or("Routing input must be an object")?;
    if fields.keys().any(|k| {
        !matches!(
            k.as_str(),
            "taskFacts"
                | "workerRequirements"
                | "routingConstraints"
                | "routingPreferences"
                | "modelPreference"
                | "routingInstruction"
                | "eligibleProfiles"
                | "excludedRoutes"
                | "usage"
                | "recentRouteResults"
        )
    }) {
        return Err("Unexpected routing input field".into());
    }
    let mut facts = object_field(input, "taskFacts")?;
    if facts.get("routingPreferences").is_some() {
        return Err("Supply routingPreferences at the request top level".into());
    }
    let requirements = object_field(input, "workerRequirements")?;
    let constraints = object_field(input, "routingConstraints")?;
    identifiers(
        &constraints,
        &["provider", "model", "profile", "reasoning"],
        "routingConstraints",
    )?;
    if let Some(preferences) = input.get("routingPreferences") {
        job_routing_preferences::validate(preferences)?;
        facts["routingPreferences"] = preferences.clone();
    }
    let model_preference = match input.get("modelPreference") {
        None => Value::Null,
        Some(value) => {
            identifiers(value, &["model", "reasoning"], "modelPreference")?;
            value.clone()
        }
    };
    let mut opts = json!({"taskFacts":facts,"routingConstraints":constraints,
        "modelPreference":model_preference,
        "decisionMode":decision_mode(),"recordDecisionAudit":false});
    if let Some(v) = input.get("routingInstruction") {
        if !v.is_string() {
            return Err("routingInstruction must be a string".into());
        }
        opts["routingInstruction"] = v.clone();
    }
    if let Some(v) = input.get("eligibleProfiles") {
        if !v.as_array().is_some_and(|a| {
            !a.is_empty()
                && a.iter().all(|v| {
                    v.as_str()
                        .is_some_and(|s| !s.trim().is_empty() && s.trim() == s)
                })
        }) {
            return Err(
                "eligibleProfiles must be a nonempty array of exact profile identifiers".into(),
            );
        }
        opts["eligibleProfiles"] = v.clone();
    }
    if let Some(v) = input.get("excludedRoutes") {
        let rows = v.as_array().ok_or("excludedRoutes must be an array")?;
        for route in rows {
            identifiers(
                route,
                &["provider", "model", "profile"],
                "excludedRoutes entry",
            )?;
            if route.as_object().unwrap().is_empty() {
                return Err("excludedRoutes entry must identify a route".into());
            }
        }
        opts["excludedRoutes"] = v.clone();
    }
    if let Some(v) = input.get("usage") {
        if !v.is_object() {
            return Err("usage must be a snapshot object".into());
        }
        opts["usage"] = v.clone();
    }
    let recent = match input.get("recentRouteResults") {
        None => vec![],
        Some(v) => v
            .as_array()
            .filter(|a| a.len() <= 10 && a.iter().all(Value::is_object))
            .ok_or("recentRouteResults must contain at most 10 objects")?
            .clone(),
    };
    Ok((requirements, opts, recent))
}

pub(crate) fn route_with(
    input: &Value,
    workers: &[Value],
    profile_home: &Path,
    policy_path: &Path,
    rules_path: &Path,
    decide: impl FnOnce(&Value, &Value) -> Result<Value, String>,
) -> Result<Value, String> {
    let (requirements, opts, recent) = options(input)?;
    let routed = select_execution_route_with(
        workers, &requirements, &opts, profile_home, policy_path, rules_path,
        chrono::Utc::now().timestamp_millis(), &recent, true, decide,
    )?;
    Ok(json!({"selection":routed["selection"],"model":routed["model"],"routing":routed["routing"]}))
}

fn executable_on_path(name: &str) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .any(|dir| {
            std::fs::metadata(dir.join(name))
                .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        })
}

/// Every detached agent goes through this same route ingress (including
/// both preflight reviewers and public CLI). Explicit observations remain
/// supported for isolated callers; otherwise use the live Router's sources.
fn hydrate_observations(
    input:&mut Value,
    usage:impl FnOnce()->Result<Value,String>,
    recent:impl FnOnce()->Vec<Value>,
)->Result<(),String>{
    if !input.is_object(){return Err("Routing request must be an object".into());}
    // Validate caller-supplied facts before touching the live observation service.
    options(input)?;
    if input.get("usage").is_none(){input["usage"]=usage()?;}
    if input.get("recentRouteResults").is_none(){input["recentRouteResults"]=json!(recent());}
    Ok(())
}

pub fn run(args: &[String], stdin: Option<&str>) -> Result<Value, String> {
    let (input_path, explicit_rules) = parse_args(args)?;
    let mut input = read_request(input_path, stdin)?;
    // The native daemon supports Codex as its Model Worker. A detached
    // component invokes its own local executable instead of a Relay lease.
    if !executable_on_path("codex") {
        return Err("No executable local Codex worker on PATH".into());
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or("HOME is not set")?;
    let env_rules = std::env::var("AGENTS_RELAY_EXECUTION_ROUTER_RULES").ok();
    let rules = execution_router_rules_path(explicit_rules, env_rules.as_deref(), &home);
    hydrate_observations(&mut input,||crate::cli_support::relay_routing_usage(args),
        ||crate::decision_audit::routing_recent_results(&crate::relay_store::relay_store_directory()))?;
    route_with(
        &input,
        &[native_codex_worker()],
        &default_codex_home(),
        &home.join(".agents-relay/routing-policy.json"),
        Path::new(&rules),
        |request, contract| execution_decision_engine().decide(request, contract),
    )
}

/// Detached agents use the exact same Router service and Agent preference
/// resolver as managed Model Tasks; no reviewer-specific route selector.
pub fn detached_model_agent_request(
    project:&Path,workspace:&Path,agent:&str,role:&str,
    builtin_agents_root:Option<&Path>,
)->Value{
    let mut request=json!({
        "taskFacts":{"role":role,"task":{
            "agentName":agent,"taskCapabilities":["model"],"storySize":"M"
        }},
        "workerRequirements":{"capabilities":["model"]}
    });
    if let Some(preference)=crate::execution_context::optional_agent_model_preference(
        &project.to_string_lossy(),agent,
        Some(&workspace.to_string_lossy()),None,
        builtin_agents_root.as_ref().map(|p|p.to_str().unwrap_or(""))){
        request["modelPreference"]=preference;
    }
    request
}
pub fn route_detached_model_agent(
    project:&Path,workspace:&Path,agent:&str,role:&str,
    builtin_agents_root:Option<&Path>,
)->Result<Value,String>{
    let request=detached_model_agent_request(project,workspace,agent,role,builtin_agents_root);
    run(&["--input-file".into(),"-".into()],Some(&request.to_string()))
        .map_err(|error|format!("{agent} routing failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input() -> Value {
        json!({"taskFacts":{"task":{"taskCapabilities":["vision"]}},
            "routingPreferences":{"profile":"quality"},
            "routingInstruction":"  Prefer quality for this call.\r\n"})
    }
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let p =
                std::env::temp_dir().join(format!("relay-route-{}", crate::events::random_uuid()));
            std::fs::create_dir_all(&p).unwrap();
            std::fs::write(
                p.join("config.toml"),
                "model = \"base\"\nmodel_reasoning_effort = \"low\"\n",
            )
            .unwrap();
            std::fs::write(
                p.join("quality.config.toml"),
                "model = \"stronger\"\nmodel_reasoning_effort = \"high\"\n",
            )
            .unwrap();
            std::fs::write(
                p.join("rules.md"),
                "[routing-instruction]\r\n  Prefer the default profile globally.\r\n",
            )
            .unwrap();
            Self(p)
        }
        fn route(
            &self,
            input: &Value,
            decide: impl FnOnce(&Value, &Value) -> Result<Value, String>,
        ) -> Result<Value, String> {
            route_with(
                input,
                &[native_codex_worker()],
                &self.0,
                &self.0.join("policy.json"),
                &self.0.join("rules.md"),
                decide,
            )
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn detached_model_agent_reads_effective_inherited_hints_into_one_router_request(){
        let root=std::env::temp_dir().join(format!(
            "relay-detached-agent-{}",crate::events::random_uuid()));
        let project=root.join("project");
        std::fs::create_dir_all(project.join("agents")).unwrap();
        std::fs::write(project.join("agents/parentprobe.agent.md"),
            "---\nname: parentprobe\nmodel: zai/glm-5.3-flash\nreasoning: medium\n---\n# Parent\n").unwrap();
        std::fs::write(project.join("agents/childprobe.agent.md"),
            "---\nname: childprobe\nextends: parentprobe\nreasoning: high\n---\n# Child\n").unwrap();
        let request=detached_model_agent_request(&project,&root,"childprobe","reviewer",None);
        assert_eq!(request["modelPreference"],json!({
            "model":"zai/glm-5.3-flash","reasoning":"high"}));
        assert_eq!(request["workerRequirements"]["capabilities"],json!(["model"]));
        assert_eq!(request["taskFacts"]["task"]["agentName"],"childprobe");
        assert_eq!(request["taskFacts"]["role"],"reviewer");
        let builtins=root.join("isolated-builtins");
        std::fs::create_dir_all(&builtins).unwrap();
        std::fs::write(builtins.join("outcome-reviewer.agent.md"),
            "---\nname: outcome-reviewer\nmodel: openai/gpt-6-luna\nreasoning: xhigh\n---\n# Implicit reviewer\n").unwrap();
        let implicit=detached_model_agent_request(&project,&root,
            "outcome-reviewer","reviewer",Some(&builtins));
        assert_eq!(implicit["modelPreference"],json!({
            "model":"openai/gpt-6-luna","reasoning":"xhigh"}));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn detached_and_managed_routes_share_quota_gates(){
        let f=Fixture::new();
        std::fs::write(f.0.join("zai.config.toml"),
            "model = \"glm\"\nmodel_provider = \"zai\"\n").unwrap();
        let now=chrono::Utc::now().timestamp();
        let snapshot=json!({"providers":[{"id":"zai","usage":{
            "available":true,"fiveHour":{"usedPercent":100,"resetsAt":now+3600}}}]});
        let mut request=json!({"taskFacts":{"role":"reviewer"},
            "routingInstruction":"Prefer Z.ai first"});
        let (requirements,opts,_)=options(&request).unwrap();
        let discover=|opts:&Value|crate::execution_routing::discover_execution_routes(
            &[native_codex_worker()],&requirements,opts,&f.0,
            &f.0.join("policy.json"),&f.0.join("rules.md"),now*1000).unwrap();
        assert!(discover(&opts).routes.iter().any(|r|r["model"]["provider"]=="zai"),
            "Z.ai must be a real eligible fixture route before applying quota");
        hydrate_observations(&mut request,||Ok(snapshot.clone()),||vec![]).unwrap();
        let choose=|_:&Value,contract:&Value|{
            let choices=contract["choices"].as_array().unwrap();
            assert!(choices.iter().all(|v|!v.as_str().unwrap().contains("provider=zai")));
            Ok(json!({"type":"choice","choice":choices[0]}))
        };
        let detached=f.route(&request,choose).unwrap();
        let (requirements,opts,recent)=options(&request).unwrap();
        let observed=discover(&opts);
        assert!(observed.evaluations.iter().any(|r|r["route"]["model"]["provider"]=="zai"
            &&r["eligible"]==false&&r["rejectionReasons"].as_array().unwrap().iter()
            .any(|reason|reason=="resource_unhealthy")));
        let managed=select_execution_route_with(&[native_codex_worker()],&requirements,&opts,
            &f.0,&f.0.join("policy.json"),&f.0.join("rules.md"),
            chrono::Utc::now().timestamp_millis(),&recent,true,choose).unwrap();
        assert_ne!(detached["routing"]["provider"],"zai");
        assert_eq!(detached["routing"]["provider"],managed["routing"]["provider"]);
        assert_eq!(detached["routing"]["profile"],managed["routing"]["profile"]);
        assert!(hydrate_observations(&mut json!({}),||Err("offline".into()),||vec![]).is_err());
        hydrate_observations(&mut request,||panic!("explicit observation"),||panic!("explicit history")).unwrap();
    }
    #[test]
    fn cli_and_managed_model_agents_share_discovery_and_decision_path() {
        let fixture=Fixture::new();
        let request=json!({"taskFacts":{"role":"reviewer"},
            "modelPreference":{"model":"openai/stronger","reasoning":"high"}});
        let select_quality=|_:&Value,contract:&Value|{
            let choice=contract["choices"].as_array().unwrap().iter()
                .find(|value|value.as_str().unwrap().contains("profile=quality"))
                .expect("configured quality profile");
            Ok(json!({"type":"choice","choice":choice}))
        };
        let cli=fixture.route(&request,select_quality).unwrap();
        let (requirements,opts,recent)=options(&request).unwrap();
        let managed=crate::execution_routing::select_execution_route_with(
            &[native_codex_worker()],&requirements,&opts,&fixture.0,
            &fixture.0.join("policy.json"),&fixture.0.join("rules.md"),
            chrono::Utc::now().timestamp_millis(),&recent,true,select_quality,
        ).unwrap();
        for key in ["provider","model","profile","reasoning","decidedBy"]{
            assert_eq!(cli["routing"][key],managed["routing"][key],"{key}");
        }
        assert_eq!(cli["selection"]["workerId"],managed["selection"]["workerId"]);
        assert_eq!(cli["model"],managed["model"]);
        let fallback=crate::execution_routing::select_execution_route_with(
            &[native_codex_worker()],&requirements,&opts,&fixture.0,
            &fixture.0.join("policy.json"),&fixture.0.join("rules.md"),
            chrono::Utc::now().timestamp_millis(),&recent,false,
            |_,_|panic!("Decision Engine must not run when disabled"),
        ).unwrap();
        assert_eq!(fallback["selection"]["workerId"],cli["selection"]["workerId"]);
        let mut invalid=request.clone();
        invalid["routingConstraints"]=json!({"model":"not-configured"});
        assert!(fixture.route(&invalid,select_quality).is_err());
    }
    #[test]
    fn model_agent_hint_reaches_router_but_does_not_pin_model_or_thinking() {
        let f=Fixture::new();
        let request=json!({"taskFacts":{"role":"reviewer"},
            "modelPreference":{"model":"openai/base","reasoning":"low"}});
        let out=f.route(&request,|_,contract|{
            let question=contract["question"].as_str().unwrap();
            assert!(question.contains("Prefer model: openai/base"));
            assert!(question.contains("Prefer reasoning: low"));
            assert!(question.contains("advisory only"));
            // The Engine may still choose a different eligible model.
            let choice=contract["choices"].as_array().unwrap().iter()
                .find(|v|v.as_str().unwrap().contains("profile=quality"))
                .unwrap();
            Ok(json!({"type":"choice","choice":choice}))
        }).unwrap();
        assert_eq!(out["routing"]["profile"],"quality");
        assert_eq!(out["routing"]["model"],"stronger");
        assert!(options(&json!({"modelPreference":{"model":42}})).is_err());
        assert!(options(&json!({"modelPreference":{"reasoning":""}})).is_err());
    }
    #[test]
    fn same_worker_router_applies_global_job_and_caller_instructions() {
        let f = Fixture::new();
        let out = f
            .route(&input(), |req, contract| {
                assert_eq!(req["facts"]["task_capabilities"], json!(["vision"]));
                assert_eq!(
                    req["facts"]["job_routing_preferences"],
                    json!({"profile":"quality"})
                );
                assert_eq!(
                    req["facts"]["caller_routing_instruction"],
                    input()["routingInstruction"]
                );
                assert_eq!(
                    req["facts"]["routing_instruction"],
                    "  Prefer the default profile globally.\r\n"
                );
                let q = contract["question"].as_str().unwrap();
                assert!(
                    q.find("Global routing instructions:").unwrap()
                        < q.find("Job routing preferences").unwrap()
                );
                assert!(
                    q.find("Job routing preferences").unwrap()
                        < q.find("Caller routing instructions").unwrap()
                );
                let choices = contract["choices"].as_array().unwrap();
                assert_eq!(choices.len(), 2);
                let choice = choices
                    .iter()
                    .find(|v| v.as_str().unwrap().contains("profile=quality"))
                    .unwrap();
                Ok(json!({"type":"choice","choice":choice}))
            })
            .unwrap();
        assert_eq!(out["routing"]["profile"], "quality");
        assert_eq!(out["routing"]["decidedBy"], "execution-router:jev");
    }
    #[test]
    fn hard_eligibility_precedes_all_preferences_and_canonical_fallback() {
        let f = Fixture::new();
        let mut i = input();
        let out = f.route(&i, |_, _| Err("unavailable".into())).unwrap();
        assert_eq!(out["routing"]["profile"], "quality");
        assert_eq!(out["routing"]["decisionEvidence"]["fallback"], true);
        i["eligibleProfiles"] = json!(["default"]);
        let out = f
            .route(&i, |_, _| panic!("single route must bypass engine"))
            .unwrap();
        assert_eq!(out["routing"]["model"], "base");
        i["eligibleProfiles"] = json!(["missing"]);
        assert!(f.route(&i, |_, _| panic!("no eligible route")).is_err());
        i["eligibleProfiles"] = json!(["quality"]);
        std::fs::write(
            f.0.join("policy.json"),
            r#"{"disabledProfiles":["quality"]}"#,
        )
        .unwrap();
        assert!(f.route(&i, |_, _| panic!("disabled profile")).is_err());
    }
    #[test]
    fn invalid_requests_never_reach_engine() {
        let f = Fixture::new();
        for (key, value) in [
            ("routingInstruction", json!(["bad"])),
            ("routingPreferences", json!({"profile":""})),
            ("eligibleProfiles", json!([])),
            ("excludedRoutes", json!([{}])),
            ("routingConstraints", json!({"typo":"x"})),
        ] {
            let mut i = input();
            i[key] = value;
            assert!(f.route(&i, |_, _| panic!("bad input")).is_err());
        }
    }
    #[test]
    fn explicit_rules_path_and_input_order() {
        let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            parse_args(&args(&[
                "--execution-router-rules",
                "rules.md",
                "--input-file",
                "-"
            ]))
            .unwrap(),
            ("-", Some("rules.md"))
        );
        assert!(parse_args(&args(&["--input-file", "-", "--input-file", "x"])).is_err());
        assert!(parse_args(&args(&["--input-file", "-", "--port", "12345"])).is_ok());
        assert!(parse_args(&args(&["--input-file", "-", "--port", "0"])).is_err());
    }
}
