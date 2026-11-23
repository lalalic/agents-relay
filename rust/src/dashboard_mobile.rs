// Node provenance: src/dashboard-mobile.ts. Owner-scoped, privacy-redacted
// read-only Job/Task/activity projections for Neo Mobile; no raw prompt data.
use regex::Regex;
use serde_json::{json,Value};
use std::sync::OnceLock;

fn id_pattern()->&'static Regex{
    static ID:OnceLock<Regex>=OnceLock::new();
    ID.get_or_init(||Regex::new(r"^[A-Za-z0-9_.-]{1,100}$").unwrap())
}
fn repo_pattern()->&'static Regex{
    static REPO:OnceLock<Regex>=OnceLock::new();
    REPO.get_or_init(||Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(/[A-Za-z0-9][A-Za-z0-9._-]{0,99}){0,3}$").unwrap())
}
fn state_pattern()->&'static Regex{
    static STATE:OnceLock<Regex>=OnceLock::new();
    STATE.get_or_init(||Regex::new(r"^[A-Z_]{2,40}$").unwrap())
}
fn field<'a>(value:&'a Value,name:&str)->&'a str{
    value.get(name).and_then(Value::as_str).unwrap_or("")
}
fn clip(value:&Value,max:usize)->String{
    let Some(s)=value.as_str()else{return String::new()};
    // The source is JS String.slice and bounds UTF-16 code units, not bytes.
    let cut=s.encode_utf16().take(max).collect::<Vec<_>>();
    String::from_utf16_lossy(&cut)
}
/// Port of Node `handleMobileDashboardRequest`: the route is owned by
/// NativeDashboardApi and uses the same authenticated Graph/SQLite service
/// callbacks as the existing Rust daemon. This public adapter is invoked by
/// the real HTTP dispatcher; it does not substitute a fixture or mint a
/// response without checking live scoped identity and cancellation readback.
pub fn handle_mobile_dashboard_request<S:crate::dashboard_api::DashboardApiServices>(
    api:&crate::dashboard_api::NativeDashboardApi<S>,
    services:&mut S,
    req:&crate::dashboard::DashboardRequest<'_>,
    parsed:&url::Url,
)->crate::dashboard::DashboardResponse{
    api.mobile(services,req,parsed)
}

pub fn valid_mobile_identity(id:&Value,repository:&Value)->bool{
    id.as_str().is_some_and(|s|id_pattern().is_match(s))
        &&repository.as_str().is_some_and(|s|s.encode_utf16().count()<=200&&repo_pattern().is_match(s))
}
pub fn project_mobile_job(row:&Value)->Option<Value>{
    if !row.is_object()||!valid_mobile_identity(&row["id"],&row["repository"]){return None}
    let state=clip(&row["state"],40);
    if !state_pattern().is_match(&state){return None}
    let runtime=clip(&row["runtimeStatus"],40);
    let status=if state_pattern().is_match(&runtime){runtime}else{state.clone()};
    Some(json!({
        "id":row["id"],"repository":row["repository"],
        "title":clip(&row["title"],120),"status":status,
        "createdAt":clip(&row["createdAt"],40),
        "updatedAt":clip(&row["updatedAt"],40),
        "cancellable":state=="DRAFT"||state=="ACTIVE",
    }))
}
// Identity strings are limited to ASCII alphanumeric, '_' '-' and '.'.
// Node Intl.Collator sort order is _ before - before . before digits before
// letters, with lowercase preceding uppercase only at secondary strength.
// The generic dashboard_data comparator prioritizes raw ASCII punctuation
// and does not preserve Node's mobile-ID page boundaries.
fn mobile_locale_compare(a:&str,b:&str)->std::cmp::Ordering{
    use std::cmp::Ordering;
    let weight=|c:u8|->(u8,u8){
        match c{
            b'_'=> (0,0),b'-'=>(1,0),b'.'=>(2,0),
            b'0'..=b'9'=>(3+c-b'0',0),
            b'a'..=b'z'=>(13+c-b'a',0),
            b'A'..=b'Z'=>(13+c-b'A',1),
            _=>(64+c.saturating_div(8),0),
        }
    };
    let left=a.as_bytes();let right=b.as_bytes();
    for (&a,&b) in left.iter().zip(right.iter()){
        let x=weight(a).0.cmp(&weight(b).0);
        if x!=Ordering::Equal{return x}
    }
    let lengths=left.len().cmp(&right.len());
    if lengths!=Ordering::Equal{return lengths}
    for (&a,&b) in left.iter().zip(right.iter()){
        let x=weight(a).1.cmp(&weight(b).1);
        if x!=Ordering::Equal{return x}
    }
    Ordering::Equal
}
pub fn project_mobile_jobs(rows:&Value,offset:f64,limit:f64)->Result<Value,String>{
    const MAX_SAFE:f64=9_007_199_254_740_991.0;
    if !offset.is_finite()||offset.fract()!=0.0||offset<0.0||offset>MAX_SAFE
        ||!limit.is_finite()||limit.fract()!=0.0||!(1.0..=20.0).contains(&limit){
        return Err("Invalid paging".into())
    }
    let mut jobs=rows.as_array().into_iter().flatten()
        .filter_map(project_mobile_job).collect::<Vec<_>>();
    let active=|value:&Value|!matches!(field(value,"status"),
        "CANCELLED"|"COMPLETED"|"FAILED"|"MERGED");
    jobs.sort_by(|a,b|{
        active(b).cmp(&active(a))
            .then_with(||crate::dashboard_data::locale_compare(
                field(b,"updatedAt"),field(a,"updatedAt")))
            .then_with(||mobile_locale_compare(
                field(a,"id"),field(b,"id")))
    });
    let total=jobs.len();
    let start=if offset>usize::MAX as f64{usize::MAX}else{offset as usize};
    let limit=limit as usize;
    let end=start.saturating_add(limit);
    let page=jobs.into_iter().skip(start).take(limit).collect::<Vec<_>>();
    let more=end<total;
    Ok(json!({
        "jobs":page,"total":total,
        "nextOffset":if more{Some(end)}else{None},
        "hasMore":more,
    }))
}
pub fn project_mobile_tasks(row:&Value,id:&Value,repository:&Value)->Result<Value,String>{
    if !row.is_object(){return Err("Job unavailable".into())}
    if row.get("id")!=Some(id)||row.get("repository")!=Some(repository)
        ||!row.get("tasks").is_some_and(Value::is_array){
        return Err("Job identity mismatch".into())
    }
    let tasks=row["tasks"].as_array().unwrap().iter().take(500)
        .filter_map(|task|{
            let id=task.get("id").and_then(Value::as_str)?;
            if !id_pattern().is_match(id){return None}
            let title=clip(&task["title"],160).trim().to_owned();
            if title.is_empty(){return None}
            Some(json!({"id":id,"title":title}))
        }).collect::<Vec<_>>();
    Ok(json!({"jobId":id,"repository":repository,"tasks":tasks}))
}
// Match the Node owner-safe mobile projection: source messages are untrusted.
// Expose only a bounded, conservative plain-language summary for selected
// lifecycle event types; otherwise the mobile UI uses the event action label.
fn public_activity_text(raw:&Value,private:&Regex)->Option<String>{
    let raw=raw.as_str()?;
    let summary=raw.chars().map(|c|if c.is_control(){' '}else{c})
        .collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ");
    let length=summary.encode_utf16().count();
    if length<12||length>800||
        matches!(summary.to_ascii_lowercase().as_str(),
            "implementation"|"troubleshooter"|"coordinator"|"reviewer"|
            "planner"|"developer"|"worker"|"architect")||
        summary.starts_with("task.")||summary.starts_with("review.")||
        summary.starts_with("planner.")||private.is_match(&summary){return None}
    Some(String::from_utf16_lossy(
        &summary.encode_utf16().take(240).collect::<Vec<_>>()))
}
fn mobile_activity_summary(entry:&Value,kind:&str)->Option<String>{
    if !matches!(kind,"task.progress"|"task.completed"|"task.failed"|
        "planner.completed"|"review.approved"|"review.changes_required"){
        return None
    }
    static PRIVATE:OnceLock<Regex>=OnceLock::new();
    let private=PRIVATE.get_or_init(||Regex::new(
        r"(?i)(https?://|www\.|[/\\\x60<>$@{}\[\]]|(secret|token|password|passphrase|credential|authorization|bearer|private|prompt|objective|api[_ -]?key)|[A-Za-z0-9_-]{36,})"
    ).unwrap());
    let data=entry.get("data").filter(|value|value.is_object());
    // Whitelist data.message, data.reason and event.message, not raw data.
    for candidate in [data.and_then(|v|v.get("message")),
        data.and_then(|v|v.get("reason")),entry.get("message")].into_iter().flatten(){
        if let Some(summary)=public_activity_text(candidate,private){
            return Some(summary);
        }
    }
    static PHASE:OnceLock<Regex>=OnceLock::new();
    let phase_pattern=PHASE.get_or_init(||Regex::new(r"^[-a-z0-9_]{2,60}$").unwrap());
    let phase=data.and_then(|v|v.get("phase"))?.as_str()?;
    if !phase_pattern.is_match(phase)||private.is_match(phase){return None}
    let label=phase.split(|ch|ch=='-'||ch=='_').filter(|word|!word.is_empty())
        .collect::<Vec<_>>().join(" ");
    if label.is_empty(){return None}
    if kind=="task.failed"{return Some(format!("Failed during {label}"))}
    let mut chars=label.chars();
    let first=chars.next()?;
    Some(first.to_uppercase().collect::<String>()+chars.as_str())
}

pub fn project_mobile_activity(rows:&Value)->Value{
    // History is at-least-once: keep the newest occurrence of each event.
    // Dedupe before limiting to avoid wasting the 100 visible slots.
    let mut seen=std::collections::HashSet::new();
    let events=rows.as_array().into_iter().flatten()
        .rev().filter(|entry|{
            let Some(id)=entry.get("event_id").and_then(Value::as_str)
                .filter(|id|!id.is_empty()&&id.len()<=100) else{return true};
            seen.insert(id.to_string())
        }).take(100).collect::<Vec<_>>();
    let mut events=events.into_iter().rev()
        .filter_map(|entry|{
            if !entry.is_object(){return None}
            let kind=clip(&entry["type"],80);
            let timestamp=clip(&entry["timestamp"],40);
            let ok_kind=kind.split_once('.').is_some_and(|(prefix,rest)|
                matches!(prefix,"job"|"task"|"review"|"planner")
                &&!rest.is_empty()&&rest.bytes().all(|c|c.is_ascii_lowercase()||c==b'_'));
            let timestamp_bytes=timestamp.as_bytes();
            let ok_time=timestamp_bytes.len()>=11
                &&timestamp_bytes.get(4)==Some(&b'-')
                &&timestamp_bytes.get(7)==Some(&b'-')
                &&timestamp_bytes.get(10)==Some(&b'T')
                &&timestamp_bytes[..4].iter().all(u8::is_ascii_digit)
                &&timestamp_bytes[5..7].iter().all(u8::is_ascii_digit)
                &&timestamp_bytes[8..10].iter().all(u8::is_ascii_digit);
            if !ok_kind||!ok_time{return None}
            let mut projection=json!({"type":kind,"timestamp":timestamp});
            if let Some(id)=entry.get("task_id").and_then(Value::as_str)
                .filter(|s|id_pattern().is_match(s)){
                projection["taskId"]=json!(id);
            }
            if let Some(content)=mobile_activity_summary(entry,&kind){
                projection["content"]=json!(content);
            }
            Some(projection)
        }).collect::<Vec<_>>();
    Value::Array(std::mem::take(&mut events))
}
#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn private_payload_is_never_exposed_and_scoped_identity_is_bound(){
        let data=json!({"id":"a","repository":"neo/toyalive-3d","state":"ACTIVE",
            "title":"mobile","objective":"SECRET","prompt":"SECRET",
            "tasks":[{"id":"task1","title":"Public","objective":"SECRET"}]});
        assert!(valid_mobile_identity(&data["id"],&data["repository"]));
        for repository in ["neo//toyalive","neo/../x","neo/%2e","neo/","/neo","neo?evil=1"]{
            assert!(!valid_mobile_identity(&json!("a"),&json!(repository)));
        }
        let job=project_mobile_job(&data).unwrap();
        assert_eq!(job["cancellable"],true);
        assert!(!job.to_string().contains("SECRET"));
        let tasks=project_mobile_tasks(&data,&json!("a"),&json!("neo/toyalive-3d")).unwrap();
        assert_eq!(tasks["tasks"][0]["title"],"Public");
        assert!(!tasks.to_string().contains("SECRET"));
        assert!(project_mobile_tasks(&data,&json!("a"),&json!("other")).is_err());
        assert!(project_mobile_jobs(&json!([data]),0.0,21.0).is_err());
    }
    #[test]
    fn mobile_activity_uses_safe_action_specific_details_only(){
        let at="2026-11-20T01:01:01Z";
        let events=project_mobile_activity(&json!([
            {"type":"task.progress","timestamp":at,"task_id":"2242",
                "message":"Verified the full iOS build and completed two review rounds."},
            {"type":"task.failed","timestamp":at,"task_id":"2242",
                "message":"Xcode validation blocked on the build host."},
            {"type":"task.started","timestamp":at,
                "message":"Task started with a private objective"},
            {"type":"task.progress","timestamp":at,
                "message":"Troubleshooter"},
            {"type":"task.progress","timestamp":at,
                "message":"SECRET_MESSAGE"},
            {"type":"task.progress","timestamp":at,
                "message":"Open /Users/person/Library/Caches for details."},
            {"type":"task.progress","timestamp":at,
                "message":"Read https://internal.example.org now."},
        ]));
        assert_eq!(events.as_array().unwrap().len(),7);
        assert_eq!(events[0]["content"],
            "Verified the full iOS build and completed two review rounds.");
        assert_eq!(events[1]["content"],
            "Xcode validation blocked on the build host.");
        for index in 2..7 {assert!(events[index].get("content").is_none());}
        assert!(!events.to_string().contains("SECRET_MESSAGE"));
        assert!(!events.to_string().contains("/Users/person"));
        let nested=project_mobile_activity(&json!([
            {"type":"task.progress","timestamp":at,"task_id":"2242",
                "message":"task.progress","data":{"phase":"self-review-round-2-complete",
                "objective":"SECRET_PROMPT"}},
            {"type":"task.failed","timestamp":at,"task_id":"2242",
                "message":"task.failed","data":{"phase":"validation",
                "reason":"Xcode could not compile because the build host was unavailable."}},
            {"type":"task.progress","timestamp":at,"task_id":"2242",
                "message":"task.progress","data":{"message":"Read /Users/private/document now.",
                "phase":"context-loaded"}},
        ]));
        assert_eq!(nested[0]["content"],"Self review round 2 complete");
        assert_eq!(nested[1]["content"],
            "Xcode could not compile because the build host was unavailable.");
        assert_eq!(nested[2]["content"],"Context loaded");
        assert!(!nested.to_string().contains("SECRET_PROMPT"));
        assert!(!nested.to_string().contains("/Users/"));
    }
    #[test]
    fn mobile_history_deduplicates_by_event_id_not_event_type(){
        let rows=json!([
            {"event_id":"old-replay","type":"task.started",
             "timestamp":"2026-11-22T19:40:00Z","task_id":"2242"},
            {"event_id":"old-replay","type":"task.started",
             "timestamp":"2026-11-22T19:40:03Z","task_id":"2242"},
            {"event_id":"another-milestone","type":"task.progress",
             "timestamp":"2026-11-22T19:41:00Z","task_id":"2242","data":{"phase":"validation"}},
            {"event_id":"another-milestone","type":"task.progress",
             "timestamp":"2026-11-22T19:41:02Z","task_id":"2242","data":{"phase":"validation"}},
            {"event_id":"next-milestone","type":"task.progress",
             "timestamp":"2026-11-22T19:41:04Z","task_id":"2242","data":{"phase":"verification"}}
        ]);
        let projected=project_mobile_activity(&rows);
        assert_eq!(projected.as_array().unwrap().len(),3);
        assert_eq!(projected[0]["timestamp"],"2026-11-22T19:40:03Z");
        assert_eq!(projected[1]["timestamp"],"2026-11-22T19:41:02Z");
        assert_eq!(projected[2]["timestamp"],"2026-11-22T19:41:04Z");
        // Distinct events with identical types remain visible.
        assert_eq!(projected[1]["type"],projected[2]["type"]);
        assert!(!projected.to_string().contains("event_id"));
    }
    #[test]
    fn redact_activity_and_paginate(){
        let jobs=json!([
          {"id":"done","repository":"vlog","state":"COMPLETED","updatedAt":"a"},
          {"id":"doing","repository":"vlog","state":"ACTIVE","updatedAt":"a"}
        ]);
        let page=project_mobile_jobs(&jobs,0.0,1.0).unwrap();
        assert_eq!(page["total"],2);
        assert_eq!(page["jobs"][0]["id"],"doing");
        assert_eq!(page["nextOffset"],1);
        let more=project_mobile_jobs(&jobs,1.0,1.0).unwrap();
        assert_eq!(more["jobs"][0]["id"],"done");
        assert_eq!(more["hasMore"],false);
        let source=json!([
            {"type":"task.completed","timestamp":"2026-11-20T01:01:01Z","task_id":"safe","message":"SECRET"},
            {"type":"secret.exfiltration","timestamp":"2026-11-20T01:01:01Z"}
        ]);
        let events=project_mobile_activity(&source);
        assert_eq!(events.as_array().unwrap().len(),1);
        assert_eq!(events[0]["taskId"],"safe");
        assert!(!events.to_string().contains("SECRET"));
    }
}
