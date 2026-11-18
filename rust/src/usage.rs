// Node provenance: src/usage.ts. Provider quotas and Browser Workspace
// capacity are observations, never authoritative Worker lifecycle facts.
// All external commands are owned; no Codex CLI is executed during Phase1.
use crate::{
    continuation::{run_delivery_owned_process,DeliveryProcessOptions},
    local_merge_lock::iso8601_now,
    owned_process::OwnedProcessManager,
};
pub use crate::usage_registry::{UsageReader,UsageRegistry,UsageSnapshotProvider,
    UnavailableUsageReader,read_usage_snapshot};
pub use crate::usage_readers::{BrowserWorkspaceUsageReader,CodexSessionUsageReader,
    ZaiUsageReader,DeepSeekCreditReader,OpenRouterCreditReader};
use chrono::{DateTime,Utc};
use serde_json::{json,Value};
use std::{fs,path::{Path,PathBuf},time::Duration};

fn field<'a>(v:&'a Value,key:&str)->&'a str{
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
pub fn account_usage_unavailable(reason:&str)->Value{
    json!({"available":false,"generatedAt":iso8601_now(),
        "fiveHour":null,"weekly":null,"reason":reason})
}
pub fn credit_unavailable(reason:&str)->Value{
    json!({"available":false,"generatedAt":iso8601_now(),
        "balances":[],"reason":reason})
}
fn finite(value:Option<&Value>)->Option<f64>{
    let v=value?;
    v.as_f64().or_else(||v.as_str().and_then(|s|
        if s.trim().is_empty(){None}else{s.parse::<f64>().ok()}))
        .filter(|n|n.is_finite())
}
fn percent(value:Option<&Value>)->Option<f64>{
    finite(value).filter(|p|*p>=0.0&&*p<=100.0)
}
fn minutes(value:Option<&Value>)->Option<f64>{
    finite(value).filter(|n|*n>0.0)
}
fn epoch_seconds(value:Option<&Value>)->Option<f64>{
    finite(value).filter(|n|*n>0.0)
}
pub fn parse_window(value:&Value)->Option<Value>{
    let used=percent(value.get("used_percent"))?;
    let window=minutes(value.get("window_minutes"))?;
    Some(json!({"usedPercent":used,"windowMinutes":window,
        "resetsAt":epoch_seconds(value.get("resets_at"))}))
}
pub fn rate_limits_from_line(line:&str)->Option<Value>{
    let parsed=serde_json::from_str::<Value>(line).ok()?;
    if field(&parsed,"type")!="event_msg"
        ||parsed.pointer("/payload/type").and_then(Value::as_str)!=Some("token_count"){
        return None;
    }
    let limits=parsed.pointer("/payload/rate_limits")?;
    if !limits.is_object(){return None;}
    let windows= [limits.get("primary"),limits.get("secondary")].into_iter()
        .flatten().filter_map(parse_window).collect::<Vec<_>>();
    let timestamp=parsed.get("timestamp").and_then(Value::as_str)
        .filter(|s|DateTime::parse_from_rfc3339(s).is_ok())
        .unwrap_or("1970-01-01T00:00:00.000Z");
    Some(json!({"timestamp":timestamp,"windows":windows}))
}
fn snapshots_from_files(root:&Path,cutoff:i64,depth:u8,
    result:&mut Vec<(PathBuf,i64)>){
    if depth>5{return;}
    let Ok(entries)=fs::read_dir(root)else{return;};
    for entry in entries.flatten(){
        let path=entry.path();
        if entry.file_type().is_ok_and(|t|t.is_dir()){
            snapshots_from_files(&path,cutoff,depth+1,result);
            continue;
        }
        if !path.extension().is_some_and(|e|e=="jsonl"){continue;}
        let Ok(modified)=entry.metadata().and_then(|m|m.modified())else{continue;};
        let timestamp=modified.duration_since(std::time::UNIX_EPOCH)
            .map(|d|d.as_millis() as i64).unwrap_or(0);
        if timestamp>=cutoff{result.push((path,timestamp));}
    }
}
pub fn codex_session_usage(
    codex_home:&Path,lookback_days:i64,now:i64,
)->Value{
    let generated=chrono::DateTime::<Utc>::from_timestamp_millis(now)
        .map(|d|d.to_rfc3339_opts(chrono::SecondsFormat::Millis,true))
        .unwrap_or_else(iso8601_now);
    let cutoff=now-lookback_days.saturating_mul(86_400_000);
    let mut files=Vec::new();
    for dir in ["sessions","archived_sessions"]{
        snapshots_from_files(&codex_home.join(dir),cutoff,0,&mut files);
    }
    files.sort_by(|a,b|b.1.cmp(&a.1));
    let mut latest=String::new();
    let mut windows=Vec::<Value>::new();
    for (file,_) in &files{
        let Ok(contents)=fs::read_to_string(file)else{continue;};
        for line in contents.lines().filter(|l|l.contains("\"rate_limits\"")){
            if let Some(record)=rate_limits_from_line(line){
                let date=field(&record,"timestamp");
                if date>latest.as_str(){
                    latest=date.into();
                    windows=record.get("windows").and_then(Value::as_array)
                        .cloned().unwrap_or_default();
                }
            }
        }
    }
    let five=windows.iter().find(|w|
        w.get("windowMinutes").and_then(Value::as_f64)==Some(300.0)).cloned();
    let weekly=windows.iter().find(|w|
        w.get("windowMinutes").and_then(Value::as_f64)==Some(10_080.0)).cloned();
    let age=DateTime::parse_from_rfc3339(&latest)
        .ok().map(|at|now-at.timestamp_millis())
        .unwrap_or(i64::MAX);
    let fresh=(0..=900_000).contains(&age);
    let available=fresh&&five.is_some()&&weekly.is_some();
    let reason=if available{Value::Null}
        else if !latest.is_empty()&&!fresh{
            json!("Latest Codex account rate-limit telemetry is stale.")
        }else if !files.is_empty(){
            json!("Latest Codex account telemetry does not expose current 5-hour and weekly rate-limit windows.")
        }else{json!("No recent Codex account rate-limit telemetry is available.")};
    json!({"available":available,"generatedAt":generated,
        "fiveHour":five,"weekly":weekly,"reason":reason})
}
pub fn codex_app_server_usage_response(response:&Value)->Value{
    let limits=response.pointer("/result/rateLimits").unwrap_or(&Value::Null);
    let extract=|name:&str|->Option<Value>{
        let window=limits.get(name)?;
        let used=percent(window.get("usedPercent"))?;
        let duration=minutes(window.get("windowDurationMins"))?;
        Some(json!({"usedPercent":used,"windowMinutes":duration,
            "resetsAt":epoch_seconds(window.get("resetsAt"))}))
    };
    let mut windows=Vec::new();
    if let Some(w)=extract("primary"){windows.push(w);}
    if let Some(w)=extract("secondary"){windows.push(w);}
    let five=windows.iter().find(|w|
        w.get("windowMinutes").and_then(Value::as_f64)==Some(300.0));
    let weekly=windows.iter().find(|w|
        w.get("windowMinutes").and_then(Value::as_f64)==Some(10_080.0));
    let available=five.is_some()&&weekly.is_some();
    json!({"available":available,"generatedAt":iso8601_now(),
        "fiveHour":five,"weekly":weekly,
        "reason":if available{Value::Null}else{
            json!("Codex app-server did not return both account quota windows.")}})
}
pub fn unavailable_browser_workspace(reason:&str,observed:&str)->Value{
    json!({"name":"Harness","poolSize":null,"idle":null,
        "leased":null,"available":null,"observedAt":observed,"reason":reason})
}
fn nonnegative(v:Option<&Value>)->Option<f64>{
    v.and_then(Value::as_f64).filter(|n|n.is_finite()&&*n>=0.0)
}
pub fn parse_browser_workspace_capacity(
    output:&str,observed:&str,stale_after_ms:i64,exit_code:i32,
)->Value{
    let now=DateTime::parse_from_rfc3339(observed).ok()
        .map(|t|t.timestamp_millis()).unwrap_or(0);
    for line in output.trim().lines().rev(){
        let Ok(raw)=serde_json::from_str::<Value>(line)else{continue;};
        let stamp=raw.get("observedAt").and_then(Value::as_str)
            .filter(|s|DateTime::parse_from_rfc3339(s).is_ok())
            .unwrap_or(observed);
        if now-DateTime::parse_from_rfc3339(stamp).ok()
            .map(|t|t.timestamp_millis()).unwrap_or(0)>stale_after_ms{
            return unavailable_browser_workspace(
                "Browser Workspace capacity probe is stale.",observed);
        }
        let idle=nonnegative(raw.get("idle"));
        let leased=nonnegative(raw.get("leased"));
        let pool=nonnegative(raw.get("poolSize"));
        let available=nonnegative(raw.get("available")).or_else(||
            raw.get("available").and_then(Value::as_bool)
                .map(|b|if b{1.0}else{0.0}));
        if idle.is_some()||leased.is_some()||pool.is_some()||available.is_some(){
            return json!({"name":raw.get("name").and_then(Value::as_str)
                    .unwrap_or("Harness"),
                "poolSize":pool,"idle":idle,"leased":leased,
                "available":available,"observedAt":stamp,"reason":null});
        }
    }
    unavailable_browser_workspace(
        &if exit_code==0{
            "Browser Workspace capacity probe returned no usable capacity.".into()
        }else{format!("Browser Workspace capacity probe exited with code {exit_code}.")},
        observed)
}
pub fn browser_workspace_usage(command:&Path,timeout_ms:u64)->Value{
    let observed=iso8601_now();
    // Node spawnOwnedProcess reports ENOENT on absolute missing executables;
    // the managed Rust launcher instead returns a synthetic 126 status.
    // Preserve the real caller-visible error rather than inventing an exit.
    if command.is_absolute() && !command.is_file(){
        return unavailable_browser_workspace(
            "Browser Workspace capacity probe could not be started.",&observed);
    }
    let args=["capacity"];
    let mut manager=OwnedProcessManager::default();
    match run_delivery_owned_process(&mut manager,
        command.to_string_lossy().as_ref(),&args,None,
        "usage.browser-workspace",
        DeliveryProcessOptions{timeout:Some(Duration::from_millis(timeout_ms)),
            cancelled:None,supervisor_path:None,environment:None}){
        Ok(done)=>parse_browser_workspace_capacity(&done.stdout,&observed,
            900_000,done.code),
        Err(reason)=>unavailable_browser_workspace(
            &if reason.contains("timed out"){
                "Browser Workspace capacity probe timed out."
            }else{"Browser Workspace capacity probe could not be started."},
            &observed)
    }
}
pub fn account_usage_from_zai(payload:&Value)->Value{
    let limits=payload.pointer("/data/limits").and_then(Value::as_array);
    let read=|unit:u64,window_minutes:u64|->Option<Value>{
        let raw=limits?.iter().find(|item|
            matches!(field(item,"type"),"TOKENS_LIMIT"|"CREDIT_LIMIT")
            &&item.get("unit").and_then(Value::as_u64)==Some(unit))?;
        let percent=percent(raw.get("percentage"))?;
        let reset=raw.get("nextResetTime").and_then(Value::as_f64)
            .filter(|v|v.is_finite()).map(|v|(v/1000.0).floor() as i64);
        Some(json!({"usedPercent":percent,"windowMinutes":window_minutes,"resetsAt":reset}))
    };
    let five=read(3,300);
    let weekly=read(6,10_080);
    let available=five.is_some()&&weekly.is_some();
    json!({"available":available,"generatedAt":iso8601_now(),
        "fiveHour":five,"weekly":weekly,
        "reason":if available{Value::Null}
            else{json!("Z.ai returned no usable 5-hour and weekly Coding Plan quota windows.")}})
}
fn api_get(url:&str,token:&str)->Result<(u16,Value),String>{
    let mut response=ureq::Agent::new_with_defaults().get(url)
        .header("Authorization",&format!("Bearer {token}"))
        .header("Accept","application/json").call()
        .map_err(|e|e.to_string())?;
    let status=response.status().as_u16();
    let body=response.body_mut().read_json::<Value>()
        .unwrap_or(Value::Null);
    Ok((status,body))
}
pub fn zai_usage_reader(api_key:Option<&str>)->Value{
    let Some(token)=api_key.filter(|s|!s.is_empty())else{
        return account_usage_unavailable("ZAI_API_KEY is not configured.");
    };
    match api_get("https://api.z.ai/api/monitor/usage/quota/limit",token){
        Ok((status,payload)) if (200..300).contains(&status)=>account_usage_from_zai(&payload),
        Ok((status,_))=>account_usage_unavailable(
            &format!("Z.ai usage request failed with HTTP {status}.")),
        Err(_)=>account_usage_unavailable("Z.ai account usage request could not be completed."),
    }
}
pub fn deepseek_credit_reader(api_key:Option<&str>)->Value{
    let Some(token)=api_key.filter(|s|!s.is_empty())else{
        return credit_unavailable("DEEPSEEK_API_KEY is not configured.");
    };
    match api_get("https://api.deepseek.com/user/balance",token){
        Ok((status,payload)) if (200..300).contains(&status)=>{
            let balances=payload.get("balance_infos").and_then(Value::as_array)
                .into_iter().flatten().filter_map(|item|{
                    let remaining=finite(item.get("total_balance"))?;
                    Some(json!({
                        "currency":item.get("currency").and_then(Value::as_str)
                            .unwrap_or("credit"),
                        "total":remaining,"used":null,"remaining":remaining
                    }))
                }).collect::<Vec<_>>();
            let available=payload.get("is_available")==Some(&Value::Bool(true))
                &&!balances.is_empty();
            json!({"available":available,"generatedAt":iso8601_now(),
                "balances":balances,
                "reason":if balances.is_empty(){
                    json!("DeepSeek returned no usable balance information.")
                }else{Value::Null}})
        },
        Ok((status,_))=>credit_unavailable(
            &format!("DeepSeek balance request failed with HTTP {status}.")),
        Err(_)=>credit_unavailable("DeepSeek balance request could not be completed.")
    }
}
pub fn openrouter_credit_reader(api_key:Option<&str>)->Value{
    let Some(token)=api_key.filter(|s|!s.is_empty())else{
        return credit_unavailable("OPENROUTER_API_KEY is not configured.");
    };
    match api_get("https://openrouter.ai/api/v1/credits",token){
        Ok((status,payload)) if (200..300).contains(&status)=>{
            let total=finite(payload.pointer("/data/total_credits"));
            let used=finite(payload.pointer("/data/total_usage"));
            let remaining=total.zip(used).map(|(a,b)|a-b);
            let balances=if total.is_some()||used.is_some(){
                vec![json!({"currency":"USD","total":total,
                    "used":used,"remaining":remaining})]
            }else{Vec::new()};
            json!({"available":!balances.is_empty(),
                "generatedAt":iso8601_now(),
                "balances":balances,
                "reason":if balances.is_empty(){
                    json!("OpenRouter returned no usable credit information.")
                }else{Value::Null}})
        },
        Ok((status,_))=>credit_unavailable(
            &format!("OpenRouter credits request failed with HTTP {status}; this endpoint requires a management key.")),
        Err(_)=>credit_unavailable("OpenRouter credits request could not be completed.")
    }
}
pub fn usage_registry(
    openai:&Value,zai:&Value,deepseek:Option<&Value>,
    openrouter:Option<&Value>,browser:Option<&Value>,
)->Value{
    let mut result=json!({"generatedAt":iso8601_now(),
        "providers":[
            {"id":"openai","label":"OpenAI","usage":openai},
            {"id":"zai","label":"Z.ai","usage":zai}
        ],"credits":[]});
    if let Some(credits)=result["credits"].as_array_mut(){
        if let Some(deepseek)=deepseek{
            credits.push(json!({"id":"deepseek","label":"DeepSeek","credits":deepseek}));
        }
        if let Some(openrouter)=openrouter{
            credits.push(json!({"id":"openrouter","label":"OpenRouter","credits":openrouter}));
        }
    }
    if let Some(browser)=browser{result["browserWorkspace"]=browser.clone();}
    result
}
