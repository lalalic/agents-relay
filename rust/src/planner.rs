// Node provenance: src/planner.ts. Objective Planner results, immutable Plan
// rounds and task-resolution validation. Graph policies stay authoritative.
// Owned Planner execution is an explicit adapter. Script Planner and installed
// daemon tests verify actual Graph/SQLite commit; process exit alone is not a Plan.
use crate::{
    agent_graph::parse_agent_graph,
    dependency_validity::validate_dependency_validity,
    final_review_role::is_final_review_agent,
    local_merge_lock::iso8601_now,
    planner_history_cleanup::parse_planner_history_cleanup,
    planner_task_context::planner_task_context,
    workflow::{
        entity_creation::create_task_entity,
        planner_trigger_v2::decide_planner_trigger,
        task_resolution::unresolved_task,
    },
};
pub use crate::planner_adapters::{planning_spec,CommandObjectivePlanner,AgentObjectivePlanner,build_planner_execution_prompt};
use regex::Regex;
use serde_json::{json,Value};
use std::{collections::{HashMap,HashSet},path::Path};

fn field<'a>(v:&'a Value,key:&str)->&'a str{
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn arr<'a>(v:&'a Value,key:&str)->&'a [Value]{
    v.get(key).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}
fn required_text<'a>(v:&'a Value,key:&str,context:&str)
    ->Result<&'a str,String>{
    let Some(s)=v.get(key).and_then(Value::as_str)
        .filter(|s|!s.is_empty())else{
        return Err(format!("Planner {context}.{key} is required"));
    };
    Ok(s)
}
fn task_title(task:&Value,index:usize)->Result<String,String>{
    let text=required_text(task,"title",
        &format!("next_tasks[{index}]"))?.trim();
    if text.is_empty()||text.encode_utf16().count()>120{
        return Err(format!("Planner next_tasks[{index}].title must be 1-120 chars"));
    }
    Ok(text.into())
}
pub fn semantic_task_tree(tasks:&[Value])->Value{
    let work=tasks.iter().filter(|task|field(task,"kind")!="planner")
        .collect::<Vec<_>>();
    let ids:HashSet<String>=work.iter().map(|task|field(task,"id").into()).collect();
    let roots:Vec<Value>=work.iter().filter(|task|{
        field(task,"parentTaskId").is_empty()
            ||!ids.contains(field(task,"parentTaskId"))
    }).map(|task|task.get("id").cloned().unwrap_or(Value::Null)).collect();
    let tree=work.iter().map(|task|{
        let mut projected=json!({
            "id":task.get("id"),"title":task.get("title"),
            "parent_task_id":task.get("parentTaskId"),
            "state":task.get("state"),
            "dependencies":task.get("dependencies").cloned().unwrap_or(json!([])),
        });
        for (from,to) in [
            ("planningDecisionId","planning_decision_id"),
            ("planningRound","planning_round"),("review","review"),
            ("resolutionClassification","resolution_classification")
        ]{
            if let Some(value)=task.get(from){projected[to]=value.clone();}
        }
        projected
    }).collect::<Vec<_>>();
    json!({"roots":roots,"tasks":tree})
}
pub fn planner_round_number(task:&Value)->Option<i64>{
    if field(task,"kind")!="planner"{return None;}
    if let Some(round)=task.get("planningRound").and_then(Value::as_i64)
        .filter(|n|*n>0){return Some(round);}
    let caps=Regex::new(r"^(?:plan|planner)-(\d+)$")
        .expect("planner round regex").captures(field(task,"id"))?;
    caps.get(1).and_then(|m|m.as_str().parse::<i64>().ok())
}
pub fn pending_plan(job:&Value)->Option<Value>{
    arr(job,"plans").iter().filter(|p|field(p,"status")=="PLANNING")
        .min_by_key(|p|p.get("round").and_then(Value::as_i64).unwrap_or(0))
        .cloned()
}
pub fn planner_trigger(
    job:&Value,manual:bool,graph_directory:&Path,
)->Result<Value,String>{
    let consumed:HashSet<String>=arr(job,"plans").iter()
        .filter(|p|field(p,"status")=="SUCCEEDED"
            &&p.pointer("/trigger/source").and_then(Value::as_str)
                ==Some("unblock"))
        .flat_map(|p|p.pointer("/trigger/taskIds").and_then(Value::as_array)
            .into_iter().flatten().filter_map(Value::as_str)
            .map(str::to_owned)).collect();
    let unblocked=arr(job,"tasks").iter().filter(|task|
        matches!(field(task,"state"),"DRAFT"|"QUEUED")
            &&task.get("unblock").is_some_and(|v|!v.is_null())
            &&!consumed.contains(field(task,"id"))).collect::<Vec<_>>();
    let cycle=job.get("changeCycle").filter(|v|!v.is_null()
        &&v.get("consumedByPlannerTaskId").is_none_or(Value::is_null));
    let has_unblock=!unblocked.is_empty()||cycle.is_some();
    let initial=arr(job,"plans").is_empty()
        &&!arr(job,"tasks").iter().any(|t|field(t,"kind")=="planner");
    let review_required=job.pointer("/review/outcome").and_then(Value::as_str)
        ==Some("changes_required");
    let decided=decide_planner_trigger(graph_directory,
        &json!({"manualPlan":manual&&!has_unblock,"hasUnblock":has_unblock,
            "initialPlan":initial,"reviewRequired":review_required}))?;
    if decided.get("accepted")!=Some(&Value::Bool(true)){
        return Err("Planner trigger graph rejected plan.requested".into());
    }
    let source=field(&decided,"target");
    match source{
        "manual"=>Ok(json!({"source":"manual"})),
        "initial"=>Ok(json!({"source":"initial"})),
        "review"=>Ok(json!({"source":"review",
            "reviewTaskId":job.pointer("/review/taskId"),
            "reason":"Final Review requested changes",
            "facts":["Address persisted Final Review findings."]})),
        "continuation"=>Ok(json!({"source":"continuation"})),
        "unblock"=>{
            if !unblocked.is_empty(){
                let records=unblocked.iter()
                    .filter_map(|t|t.get("unblock")).collect::<Vec<_>>();
                let ids=unblocked.iter().filter_map(|t|t.get("id"))
                    .cloned().collect::<Vec<_>>();
                let mut reasons=HashSet::new();
                let mut joined:Vec<String>=Vec::new();
                let mut heads=HashSet::new();
                let mut baseline:Vec<String>=Vec::new();
                let mut facts=HashSet::new();
                let mut all_facts=Vec::new();
                for rec in &records{
                    let reason=field(rec,"reason");
                    if reasons.insert(reason.to_string()){joined.push(reason.into());}
                    let head=rec.pointer("/baseline/headSha").and_then(Value::as_str)
                        .unwrap_or("");
                    if !head.is_empty()&&heads.insert(head.to_string()){
                        baseline.push(head.into());
                    }
                    if let Some(items)=rec.get("facts").and_then(Value::as_array){
                        for f in items.iter().filter_map(Value::as_str){
                            if facts.insert(f.to_owned()){all_facts.push(f.to_owned());}
                        }
                    }
                }
                let current=records.iter().filter_map(|r|r.get("currentHeadSha"))
                    .find(|v|v.as_str().is_some_and(|s|!s.is_empty()));
                Ok(json!({"source":"unblock","taskIds":ids,
                    "reason":joined.join("; "),"blockedHeadShas":baseline,
                    "currentHeadSha":current,
                    "unblockSource":records.first().and_then(|r|r.get("source")),
                    "facts":all_facts}))
            }else{
                let cycle=cycle.ok_or("Planner trigger graph selected unblock without unblock facts")?;
                Ok(json!({"source":"unblock",
                    "taskIds":cycle.get("taskIds"),"reason":cycle.get("reason"),
                    "facts":cycle.get("facts"),
                    "blockedHeadShas":cycle.get("baselineHeadShas"),
                    "currentHeadSha":cycle.get("currentHeadSha"),
                    "unblockSource":cycle.get("source")}))
            }
        },
        _=>Err(format!("Unknown Planner trigger Graph target {source}"))
    }
}
pub fn create_plan_round(
    directory:&Path,job:&Value,guidance:Option<&str>,manual:bool,
    timeout_ms:Option<u64>,now:Option<&str>,
)->Result<Value,String>{
    let mut plans=arr(job,"plans").to_vec();
    plans.sort_by_key(|p|p.get("round").and_then(Value::as_i64).unwrap_or(0));
    let legacy=arr(job,"tasks").iter().filter(|t|field(t,"kind")=="planner")
        .collect::<Vec<_>>();
    let mut used:HashSet<String>=arr(job,"tasks").iter().map(|t|field(t,"id").into()).collect();
    used.extend(plans.iter().map(|p|field(p,"id").into()));
    let max_round=plans.iter()
        .filter_map(|p|p.get("round").and_then(Value::as_i64))
        .chain(legacy.iter().filter_map(|t|planner_round_number(t)))
        .max().unwrap_or(0);
    let mut round=max_round.max(0)+1;
    while used.contains(&format!("plan-{round}")){round+=1;}
    let id=format!("plan-{round}");
    let preceding=plans.last().map(|p|field(p,"id"))
        .or_else(||legacy.iter().max_by_key(|t|field(t,"createdAt"))
            .map(|t|field(t,"id")));
    let trigger=planner_trigger(job,manual,directory)?;
    let now=now.map(str::to_owned).unwrap_or_else(iso8601_now);
    let mut result=json!({
        "jobId":job.get("id"),"id":id,"round":round,
        "source":"model-planner","previousPlanId":preceding,
        "trigger":trigger,"status":"PLANNING",
        "assessment":"Planning in progress.","generatedTaskIds":[],
        "headSha":trigger.get("currentHeadSha").filter(|v|!v.is_null())
            .or_else(||job.get("headSha")),
        "attempt":0,"maxAttempts":if manual{1}else{3},
        "executionId":null,
        "timeoutMs":timeout_ms.unwrap_or(900_000),
        "manualPlanning":manual,"createdAt":now,"updatedAt":now
    });
    // Role conversation belongs to the Job, not to one Plan execution.
    // Keep prior immutable round records; continue a valid Codex thread in
    // a new independently fenced Plan round.
    if let Some(previous)=plans.iter().rev().find(|p|
        crate::native_codex_thread::valid_thread_id(field(p,"threadId"))){
        result["threadId"]=previous["threadId"].clone();
    }
    if let Some(guidance)=guidance{result["guidance"]=json!(guidance);}
    // JSON.stringify omits undefined Node Plan fields rather than storing
    // JSON null. A missing initial Git HEAD must remain absent.
    if result["headSha"].is_null(){
        if let Some(map)=result.as_object_mut(){map.remove("headSha");}
    }
    Ok(result)
}
pub fn normalize_planner_priority(value:&Value,field:&str)
    ->Result<String,String>{
    let normalized=if let Some(n)=value.as_i64(){
        if (0..=3).contains(&n){format!("P{n}")}else{String::new()}
    }else if let Some(s)=value.as_str(){
        let s=s.trim().to_ascii_uppercase();
        if s.len()==1 && matches!(s.as_str(),"0"|"1"|"2"|"3"){
            format!("P{s}")
        }else{s}
    }else{String::new()};
    if !matches!(normalized.as_str(),"P0"|"P1"|"P2"|"P3"){
        return Err(format!("Planner {field} is invalid: {value}"));
    }
    Ok(normalized)
}
fn validate_optional_array(value:Option<&Value>,field:&str)
    ->Result<Vec<Value>,String>{
    let Some(value)=value else{return Ok(Vec::new());};
    let Some(values)=value.as_array() else{
        return Err(format!("Planner {field} must be an array"));
    };
    if values.iter().any(|v|!v.is_string()){
        return Err(format!("Planner {field} must contain strings"));
    }
    Ok(values.clone())
}
fn validate_resolution(value:Option<&Value>,field:&str)
    ->Result<Option<Value>,String>{
    let Some(proposal)=value.filter(|v|!v.is_null())else{return Ok(None);};
    if !proposal.is_object() ||
        !matches!(proposal.get("path").and_then(Value::as_str),
            Some("exact_original_retry"|"same_job_dependency"|
                "blocker_job_dependency"|"escalation_gate"|"cancel_supersede")){
        return Err(format!("Planner {field}.path is invalid"));
    }
    if let Some(mode)=proposal.get("mode").and_then(Value::as_str){
        if !matches!(mode,"merge"|"verified"){
            return Err(format!("Planner {field}.mode must be merge or verified"));
        }
    }
    Ok(Some(proposal.clone()))
}
pub fn parse_planner_result(value:&Value)->Result<Value,String>{
    if !value.is_object(){return Err("Planner result must be an object".into());}
    let status=field(value,"objective_status");
    if !matches!(status,"in_progress"|"satisfied"){
        return Err("Planner objective_status must be in_progress or satisfied".into());
    }
    let Some(assessment)=value.get("assessment").and_then(Value::as_str)
        else{return Err("Planner assessment must be a string".into());};
    let Some(specs)=value.get("next_tasks").and_then(Value::as_array)
        else{return Err("Planner next_tasks must be an array".into());};
    let mut ids:HashSet<String>=HashSet::new();
    let mut next=Vec::new();
    for (i,task) in specs.iter().enumerate(){
        if !task.is_object(){
            return Err(format!("Planner next_tasks[{i}] must be an object"));
        }
        let id=required_text(task,"id",&format!("next_tasks[{i}]"))?;
        if !ids.insert(id.into()){
            return Err(format!("Planner next_tasks contains duplicate id {id}"));
        }
        let input=required_text(task,"input",&format!("next_tasks[{i}]"))?;
        let deps=validate_optional_array(task.get("dependencies"),
            &format!("next_tasks[{i}].dependencies"))?;
        let names=deps.iter().filter_map(Value::as_str)
            .map(str::to_owned).collect::<Vec<_>>();
        let validity=validate_dependency_validity(&names,
            task.get("dependencyValidity").unwrap_or(&Value::Null),
            &format!("next_tasks[{i}].dependencyValidity"))?;
        let adapter=task.get("adapter").and_then(Value::as_str);
        if adapter.is_some_and(|s|!matches!(s,"codex")){
            return Err(format!("Planner next_tasks[{i}].adapter must be codex (use --profile neo for ChatGPT-backed execution) when provided"));
        }
        let output=task.get("output")
            .filter(|v|v.is_object()&&matches!(field(v,"kind"),"file"|"task_pr"))
            .ok_or_else(||format!("Planner next_tasks[{i}].output is required"))?;
        if field(output,"kind")=="file"&&field(output,"path").is_empty(){
            return Err(format!("Planner next_tasks[{i}].output.path is required for file output"));
        }
        let title=task_title(task,i)?;
        let priority=task.get("priority").map(|v|
            normalize_planner_priority(v,&format!("next_tasks[{i}].priority")))
            .transpose()?;
        let size=task.get("storySize").and_then(Value::as_str)
            .unwrap_or("M").to_ascii_uppercase();
        if !matches!(size.as_str(),"S"|"M"|"L"){
            return Err(format!("Planner next_tasks[{i}].storySize must be S, M, or L"));
        }
        let route=task.get("routing").filter(|v|!v.is_null());
        if let Some(route)=route{
            for key in ["provider","model","decidedBy","decidedAt"]{
                if field(route,key).is_empty(){
                    return Err(format!("Planner next_tasks[{i}].routing.{key} is required"));
                }
            }
        }
        if let Some(graph)=task.get("agentGraph").and_then(Value::as_str)
            .filter(|s|!s.is_empty()){
            parse_agent_graph(graph).map_err(|error|
                format!("Planner next_tasks[{i}].agentGraph is invalid: {error}"))?;
        }
        let attempts=task.get("maxAttempts").and_then(Value::as_i64).unwrap_or(3);
        if attempts<1{return Err(format!(
            "Planner next_tasks[{i}].maxAttempts is invalid"));}
        let timeout=task.get("timeoutMs").and_then(Value::as_i64)
            .unwrap_or(match size.as_str(){
                "S"=>300_000,"L"=>2_700_000,_=>900_000
            } * if route.is_some_and(|r|field(r,"reasoning")
                .eq_ignore_ascii_case("high")){2}else{1});
        if timeout<0{return Err(format!(
            "Planner next_tasks[{i}].timeoutMs is invalid"));}
        let resolution=validate_resolution(task.get("resolution"),
            &format!("next_tasks[{i}].resolution"))?;
        let mut normalized=task.clone();
        normalized["title"]=json!(title);
        normalized["input"]=json!(input);
        normalized["dependencies"]=json!(deps);
        normalized["capabilities"]=json!(validate_optional_array(
            task.get("capabilities"),"capabilities")?);
        normalized["dependencyValidity"]=json!(validity);
        normalized["storySize"]=json!(size);
        normalized["maxAttempts"]=json!(attempts);
        normalized["timeoutMs"]=json!(timeout);
        if let Some(priority)=priority{normalized["priority"]=json!(priority);}
        if let Some(resolution)=resolution{normalized["resolution"]=resolution;}
        next.push(normalized);
    }
    let raw_unblocks=value.get("unblocks").cloned().unwrap_or(json!([]));
    let unblocks=raw_unblocks.as_array()
        .ok_or("Planner unblocks must be an array when provided")?;
    let mut keys=HashSet::new();
    for (i,unblock) in unblocks.iter().enumerate(){
        let repository=field(unblock,"repository");
        if repository.is_empty()||repository.contains("..")
            ||!Regex::new(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")
                .unwrap().is_match(repository){
            return Err(format!("Planner unblocks[{i}].repository must be a local Git root identity"));
        }
        for key in ["jobId","taskId"]{
            if field(unblock,key).is_empty(){
                return Err(format!("Planner unblocks[{i}].{key} is required"));
            }
        }
        let pr=unblock.get("prNumber").and_then(Value::as_u64).unwrap_or(0);
        let mode=unblock.get("resolutionMode").and_then(Value::as_str);
        if mode.is_some_and(|v|!matches!(v,"merge"|"verified")){
            return Err(format!("Planner unblocks[{i}].resolutionMode must be merge or verified"));
        }
        let key=format!("{repository}#{pr}:{}:{}",field(unblock,"jobId"),field(unblock,"taskId"));
        if !keys.insert(key.clone()){
            return Err(format!("Planner unblocks contains duplicate dependent {key}"));
        }
    }
    // Node treats an absent history_cleanup as undefined (no cleanup), but
    // an explicitly supplied null is invalid. Do not conflate the two.
    let cleanup=match value.get("history_cleanup"){
        Some(value)=>parse_planner_history_cleanup(value)?,
        None=>None,
    };
    let mut result=json!({
        "objective_status":status,"assessment":assessment,
        "next_tasks":next,"unblocks":unblocks
    });
    if let Some(cleanup)=cleanup{result["history_cleanup"]=json!(cleanup);}
    Ok(result)
}
pub fn parse_planner_output(output:&str)->Result<Value,String>{
    let mut trimmed=output.trim();
    if let Some(body)=trimmed.strip_prefix("```json")
        .or_else(||trimmed.strip_prefix("```")){
        trimmed=body;
    }
    if let Some(body)=trimmed.trim().strip_suffix("```"){trimmed=body;}
    let parsed:Value=serde_json::from_str(trimmed.trim())
        .map_err(|e|e.to_string())?;
    parse_planner_result(&parsed)
}
pub fn validate_planner_progress(job:&Value,result:&Value)->Result<(),String>{
    if field(result,"objective_status")!="in_progress"
        ||!arr(result,"next_tasks").is_empty()
        ||!arr(result,"unblocks").is_empty(){return Ok(());}
    if arr(job,"tasks").iter().any(|t|
        is_final_review_agent(t.get("agentName").and_then(Value::as_str))
            &&field(t,"state")=="SUCCEEDED"){return Ok(());}
    let live=arr(job,"tasks").iter().any(|t|
        field(t,"kind")!="planner"&&!matches!(
            field(t,"state"),"SUCCEEDED"|"FAILED"|"CANCELLED"));
    if live{return Ok(());}
    Err("Planner returned in_progress with no executable tasks or unblocks while no live work remains; return satisfied when only Relay-owned review/merge/completion effects remain".into())
}
pub fn validate_planner_hierarchy(job:&Value,specs:&[Value])->Result<(),String>{
    let existing:HashMap<String,&Value>=arr(job,"tasks").iter()
        .map(|t|(field(t,"id").into(),t)).collect();
    let planned:HashMap<String,&Value>=specs.iter()
        .map(|t|(field(t,"id").into(),t)).collect();
    for spec in specs{
        let parent=field(spec,"parentTaskId");
        if parent.is_empty(){continue;}
        if parent==field(spec,"id"){
            return Err(format!("Planner next task {} cannot parent itself",field(spec,"id")));
        }
        if existing.get(parent).is_some_and(|t|field(t,"kind")=="planner"){
            return Err(format!("Planner next task {} cannot use planner round {parent} as parentTaskId",
                field(spec,"id")));
        }
        if !existing.contains_key(parent)&&!planned.contains_key(parent){
            return Err(format!("Planner next task {} references unknown parentTaskId {parent}",
                field(spec,"id")));
        }
    }
    for spec in specs{
        let mut seen=HashSet::from([field(spec,"id").to_owned()]);
        let mut parent=field(spec,"parentTaskId");
        while let Some(ancestor)=planned.get(parent){
            if !seen.insert(parent.to_owned()){
                return Err(format!("Planner next_tasks parentTaskId cycle includes {parent}"));
            }
            parent=field(ancestor,"parentTaskId");
        }
    }
    Ok(())
}
pub fn validate_planner_lifecycle_ownership(job:&Value,specs:&[Value])
    ->Result<(),String>{
    if job.pointer("/localMerge/sourceRef").is_none_or(Value::is_null){
        return Ok(());
    }
    let match_local=Regex::new(r"(?i)\blocal[ -]merge\b").unwrap();
    let match_job=Regex::new(r"(?i)\bjob\b.{0,80}\bcompleted\b|\bcompleted\b.{0,80}\bjob\b").unwrap();
    let match_pr=Regex::new(r"(?i)\b(?:external|github|projected)\b.{0,80}\bpr\b.{0,80}\bmerged\b|\bpr\b.{0,80}\bmerged\b").unwrap();
    let imperative=Regex::new(r"(?i)^\s*(?:perform|execute|complete|trigger|drive|merge|transition|finish|finalize)\b").unwrap();
    let publish=Regex::new(r"(?i)\b(?:publish|release|deploy)\b.{0,100}\b(?:package|npm|service|runtime|version)\b|\b(?:package|npm|service|runtime)\b.{0,100}\b(?:publish|release|deploy)\b").unwrap();
    for spec in specs{
        for clause in field(spec,"input").to_lowercase().split(|c|
            matches!(c,'.'|'!'|'?'|'\n')){
            let owns=imperative.is_match(clause);
            let count=[match_local.is_match(clause),match_job.is_match(clause),
                match_pr.is_match(clause)].into_iter().filter(|v|*v).count();
            if owns&&count>=2{
                return Err(format!("Planner next task {} attempts to own Graph lifecycle delivery; local merge, Job COMPLETED, and projected PR merge are Relay-owned effects and must not be worker Tasks",field(spec,"id")));
            }
            if publish.is_match(clause)&&
                (clause.trim_start().starts_with("publish ")
                    ||clause.trim_start().starts_with("release ")
                    ||clause.trim_start().starts_with("deploy ")){
                return Err(format!("Planner next task {} attempts to own Relay release delivery; package publication and service/runtime deployment are Relay-owned effects and must not be worker Tasks",field(spec,"id")));
            }
        }
    }
    Ok(())
}
pub fn validate_planner_resolution_materialization(
    job:&Value,specs:&[Value],
)->Result<(),String>{
    let unresolved=arr(job,"tasks").iter().filter(|task|
        unresolved_task(task)
            &&matches!(field(task,"state"),"FAILED"|"BLOCKED")
            &&task.get("resolutionClassification").is_none_or(Value::is_null))
        .collect::<Vec<_>>();
    if unresolved.is_empty(){return Ok(());}
    let resolved:HashSet<String>=specs.iter()
        .filter_map(|spec|spec.pointer("/resolution/targetTaskId")
            .and_then(Value::as_str)).map(str::to_owned).collect();
    let uncovered=unresolved.iter().filter(|task|
        !resolved.contains(field(task,"id"))
            &&!matches!(task.pointer("/resolution/state").and_then(Value::as_str),
                Some("active"|"waiting"))).map(|t|field(t,"id")).collect::<Vec<_>>();
    if !uncovered.is_empty()&&!specs.is_empty(){
        return Err(format!("Planner cannot create sibling replacement work while unresolved Task(s) lack a graph resolution: {}. Correct next_tasks by adding resolution: {{\"path\":\"same_job_dependency\",\"targetTaskId\":\"<unresolved original task id>\",\"rootCause\":\"<evidence>\",\"solution\":\"<how new task resolves original>\"}} to each relevant recovery Task. The targetTaskId must refer to the FAILED/BLOCKED original, not the new Task. Do not bypass this check or mark work satisfied without evidence.",uncovered.join(", ")));
    }
    Ok(())
}
pub fn materialize_planner_child(
    directory:&Path,job:&Value,plan:&Value,spec:&Value,context:&Value,
)->Result<Value,String>{
    // Node materializePlannerChild: a spec.resolution must target one
    // existing unresolved durable Task (planner.ts 'Planner resolution for
    // <id> must target one unresolved durable Task').
    if let Some(resolution)=spec.get("resolution").filter(|v|!v.is_null()){
        let target=resolution.get("targetTaskId").and_then(Value::as_str)
            .and_then(|id|job.get("tasks").and_then(Value::as_array)
                .and_then(|tasks|tasks.iter()
                    .find(|task|task.get("id").and_then(Value::as_str)==Some(id))));
        let unresolved=target.is_some_and(|task|{
            task.get("kind").and_then(Value::as_str)!=Some("planner")
                &&!matches!(task.get("state").and_then(Value::as_str),
                    Some("SUCCEEDED")|Some("CANCELLED"))
        });
        if !unresolved{
            let spec_id=spec.get("id").and_then(Value::as_str).unwrap_or("");
            return Err(format!(
                "Planner resolution for {spec_id} must target one unresolved durable Task"));
        }
    }
    let mut fields=spec.clone();
    fields["jobId"]=job.get("id").cloned().unwrap_or(Value::Null);
    fields["kind"]=json!("work");
    fields["planningRound"]=plan.get("round").cloned().unwrap_or(Value::Null);
    fields["planningDecisionId"]=plan.get("id").cloned().unwrap_or(Value::Null);
    if fields.get("priority").is_none_or(Value::is_null){
        fields["priority"]=job.get("priority").cloned().unwrap_or(json!("P2"));
    }
    if fields.get("adapter").is_none_or(Value::is_null){
        fields["adapter"]=json!("codex");
    }
    fields["attempt"]=json!(0);
    fields["maxAttempts"]=spec.get("maxAttempts").cloned().unwrap_or(json!(3));
    fields["executionId"]=Value::Null;
    fields["threadId"]=Value::Null;
    fields["result"]=Value::Null;
    fields["error"]=Value::Null;
    let now=iso8601_now();
    fields["createdAt"]=json!(now);
    fields["updatedAt"]=json!(now);
    let _=context; // Agent selection uses context resolver during full wiring
    create_task_entity(directory,job,&fields,false,&now)
}
// Original Node PlannerContext JSON wire. The CLI Plan Context command reads
// this exact public payload; omitting undefined JS fields is critical because
// Worker resumes must not pretend future or absent Planner facts were known.
pub fn planner_input(context:&Value)->String{
    use serde_json::Map;
    fn put(map:&mut Map<String,Value>,key:&str,value:Option<&Value>){
        if let Some(v)=value{map.insert(key.into(),v.clone());}
    }
    fn bounded(value:Option<&Value>,limit:usize)->Option<Value>{
        match value{
            Some(Value::String(raw)) if raw.encode_utf16().count()>limit=>{
                let code_units:Vec<u16>=raw.encode_utf16().collect();
                let head=String::from_utf16_lossy(&code_units[..limit]);
                Some(json!(format!("{head}\\n...[truncated {} chars]",
                    code_units.len()-limit).replace("\\n","\n")))
            },
            Some(other)=>Some(other.clone()),None=>None,
        }
    }
    let job=&context["job"];
    let tasks=arr(context,"tasks");
    let mut output=Map::new();
    put(&mut output,"objective",context.get("objective"));
    if let Some(execution)=context.get("planExecution").filter(|v|!v.is_null()){
        // The provided native path is version-pinned by the daemon. A manual
        // offline invocation without that binding uses the installed Rust CLI,
        // never a second Node implementation.
        let native_cli=context.get("nativeRustCli").and_then(Value::as_str)
            .filter(|v|Path::new(v).is_absolute())
            .unwrap_or("agents-relay");
        let path=serde_json::to_string(native_cli)
            .unwrap_or_else(|_|"\"agents-relay\"".into());
        output.insert("apply_cli".into(),json!(format!(
            "{path} plan apply --repo {} --id {} --plan-id {} --execution-id {} --file PATH",
            field(job,"repository"),field(job,"id"),field(execution,"planId"),
            field(execution,"executionId"))));
    }
    for (out,source) in [
        ("plan_execution","planExecution"),("retry_feedback","retryFeedback"),
        ("caller_prompt","guidance"),("previous_planner_task_id","previousPlannerTaskId"),
        ("plan_trigger","trigger")
    ]{put(&mut output,out,context.get(source));}
    output.insert("force_restate".into(),json!(context.get("forceRestate")==Some(&json!(true))));
    output.insert("restate_task_ids".into(),context.get("restateTaskIds")
        .filter(|value|!value.is_null()).cloned().unwrap_or(json!([])));
    put(&mut output,"legacy_change_cycle",job.get("changeCycle"));
    if let Some(review)=job.get("review").filter(|v|!v.is_null()){
        if context.pointer("/trigger/source").and_then(Value::as_str)==Some("review")
            ||field(review,"outcome")=="changes_required"{
            let mut feedback=Map::new();
            put(&mut feedback,"task_id",review.get("taskId"));
            put(&mut feedback,"head_sha",review.get("headSha"));
            let evidence=review.pointer("/evidence/data")
                .filter(|v|!v.is_null()).cloned().unwrap_or(json!({}));
            feedback.insert("findings".into(),bounded(Some(&json!(evidence.to_string())),6000)
                .unwrap_or(Value::Null));
            output.insert("review_feedback".into(),Value::Object(feedback));
        }
    }
    // Node omits parent_task_id entirely when Task.parentTaskId is undefined,
    // but retains an explicitly recorded null parent.
    let mut tree=semantic_task_tree(tasks);
    if let Some(entries)=tree.get_mut("tasks").and_then(Value::as_array_mut){
        for (tree_task,task) in entries.iter_mut().zip(tasks.iter().filter(|task|
            field(task,"kind")!="planner")){
            if task.get("parentTaskId").is_none(){
                tree_task.as_object_mut().expect("semantic Task object")
                    .remove("parent_task_id");
            }
            for (dest,source) in [("id","id"),("title","title"),("state","state")]{
                if task.get(source).is_none(){
                    tree_task.as_object_mut().expect("semantic Task object").remove(dest);
                }
            }
        }
    }
    output.insert("semantic_task_tree".into(),tree);
    let plans=arr(job,"plans").iter().map(|plan|{
        let mut mapped=Map::new();
        for (out,source) in [
            ("id","id"),("round","round"),("status","status"),
            ("source","source"),("previous_plan_id","previousPlanId"),
            ("trigger","trigger"),("objective_status","objectiveStatus"),
            ("generated_task_ids","generatedTaskIds")
        ]{put(&mut mapped,out,plan.get(source));}
        for (out,source,max) in [
            ("assessment","assessment",4000),("error","error",2000)
        ]{put(&mut mapped,out,bounded(plan.get(source),max).as_ref());}
        Value::Object(mapped)
    }).collect::<Vec<_>>();
    output.insert("plans".into(),json!(plans));
    if let Some(project)=context.pointer("/executionContext/project")
        .filter(|v|!v.is_null()){
        let mut mapped=Map::new();
        put(&mut mapped,"name",project.get("name"));
        put(&mut mapped,"path",project.get("path"));
        output.insert("project".into(),Value::Object(mapped));
    }
    let visible=context.pointer("/executionContext/agents").and_then(Value::as_array)
        .into_iter().flatten().map(|agent|{
            let mut mapped=Map::new();
            for key in ["name","capabilities"]{put(&mut mapped,key,agent.get(key));}
            put(&mut mapped,"description",bounded(agent.get("description"),1000).as_ref());
            put(&mut mapped,"boundaries",agent.get("restrictions"));
            put(&mut mapped,"runtime",agent.get("runtime"));
            Value::Object(mapped)
        }).collect::<Vec<_>>();
    output.insert("visible_agents".into(),json!(visible));
    let mapped=tasks.iter().map(|task|{
        let mut out=planner_task_context(task);
        if let Some(result)=task.get("plannerResult").filter(|v|!v.is_null()){
            let mut plan=Map::new();
            put(&mut plan,"objective_status",result.get("objective_status"));
            put(&mut plan,"assessment",bounded(result.get("assessment"),4000).as_ref());
            if let Some(specs)=result.get("next_tasks").and_then(Value::as_array){
                plan.insert("next_task_ids".into(),json!(specs.iter().map(|item|
                    item.get("id").cloned().unwrap_or(Value::Null)).collect::<Vec<_>>()));
            }
            out["planner_result"]=Value::Object(plan);
        }
        out
    }).collect::<Vec<_>>();
    output.insert("tasks".into(),json!(mapped));
    Value::Object(output).to_string()
}

pub fn build_planner_codex_args(store_dir:&Path,input:&str)->Vec<String>{
    build_planner_codex_resume_args(store_dir,input,None)
}
pub fn build_planner_codex_resume_args(_store_dir:&Path,input:&str,thread_id:Option<&str>)->Vec<String>{
    if let Some(id)=thread_id.filter(|id|
        crate::native_codex_thread::valid_thread_id(id)){
        return vec!["exec".into(),"--json".into(),"resume".into(),
            crate::codex_permissions::FULL_ACCESS_NO_APPROVALS.into(),
            id.into(),input.into()];
    }
    let mut args=crate::codex_permissions::exec_args(true);
    args.extend(["--".to_owned(),input.to_owned()]);
    args
}
pub fn parse_planner_agent_message(line:&str)->Option<String>{
    let value:Value=serde_json::from_str(line).ok()?;
    if field(&value,"type")=="item.completed"
        &&value.pointer("/item/type").and_then(Value::as_str)==Some("agent_message"){
        return value.pointer("/item/text").and_then(Value::as_str)
            .map(str::trim).filter(|s|!s.is_empty()).map(str::to_owned);
    }
    if field(&value,"type")=="event_msg"
        &&value.pointer("/payload/type").and_then(Value::as_str)==Some("task_complete"){
        return value.pointer("/payload/last_agent_message")
            .and_then(Value::as_str).map(str::trim).filter(|s|!s.is_empty())
            .map(str::to_owned);
    }
    None
}
/// The native Planner runtime consumes this response adapter. Source coding
/// migration does NOT launch Codex CLI; all invocations are deferred.
pub fn validate_planner_receipt(
    response:&str,plan_id:&str,execution_id:&str,
)->Result<Value,String>{
    let expected=format!("PLAN_APPLIED:{plan_id}:{execution_id}");
    if response.trim()!=expected{
        let kind=if response.starts_with("PLAN_APPLIED:"){"mismatched"}
            else{"missing"};
        let snippet=response.chars().take(200).collect::<String>();
        return Err(format!("Planner returned a {kind} PLAN_APPLIED receipt; must return only the matching PLAN_APPLIED receipt. Expected {expected}, received {}. Inspect durable Plan state before retrying; only PLAN_APPLY_VALIDATION_FAILED authorizes same-execution candidate correction.",
            if snippet.is_empty(){"(empty final message)"}else{&snippet}));
    }
    Ok(json!({"objective_status":"satisfied",
        "assessment":"Plan committed through the authorized CLI action.",
        "next_tasks":[],"unblocks":[],"cliApplied":true}))
}
