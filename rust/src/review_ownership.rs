//! Evidence-based ownership routing for completed immutable-head Final Reviews.
//! Only a verified owner may receive an automatic Revision. Ambiguous scope
//! belongs to the Planner, never to a guessed Worker or implicit model call.
use crate::{
    final_review_role::is_final_review_agent,
    job_task_id_sequence::allocate_entity_id,
    local_merge_lock::iso8601_now,
    review_revision_model::record_review_owned_revision_request,
    workflow::review_v2::decide_review_lifecycle,
};
use serde_json::{json,Value};
use std::{collections::{BTreeMap,HashSet},path::Path};
fn field<'a>(v:&'a Value,k:&str)->&'a str{v.get(k).and_then(Value::as_str).unwrap_or("")}
fn rows<'a>(v:&'a Value,k:&str)->&'a [Value]{v.get(k).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])}
fn implementation(task:&Value)->bool{
    field(task,"state")=="SUCCEEDED"
        &&field(task,"kind")!="planner"
        &&task.get("revision").is_none_or(Value::is_null)
        &&!is_final_review_agent(task.get("agentName").and_then(Value::as_str))
        &&!matches!(field(task,"agentName"),"troubleshooter"|"coordinator"|"review-chair"|"reviewer")
        &&(field(task,"agentName")=="implementation"
            ||rows(task,"capabilities").iter().any(|v|v=="implementation")
            ||field(task,"role")=="implementation")
}
fn normalized_path(path:&str)->String{
    path.trim().trim_start_matches("./").replace('\\',"/")
}
fn source_paths(task:&Value)->HashSet<String>{
    let mut paths=HashSet::new();
    for root in [task,task.get("result").unwrap_or(&Value::Null),
        task.pointer("/result/data").unwrap_or(&Value::Null)]{
        for key in ["changedFiles","sourceFiles","files","paths"]{
            for entry in rows(root,key){
                let path=entry.as_str().or_else(||entry.get("path").and_then(Value::as_str));
                if let Some(path)=path.filter(|v|!v.is_empty()){
                    paths.insert(normalized_path(path));
                }
            }
        }
    }
    paths
}
fn finding_paths(finding:&Value)->HashSet<String>{
    let mut paths=HashSet::new();
    if let Some(path)=finding.get("file").and_then(Value::as_str)
        .or_else(||finding.get("path").and_then(Value::as_str)){
        paths.insert(normalized_path(path));
    }
    for key in ["files","paths"]{
        for entry in rows(finding,key){
            let path=entry.as_str().or_else(||entry.get("path").and_then(Value::as_str));
            if let Some(path)=path{paths.insert(normalized_path(path));}
        }
    }
    paths
}
fn raw_findings(review_task:&Value)->Option<&[Value]>{
    let data=review_task.pointer("/result/data")?;
    for path in ["/outcome/blocking_findings","/outcome/blockingFindings",
        "/findings","/review/findings","/review/issues","/issues"]{
        if let Some(value)=data.pointer(path).and_then(Value::as_array){
            return Some(value);
        }
    }
    None
}
fn assigned_task<'a>(finding:&Value,candidates:&[&'a Value])->Option<&'a Value>{
    let requested=["ownerTaskId","owner_task_id","originalTaskId","original_task_id"]
        .iter().find_map(|key|finding.get(*key).and_then(Value::as_str))
        .filter(|v|!v.is_empty());
    if let Some(id)=requested{
        // Invalid explicit ownership is NOT silently overridden.
        return candidates.iter().copied().find(|t|field(t,"id")==id);
    }
    if candidates.len()==1{return Some(candidates[0]);}
    let paths=finding_paths(finding);
    if paths.is_empty(){return None;}
    let matching=candidates.iter().copied().filter(|task|{
        let files=source_paths(task);
        !files.is_empty()&&paths.iter().any(|p|files.contains(p))
    }).collect::<Vec<_>>();
    (matching.len()==1).then(||matching[0])
}
/// Immutable evidence + current Job state are the only inputs. Never infer
/// ownership from an untrusted explanation string or an expired Review round.
pub fn ownership_assessment(job:&Value)->Option<Value>{
    let review=job.get("review")?;
    if field(review,"outcome")!="changes_required"
        ||field(review,"revisionDisposition")=="targeted"{return None;}
    let review_id=field(review,"taskId");
    let head=field(review,"headSha");
    if head.is_empty()||head!=field(job,"headSha"){return None;}
    let reviewer=rows(job,"tasks").iter().find(|task|
        field(task,"id")==review_id&&is_final_review_agent(task["agentName"].as_str())
            &&field(task,"state")=="SUCCEEDED"
            &&field(task,"reviewHeadSha")==head)?;
    let round=rows(job,"reviewRevisionRounds").iter().find(|round|
        field(round,"reviewTaskId")==review_id
            &&field(round,"headSha")==head
            &&field(round,"status")=="changes_required"
            &&!field(round,"reviewExecutionId").is_empty())?;
    if !matches!(reviewer.pointer("/result/data/verdict").and_then(Value::as_str),
        Some("changes-required"|"changes_required")){return None;}
    let raw=raw_findings(reviewer)?;
    if raw.is_empty()||raw.len()>200{return None;}
    let candidates=rows(job,"tasks").iter().filter(|t|implementation(t)).collect::<Vec<_>>();
    let mut assigned:BTreeMap<String,Vec<Value>>=BTreeMap::new();
    let mut unresolved=Vec::new();let mut seen=HashSet::new();
    for (i,finding) in raw.iter().enumerate(){
        let summary=if let Some(text)=finding.as_str(){text.trim()}
            else{["summary","message","title"].iter().find_map(|k|
                finding.get(*k).and_then(Value::as_str)).unwrap_or("").trim()};
        let id=finding.get("id").and_then(Value::as_str)
            .filter(|v|!v.trim().is_empty()).map(str::to_owned)
            .unwrap_or_else(||format!("F-{}",i+1));
        if summary.is_empty()||summary.encode_utf16().count()>4000
            ||id.encode_utf16().count()>160||!seen.insert(id.clone()){
            return None; // Malformed evidence is not auto-routable.
        }
        let item=json!({"id":id,"summary":summary,"evidence":finding.get("evidence")});
        if let Some(owner)=assigned_task(finding,&candidates){
            assigned.entry(field(owner,"id").into()).or_default().push(item);
        }else{unresolved.push(item);}
    }
    Some(json!({"reviewTaskId":review_id,"reviewExecutionId":round["reviewExecutionId"],
        "headSha":head,"assigned":assigned,"unresolved":unresolved,
        "allOwned":unresolved.is_empty()&&!assigned.is_empty()}))
}

/// Runs BEFORE Planner orchestration, in one speculative Reconcile snapshot.
/// A single CAS commits both the durable ownership evidence and Revision Tasks.
/// SQLite global allocator is called only before the enclosing Job CAS, just
/// like other Graph-created Tasks; idempotent keys cover a concurrent wake.
pub fn route_review_ownership(graph:&Path,store_dir:&Path,job:&mut Value)
    ->Result<Vec<Value>,String>{
    let Some(mut assessment)=ownership_assessment(job)else{return Ok(vec![])};
    // Respect any already-running review-triggered Plan or authorized
    // reviewer-issued revision requests. The reconciler must never race a
    // Planner or duplicate work already submitted by the Reviewer.
    let review_id=field(&assessment,"reviewTaskId").to_owned();
    let head=field(&assessment,"headSha").to_owned();
    let work_owned=rows(job,"plans").iter().any(|plan|
        plan.pointer("/trigger/source").and_then(Value::as_str)==Some("review")
            &&plan.pointer("/trigger/reviewTaskId").and_then(Value::as_str)
                ==Some(review_id.as_str())
            &&field(plan,"status")!="FAILED");
    let existing=rows(job,"reviewRevisionRequests").iter().any(|request|
        field(request,"reviewTaskId")==review_id
            &&field(request,"reviewHeadSha")==head
            &&field(request,"status")!="stale");
    if work_owned||existing{
        assessment["allOwned"]=json!(false);
        assessment["manualOwnershipInProgress"]=json!(true);
    }
    if job.pointer("/review/ownershipTriage").is_some_and(|previous|
        previous["reviewTaskId"]==assessment["reviewTaskId"]
            &&previous["headSha"]==assessment["headSha"]){return Ok(vec![]);}
    let mut events=Vec::new();
    let groups=assessment["assigned"].as_object()
        .ok_or("Ownership assessment missing assigned groups")?;
    if !groups.is_empty(){
        let all_owned=assessment["allOwned"]==true;
        let decision=decide_review_lifecycle(graph,Some("changes_required"),
            "review.ownership_routed",&json!({"ownershipResolved":all_owned,
                "ownershipPartial":!all_owned}))?;
        let action=if all_owned{"review.awaitTargetedRevisions"}
            else{"review.routeKnownOwners"};
        if decision["accepted"]!=true
            ||decision["target"]!="CHANGES_REQUIRED"
            ||!rows(&decision,"actions").iter().any(|a|a["id"]==action){
            return Err("Review Graph rejected automatic ownership routing".into());
        }
        for (owner,findings) in groups{
            let job_id=field(job,"id");
            let reviewer_id=field(&assessment,"reviewTaskId");
            let head=field(&assessment,"headSha");
            let request_id=format!("auto-review-owner:{reviewer_id}:{owner}:{head}");
            let occupied=rows(job,"tasks").iter().filter_map(|task|
                task.get("id").and_then(Value::as_str).map(str::to_owned))
                .collect::<HashSet<_>>();
            let child=allocate_entity_id(store_dir,field(job,"repository"),"task",
                Some(&format!("review-owner:{job_id}:{reviewer_id}:{owner}:{head}")),
                &occupied)?;
            let receipt=record_review_owned_revision_request(graph,job,&json!({
                "requestId":request_id,"reviewTaskId":reviewer_id,
                "reviewExecutionId":assessment["reviewExecutionId"],
                "headSha":head,"originalTaskId":owner,"allocatedTaskId":child,
                "findings":findings
            }))?;
            if receipt["created"]==true{
                events.push(json!({"type":"review.ownership_assigned",
                    "ownerTaskId":owner,"revisionTaskId":child,
                    "reviewTaskId":reviewer_id,"headSha":head}));
            }
        }
        let id=field(&assessment,"reviewTaskId");
        let request_ids=rows(job,"reviewRevisionRequests").iter()
            .filter(|r|field(r,"reviewTaskId")==id)
            .filter_map(|r|r.get("requestId").cloned()).collect::<Vec<_>>();
        if let Some(round)=job.get_mut("reviewRevisionRounds").and_then(Value::as_array_mut)
            .and_then(|rounds|rounds.iter_mut().find(|r|field(r,"reviewTaskId")==id)){
            round["requestIds"]=json!(request_ids);
        }
        // Do not suppress Re-Planner for the unowned subset. It must add
        // only genuinely new work after the direct owner Revisions are saved.
        if all_owned {job["review"]["revisionDisposition"]=json!("targeted");}
    }
    job["review"]["ownershipTriage"]=assessment;
    job["review"]["updatedAt"]=json!(iso8601_now());
    Ok(events)
}

#[cfg(test)]
mod tests{
    use super::*;
    use std::fs;
    use std::time::{SystemTime,UNIX_EPOCH};
    const THREAD:&str="38f84f9e-410d-4e36-96e0-a420594a102d";
    fn job(findings:Value,second:bool)->Value{
        let mut tasks=vec![json!({"id":"12","jobId":"7","kind":"work",
            "title":"Implement voice","agentName":"implementation","state":"SUCCEEDED",
            "adapter":"codex","threadId":THREAD,"attempt":1,"maxAttempts":2,
            "result":{"data":{"changedFiles":["src/voice.swift"]}},
            "input":"Implement microphone fixes","output":{"kind":"task_pr"}})];
        if second { tasks.push(json!({"id":"13","jobId":"7","kind":"work",
            "title":"Implement button","agentName":"implementation","state":"SUCCEEDED",
            "adapter":"codex","attempt":1,"result":{"data":{"changedFiles":["src/button.swift"]}},
            "input":"Implement buttons","output":{"kind":"task_pr"}}));}
        tasks.push(json!({"id":"20","jobId":"7","kind":"work",
            "agentName":"job-acceptance-reviewer","reviewHeadSha":"sha-new",
            "state":"SUCCEEDED","adapter":"codex", "result":{"data":{
                "verdict":"changes-required","head_sha":"sha-new",
                "outcome":{"blocking_findings":findings}
            }}}));
        json!({"id":"7","repository":"fixture","title":"Voice Job","state":"ACTIVE",
            "priority":"P2","headSha":"sha-new","tasks":tasks,
            "review":{"outcome":"changes_required","taskId":"20","headSha":"sha-new",
                "revisionDisposition":"needs-ownership"},
            "reviewRevisionRounds":[{"reviewTaskId":"20","reviewExecutionId":"exec-20",
                "headSha":"sha-new","status":"changes_required","requestIds":[]}],"plans":[]})
    }
    fn temp()->std::path::PathBuf{
        let root=std::env::temp_dir().join(format!("relay-review-owner-{}-{}",
            std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir_all(root.join("stores")).unwrap();root
    }
    fn graph()->std::path::PathBuf{std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow")}
    #[test]
    fn single_implementation_routes_directly_and_resumes_codex_thread(){
        let root=temp();let mut job=job(json!([{"id":"F-1","summary":"Fix microphone"}]),false);
        assert_eq!(ownership_assessment(&job).unwrap()["assigned"]["12"][0]["id"],"F-1");
        let events=route_review_ownership(&graph(),&root.join("stores"),&mut job).unwrap();
        assert_eq!(events.len(),1);
        assert_eq!(job["review"]["revisionDisposition"],"targeted");
        assert_eq!(job["tasks"].as_array().unwrap().len(),3);
        let child=&job["tasks"][2];
        assert_eq!(child["parentTaskId"],"12");
        assert_eq!(child["threadId"],THREAD);
        assert_eq!(child["revision"]["originalTaskId"],"12");
        assert_eq!(job["reviewRevisionRequests"][0]["findings"][0]["id"],"F-1");
        assert_eq!(job["reviewRevisionRounds"][0]["requestIds"].as_array().unwrap().len(),1);
        assert!(!crate::review_replan::review_needs_replan(&job),
            "fully owned feedback must never create an unnecessary Planner");
        crate::review_revision_execution::reconcile_review_revision_facts(&graph(),&mut job).unwrap();
        assert_eq!(job["reviewRevisionRequests"][0]["status"],"queued");
        assert!(route_review_ownership(&graph(),&root.join("stores"),&mut job).unwrap().is_empty());
        assert_eq!(job["tasks"].as_array().unwrap().len(),3);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn explicit_owners_group_all_findings_and_do_not_spawn_planner(){
        let root=temp();let mut job=job(json!([
            {"id":"A","owner_task_id":"12","summary":"Voice bug"},
            {"id":"B","ownerTaskId":"12","summary":"Voice tests"},
            {"id":"C","ownerTaskId":"13","summary":"Button behavior"}]),true);
        let events=route_review_ownership(&graph(),&root.join("stores"),&mut job).unwrap();
        assert_eq!(events.len(),2);
        assert_eq!(job["review"]["revisionDisposition"],"targeted");
        assert_eq!(job["reviewRevisionRequests"].as_array().unwrap().len(),2);
        assert_eq!(job["tasks"].as_array().unwrap().len(),5);
        assert_eq!(job["reviewRevisionRequests"][0]["findings"].as_array().unwrap().len(),2);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn mixed_ownership_routes_known_tasks_and_planner_only_for_unowned(){
        let root=temp();
        let mut job=job(json!([
            {"id":"F-1","ownerTaskId":"12","summary":"Voice bug"},
            {"id":"F-2","summary":"New security subsystem"}
        ]),true);
        let decisions=route_review_ownership(&graph(),&root.join("stores"),&mut job).unwrap();
        assert_eq!(decisions.len(),1);
        assert_eq!(job["tasks"].as_array().unwrap().len(),4);
        assert_eq!(job["review"]["revisionDisposition"],"needs-ownership");
        assert_eq!(job["review"]["ownershipTriage"]["unresolved"].as_array().unwrap().len(),1);
        assert_eq!(job["reviewRevisionRequests"][0]["originalTaskId"],"12");
        assert!(crate::review_replan::review_needs_replan(&job),
            "unowned finding still requires Planner after owned Revision created");
        assert!(route_review_ownership(&graph(),&root.join("stores"),&mut job).unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn exact_file_scope_can_attribute_one_of_several_implementation_tasks(){
        let job=job(json!([{"id":"F-1","summary":"button alignment","files":["src/button.swift"]}]),true);
        let assessment=ownership_assessment(&job).unwrap();
        assert_eq!(assessment["assigned"]["13"][0]["id"],"F-1");
        assert_eq!(assessment["allOwned"],true);
    }
    #[test]
    fn unknown_or_spoofed_ownership_falls_back_to_planner_without_revision(){
        let root=temp();
        let mut candidate=job(json!([{"id":"F-1","summary":"new security module"}]),true);
        let before=candidate["tasks"].as_array().unwrap().len();
        assert!(route_review_ownership(&graph(),&root.join("stores"),&mut candidate).unwrap().is_empty());
        assert_eq!(candidate["review"]["revisionDisposition"],"needs-ownership");
        assert_eq!(candidate["tasks"].as_array().unwrap().len(),before);
        assert_eq!(candidate["review"]["ownershipTriage"]["unresolved"].as_array().unwrap().len(),1);
        assert!(crate::review_replan::review_needs_replan(&candidate),
            "unowned findings must go to the existing Planner");
        let invalid=job(json!([{"id":"F-1","summary":"wrong task","ownerTaskId":"999"}]),false);
        let owner=ownership_assessment(&invalid).unwrap();
        assert_eq!(owner["allOwned"],false,"explicit invalid owner must not fall back to single implementation");
        let mut missing_round=invalid.clone();missing_round["reviewRevisionRounds"]=json!([]);
        assert!(ownership_assessment(&missing_round).is_none());
        let mut stale=invalid.clone();stale["headSha"]=json!("newer-sha");
        assert!(ownership_assessment(&stale).is_none());
        fs::remove_dir_all(root).unwrap();
    }
}
