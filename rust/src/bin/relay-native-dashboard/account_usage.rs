//! Native account telemetry for the unchanged Node Dashboard /api/usage
//! contract. Uses the providers' original read-only endpoints; never serves
//! secrets to the browser and never infers quota from Relay Task statistics.
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

static CACHE: OnceLock<Mutex<Option<(Instant, Value)>>> = OnceLock::new();

fn now_iso() -> String {
    chrono::DateTime::<chrono::Utc>::from(SystemTime::now()).to_rfc3339()
}

fn unavailable(reason: &str) -> Value {
    json!({"available":false,"generatedAt":now_iso(),"fiveHour":null,
        "weekly":null,"reason":reason})
}

fn rate_window(value: &Value) -> Option<Value> {
    let used = value["usedPercent"].as_f64()?;
    let minutes = value["windowDurationMins"].as_f64()?;
    if !(0.0..=100.0).contains(&used) || minutes <= 0.0 {
        return None;
    }
    let resets = value["resetsAt"].as_i64();
    Some(json!({"usedPercent":used,"windowMinutes":minutes,"resetsAt":resets}))
}

fn quota(primary: Option<Value>, secondary: Option<Value>, missing: &str) -> Value {
    let available = primary.is_some() && secondary.is_some();
    json!({"available":available,"generatedAt":now_iso(),"fiveHour":primary,
        "weekly":secondary,"reason": if available { Value::Null } else { json!(missing) }})
}

fn codex_usage() -> Value {
    let mut child = match Command::new("codex")
        .args(["app-server", "--stdio"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(_) => return unavailable("Codex app-server could not be started."),
    };
    let (tx, rx) = mpsc::sync_channel::<Value>(2);
    let stdout = child.stdout.take().expect("Codex stdout piped");
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(record) = serde_json::from_str::<Value>(&line) {
                if record["id"] == 2 {
                    let _ = tx.try_send(record);
                    break;
                }
            }
        }
    });
    let mut input = child.stdin.take();
    if let Some(stdin) = input.as_mut() {
        let _ = stdin.write_all(
            b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"relay-rust-dashboard\",\"version\":\"1\"},\"capabilities\":{}}}\n",
        );
        let _ = stdin.flush();
        std::thread::sleep(Duration::from_millis(100));
        let _ = stdin.write_all(
            b"{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"account/rateLimits/read\",\"params\":{}}\n",
        );
        let _ = stdin.flush();
    }
    let result = rx.recv_timeout(Duration::from_secs(6)).ok();
    drop(input);
    let _ = child.kill();
    let _ = child.wait();
    let _ = reader.join();
    let Some(result) = result else {
        return unavailable("Codex app-server rate-limit request timed out or failed.");
    };
    let limits = &result["result"]["rateLimits"];
    let primary = rate_window(&limits["primary"]);
    let secondary = rate_window(&limits["secondary"]);
    let (five, week) = match (&primary, &secondary) {
        (Some(a), Some(b)) if a["windowMinutes"] == 10080 => (secondary, primary),
        _ => (primary, secondary),
    };
    quota(
        five,
        week,
        "Codex did not return both account quota windows.",
    )
}

/// Supply the bearer token through curl's stdin config, never argv or logs.
fn fetch_provider(url: &str, env_key: &str) -> Result<Value, &'static str> {
    let key = std::env::var(env_key).map_err(|_| "Provider key is not configured.")?;
    if key.is_empty() || key.contains(['\n', '\r', '"']) {
        return Err("Provider key is not configured.");
    }
    let mut child = Command::new("curl")
        .args([
            "--silent",
            "--fail",
            "--location",
            "--max-time",
            "5",
            "--max-filesize",
            "500000",
            "--config",
            "-",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Account request could not start.")?;
    if let Some(mut stdin) = child.stdin.take() {
        let config = format!("url = \"{url}\"\nheader = \"Authorization: Bearer {key}\"\nheader = \"Accept: application/json\"\n");
        let _ = stdin.write_all(config.as_bytes());
    }
    let output = child
        .wait_with_output()
        .map_err(|_| "Account request failed.")?;
    if !output.status.success() {
        return Err("Account request failed or credentials were rejected.");
    }
    serde_json::from_slice(&output.stdout).map_err(|_| "Provider response was not JSON.")
}

fn zai_usage() -> Value {
    let response = match fetch_provider(
        "https://api.z.ai/api/monitor/usage/quota/limit",
        "ZAI_API_KEY",
    ) {
        Ok(value) => value,
        Err(reason) => return unavailable(reason),
    };
    let mut five = None;
    let mut week = None;
    if let Some(limits) = response["data"]["limits"].as_array() {
        for limit in limits {
            if !matches!(
                limit["type"].as_str(),
                Some("TOKENS_LIMIT" | "CREDIT_LIMIT")
            ) {
                continue;
            }
            let Some(used) = limit["percentage"].as_f64() else {
                continue;
            };
            if !(0.0..=100.0).contains(&used) {
                continue;
            }
            let next = limit["nextResetTime"].as_i64().map(|ms| ms / 1000);
            let item =
                |minutes| json!({"usedPercent":used,"windowMinutes":minutes,"resetsAt":next});
            match limit["unit"].as_i64() {
                Some(3) => five = Some(item(300)),
                Some(6) => week = Some(item(10080)),
                _ => (),
            }
        }
    }
    quota(five, week, "Z.ai returned no usable account quota windows.")
}

fn unavailable_credits(reason: &str) -> Value {
    json!({"available":false,"generatedAt":now_iso(),"balances":[],"reason":reason})
}
fn deepseek_credits() -> Value {
    let payload = match fetch_provider("https://api.deepseek.com/user/balance", "DEEPSEEK_API_KEY")
    {
        Ok(v) => v,
        Err(error) => return unavailable_credits(error),
    };
    let balances = payload["balance_infos"]
        .as_array()
        .map(|infos| {
            infos
                .iter()
                .filter_map(|item| {
                    let amount = item["total_balance"]
                        .as_f64()
                        .or_else(|| item["total_balance"].as_str()?.parse::<f64>().ok())?;
                    let currency = item["currency"].as_str().unwrap_or("credit");
                    Some(json!({"currency":currency,"total":amount,"used":null,"remaining":amount}))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let available = payload["is_available"] == true && !balances.is_empty();
    json!({"available":available,"generatedAt":now_iso(),"balances":balances,
        "reason":if available {Value::Null} else {json!("DeepSeek balance unavailable.")}})
}
fn openrouter_credits() -> Value {
    let payload = match fetch_provider("https://openrouter.ai/api/v1/credits", "OPENROUTER_API_KEY")
    {
        Ok(v) => v,
        Err(error) => return unavailable_credits(error),
    };
    let num = |v: &Value| v.as_f64().or_else(|| v.as_str()?.parse::<f64>().ok());
    let total = num(&payload["data"]["total_credits"]);
    let used = num(&payload["data"]["total_usage"]);
    let balances = if total.is_some() || used.is_some() {
        vec![json!({"currency":"USD","total":total,"used":used,
          "remaining":total.zip(used).map(|(t,u)|t-u)})]
    } else {
        Vec::new()
    };
    json!({"available":!balances.is_empty(),"generatedAt":now_iso(),
      "balances":balances,"reason":if balances.is_empty(){json!("OpenRouter credits unavailable.")}else{Value::Null}})
}

fn uncached() -> Value {
    let codex = std::thread::spawn(codex_usage);
    let zai = std::thread::spawn(zai_usage);
    let ds = std::thread::spawn(deepseek_credits);
    let router = std::thread::spawn(openrouter_credits);
    let openai = codex
        .join()
        .unwrap_or_else(|_| unavailable("Codex usage probe failed."));
    let zai = zai
        .join()
        .unwrap_or_else(|_| unavailable("Z.ai usage probe failed."));
    let ds = ds
        .join()
        .unwrap_or_else(|_| unavailable_credits("DeepSeek probe failed."));
    let router = router
        .join()
        .unwrap_or_else(|_| unavailable_credits("OpenRouter probe failed."));
    json!({"generatedAt":now_iso(),
       "providers":[{"id":"openai","label":"OpenAI","usage":openai},
                   {"id":"zai","label":"Z.ai","usage":zai}],
       "credits":[{"id":"deepseek","label":"DeepSeek","credits":ds},
                  {"id":"openrouter","label":"OpenRouter","credits":router}]})
}

pub(super) fn snapshot() -> Value {
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    let mut saved = cache
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some((at, usage)) = &*saved {
        if at.elapsed() < Duration::from_secs(30) {
            return usage.clone();
        }
    }
    let usage = uncached();
    *saved = Some((Instant::now(), usage.clone()));
    usage
}
