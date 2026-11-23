// Direct Node src/dashboard-data.ts port. Readonly Job listing and workflow metadata.
// This module does not own workflow transitions, and never modifies durable SQLite.
use chrono::DateTime;
use serde_json::{json, Value};
use std::{cmp::Ordering, fs, path::Path};

pub const DASHBOARD_JOB_RESULT_LIMIT: usize = 20;
pub const DEFAULT_DASHBOARD_JOB_STATUSES: [&str; 3] = ["DRAFT", "ACTIVE", "COMPLETED"];
fn text<'a>(row: &'a Value, key: &str) -> &'a str {
    row.get(key).and_then(Value::as_str).unwrap_or("")
}
fn timestamp(row: &Value) -> i64 {
    let parse = |key: &str| {
        DateTime::parse_from_rfc3339(text(row, key))
            .ok()
            .map(|date| date.timestamp_millis())
    };
    parse("updatedAt")
        .or_else(|| parse("createdAt"))
        .unwrap_or(0)
}
// Node uses ICU collation; Darwin's en_US.UTF-8 strcoll_l follows the same
// primary accent and secondary case weights for Relay's repository/id sorting.
#[cfg(target_os = "macos")]
pub(crate) fn locale_compare(a: &str, b: &str) -> Ordering {
    use std::{ffi::CString, sync::OnceLock};
    // ICU (Node) sorts Latin accents at their base-letter primary weight, which
    // differs from Darwin strcoll_l. Compare primary weights before libc ties.
    fn primary(s: &str) -> String {
        s.chars()
            .flat_map(|c| {
                match c {
                    'á' | 'à' | 'â' | 'ä' | 'ã' | 'å' | 'Á' | 'À' | 'Â' | 'Ä' | 'Ã' | 'Å' => 'a',
                    'é' | 'è' | 'ê' | 'ë' | 'É' | 'È' | 'Ê' | 'Ë' => 'e',
                    'í' | 'ì' | 'î' | 'ï' | 'Í' | 'Ì' | 'Î' | 'Ï' => 'i',
                    'ó' | 'ò' | 'ô' | 'ö' | 'õ' | 'Ó' | 'Ò' | 'Ô' | 'Ö' | 'Õ' => 'o',
                    'ú' | 'ù' | 'û' | 'ü' | 'Ú' | 'Ù' | 'Û' | 'Ü' => 'u',
                    'ñ' | 'Ñ' => 'n',
                    'ç' | 'Ç' => 'c',
                    other => other,
                }
                .to_lowercase()
            })
            .collect()
    }
    let primary_order = primary(a).cmp(&primary(b));
    if primary_order != Ordering::Equal {
        return primary_order;
    }
    unsafe extern "C" {
        fn newlocale(
            mask: libc::c_int,
            name: *const libc::c_char,
            base: *mut libc::c_void,
        ) -> *mut libc::c_void;
        fn strcoll_l(
            a: *const libc::c_char,
            b: *const libc::c_char,
            locale: *mut libc::c_void,
        ) -> libc::c_int;
    }
    static COLLATOR: OnceLock<usize> = OnceLock::new();
    let locale = *COLLATOR.get_or_init(|| unsafe {
        newlocale(63, c"en_US.UTF-8".as_ptr(), std::ptr::null_mut()) as usize
    });
    if locale != 0 {
        if let (Ok(aa), Ok(bb)) = (CString::new(a), CString::new(b)) {
            let result =
                unsafe { strcoll_l(aa.as_ptr(), bb.as_ptr(), locale as *mut libc::c_void) };
            return result.cmp(&0);
        }
    }
    a.to_lowercase()
        .cmp(&b.to_lowercase())
        .then_with(|| b.cmp(a))
}
#[cfg(not(target_os = "macos"))]
pub(crate) fn locale_compare(a: &str, b: &str) -> Ordering {
    fn primary(s: &str) -> String {
        s.chars()
            .flat_map(|c| {
                match c {
                    'á' | 'à' | 'â' | 'ä' | 'ã' | 'å' | 'Á' | 'À' | 'Â' | 'Ä' | 'Ã' | 'Å' => 'a',
                    'é' | 'è' | 'ê' | 'ë' | 'É' | 'È' | 'Ê' | 'Ë' => 'e',
                    'í' | 'ì' | 'î' | 'ï' | 'Í' | 'Ì' | 'Î' | 'Ï' => 'i',
                    'ó' | 'ò' | 'ô' | 'ö' | 'õ' | 'Ó' | 'Ò' | 'Ô' | 'Ö' | 'Õ' => 'o',
                    'ú' | 'ù' | 'û' | 'ü' | 'Ú' | 'Ù' | 'Û' | 'Ü' => 'u',
                    'ñ' | 'Ñ' => 'n',
                    'ç' | 'Ç' => 'c',
                    other => other,
                }
                .to_lowercase()
            })
            .collect()
    }
    primary(a)
        .cmp(&primary(b))
        .then_with(|| a.to_lowercase().cmp(&b.to_lowercase()))
        .then_with(|| b.cmp(a))
}
fn inventory_order(a: &Value, b: &Value) -> Ordering {
    timestamp(b)
        .cmp(&timestamp(a))
        .then_with(|| locale_compare(text(a, "repository"), text(b, "repository")))
        .then_with(|| locale_compare(text(a, "id"), text(b, "id")))
}
fn display_order(a: &Value, b: &Value) -> Ordering {
    let lifecycle = |j: &Value| {
        if ["COMPLETED", "CANCELLED"].contains(&text(j, "state")) {
            1
        } else {
            0
        }
    };
    lifecycle(a)
        .cmp(&lifecycle(b))
        .then_with(|| inventory_order(a, b))
}
fn repos(jobs: &[Value]) -> Vec<String> {
    let mut names = jobs
        .iter()
        .filter_map(|j| j.get("repository").and_then(Value::as_str))
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    names.sort();
    names.dedup();
    names
}
fn result(jobs: Vec<Value>, all: &[Value], total: usize) -> Value {
    json!({"jobs":jobs,"repositories":repos(all),"total":total})
}
pub fn list_dashboard_job_inventory(jobs: &[Value], repository: &str) -> Value {
    let mut selected = jobs
        .iter()
        .filter(|job| repository.is_empty() || text(job, "repository") == repository)
        .cloned()
        .collect::<Vec<_>>();
    selected.sort_by(inventory_order);
    let total = selected.len();
    result(selected, jobs, total)
}
fn param(query: &str, names: &[&str]) -> Option<String> {
    let params =
        url::form_urlencoded::parse(query.trim_start_matches('?').as_bytes()).collect::<Vec<_>>();
    for name in names {
        if let Some((_, v)) = params.iter().find(|(key, _)| key == name) {
            return Some(v.to_string());
        }
    }
    None
}
fn js_lower(value: &str) -> String {
    value.to_lowercase()
}
pub fn search_dashboard_jobs(jobs: &[Value], query: &str) -> Value {
    let requested = param(query, &["status", "statuses"])
        .unwrap_or_default()
        .trim()
        .to_uppercase();
    let status = if ["DRAFT", "ACTIVE", "COMPLETED", "CANCELLED"].contains(&requested.as_str()) {
        requested.as_str()
    } else {
        ""
    };
    let repository = param(query, &["repo", "repositories", "repos"])
        .unwrap_or_default()
        .trim()
        .to_string();
    let search = js_lower(param(query, &["q"]).unwrap_or_default().trim());
    let matching_status = |job: &Value, wanted: &str| {
        if wanted == "DRAFT" {
            job["draft"] == true || text(job, "state") == "DRAFT"
        } else {
            text(job, "state") == wanted
        }
    };
    let mut matching = jobs
        .iter()
        .filter(|job| {
            let fits = if !status.is_empty() {
                matching_status(job, status)
            } else {
                DEFAULT_DASHBOARD_JOB_STATUSES
                    .iter()
                    .any(|s| matching_status(job, s))
            };
            if !fits || (!repository.is_empty() && text(job, "repository") != repository) {
                return false;
            }
            if search.is_empty() {
                return true;
            }
            js_lower(if text(job, "title").is_empty() {
                text(job, "id")
            } else {
                text(job, "title")
            })
            .contains(&search)
                || js_lower(text(job, "id")).contains(&search)

        })
        .cloned()
        .collect::<Vec<_>>();
    matching.sort_by(inventory_order);
    let total = matching.len();
    matching.truncate(DASHBOARD_JOB_RESULT_LIMIT);
    matching.sort_by(display_order);
    result(matching, jobs, total)
}
pub fn effective_github_usage(snapshot: Option<&Value>, runtime: Option<&Value>) -> Option<Value> {
    let mut smallest: Option<(f64, Value)> = None;
    for state in [snapshot, runtime].into_iter().flatten() {
        for key in ["core", "graphql", "search"] {
            let candidate = &state["resources"][key];
            let Some(limit) = candidate["limit"].as_f64() else {
                continue;
            };
            let Some(remaining) = candidate["remaining"].as_f64() else {
                continue;
            };
            let Some(reset) = candidate["reset"].as_f64() else {
                continue;
            };
            if !limit.is_finite() || limit <= 0. || !remaining.is_finite() || !reset.is_finite() {
                continue;
            }
            let ratio = remaining / limit;
            if smallest
                .as_ref()
                .is_none_or(|(current, _)| ratio < *current)
            {
                smallest = Some((
                    ratio,
                    json!({"limit":limit,"remaining":remaining,"reset":reset}),
                ));
            }
        }
    }
    smallest.map(|(_, value)| value)
}
pub fn dashboard_workflow_graphs(directory: &Path) -> Result<Vec<Value>, String> {
    let mut names = fs::read_dir(directory)
        .map_err(|e| e.to_string())?
        .map(|entry| entry.map_err(|e| e.to_string()))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|s| s.ends_with(".mmd"))
        .collect::<Vec<_>>();
    names.sort();
    names.into_iter().map(|name|{
        let source=fs::read_to_string(directory.join(&name)).map_err(|e|e.to_string())?;
        let fields=if source.starts_with("---\n")||source.starts_with("---\r\n"){let normalized=source.replace("\r\n","\n");normalized[4..].split_once("\n---").map(|(meta,_)|meta.to_string()).unwrap_or_default()}else{String::new()};
        let field=|key:&str|fields.lines().find_map(|line|line.strip_prefix(&format!("{key}:")).map(|s|s.trim().to_string())).unwrap_or_default();
        let id=name.trim_end_matches(".mmd");let title=field("title");
        let fallback=if name=="main.mmd"{"Main / Happy Path".into()}else{id.split('-').map(|p|{let mut chars=p.chars();chars.next().map(|c|c.to_uppercase().to_string()+chars.as_str()).unwrap_or_default()}).collect::<Vec<_>>().join(" ")};
        Ok(json!({"id":id,"name":if title.is_empty(){fallback}else{title},"description":field("description"),"path":format!("workflow/{name}"),"source":source}))
    }).collect()
}
pub fn event_history(job_id: &str, task_id: Option<&str>, limit: i64, env: &Value) -> Vec<Value> {
    crate::events_bus_runtime::events_bus_history(job_id, task_id, &json!(limit), env)
        .ok()
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn inventory_is_complete_and_sorted() {
        let jobs = vec![
            json!({"id":"2","repository":"Z","state":"CANCELLED","updatedAt":"2026-02-01T00:00:00Z"}),
            json!({"id":"1","repository":"a","state":"ACTIVE","updatedAt":"2026-01-01T00:00:00Z"}),
        ];
        let res = list_dashboard_job_inventory(&jobs, "");
        assert_eq!(res["total"], 2);
        assert_eq!(res["jobs"][0]["id"], "2");
        assert_eq!(res["repositories"], json!(["Z", "a"]));
        let filtered = search_dashboard_jobs(&jobs, "");
        assert_eq!(filtered["total"], 1);
        assert_eq!(filtered["jobs"][0]["id"], "1");
        assert_eq!(
            search_dashboard_jobs(&jobs, "status=CANCELLED")["jobs"][0]["id"],
            "2"
        );
    }
    #[test]
    fn filters_before_pagination_and_draft_semantics() {
        let mut jobs=(1..=25).map(|i|json!({"id":i.to_string(),"title":format!("Task {i}"),"repository":"r","state":"ACTIVE","createdAt":format!("2026-03-{i:02}T00:00:00Z")})).collect::<Vec<_>>();
        jobs.push(json!({"id":"draft","repository":"t","draft":true,"state":"ACTIVE"}));
        let q = search_dashboard_jobs(&jobs, "repo=r");
        assert_eq!(q["total"], 25);
        assert_eq!(q["jobs"].as_array().unwrap().len(), 20);
        assert_eq!(q["jobs"][0]["id"], "25");
        assert_eq!(search_dashboard_jobs(&jobs, "status=DRAFT")["total"], 1);
        assert_eq!(search_dashboard_jobs(&jobs, "q=pr%23%2012")["total"], 0);
    }
    #[test]
    fn rate_limit_and_url_validations() {
        let usage=effective_github_usage(Some(&json!({"resources":{"core":{"limit":100,"remaining":80,"reset":10},"search":{"limit":20,"remaining":2,"reset":11}}})),None).unwrap();
        assert_eq!(usage["remaining"], 2.0);
    }
    #[test]
    fn workflow_read_without_live_side_effects() {
        let root = std::env::temp_dir().join(format!("rust2-workflow-meta-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("main.mmd"),
            "---\ntitle: Test Graph\ndescription: Good\n---\ngraph TD\n",
        )
        .unwrap();
        let graphs = dashboard_workflow_graphs(&root).unwrap();
        assert_eq!(graphs[0]["name"], "Test Graph");
        assert_eq!(graphs[0]["description"], "Good");
        std::fs::remove_dir_all(root).unwrap();
    }
}
