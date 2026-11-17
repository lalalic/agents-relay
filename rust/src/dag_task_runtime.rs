// Node provenance: src/dag-task-runtime.ts. Every DAG node is a normal
// durable Task; this is a reconciliation projection, NOT a second scheduler.
// The canonical Task Graph owns claims, starts, dependencies and completions.
use crate::{
    agent_graph::{parse_agent_graph,AgentGraph},
    agent_script_discovery::discover_script_agent,
    job_task_id_sequence::allocate_entity_id,
    local_merge_lock::iso8601_now,
    task_transitions::try_transition_task_event,
    workflow::entity_creation::create_task_entity,
};
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use std::{collections::HashSet,fs,path::{Path,PathBuf}};

fn field<'a>(v:&'a Value,key:&str)->&'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn tasks(job:&Value)->&[Value]{
    job.get("tasks").and_then(Value::as_array)
        .map(Vec::as_slice).unwrap_or(&[])
}
pub fn unified_dag(_job:&Value,task:&Value)->bool{
    task.get("agentGraph").and_then(Value::as_str)
        .is_some_and(|v|!v.is_empty())
}
pub fn dag_coordinator(task:&Value)->bool{
    unified_dag(&Value::Null,task)
        &&task.pointer("/result/data/dag/version").and_then(Value::as_u64)==Some(1)
}
pub fn graph_sha(source:&str)->String{
    format!("{:x}",Sha256::digest(source.as_bytes()))
}
pub fn graph_node_output(task:&Value)->Option<Value>{
    if field(task,"state")!="SUCCEEDED"{return None;}
    let data=task.pointer("/result/data");
    if data.is_some_and(|d|field(d,"status")=="COMPLETED"
        &&d.get("output").is_some_and(Value::is_object)){
        return data.and_then(|d|d.get("output")).cloned();
    }
    let path=task.pointer("/output/path").and_then(Value::as_str)?;
    if task.pointer("/output/kind").and_then(Value::as_str)!=Some("file"){return None;}
    let parsed=serde_json::from_str::<Value>(&fs::read_to_string(path).ok()?).ok()?;
    if field(&parsed,"status")=="COMPLETED" &&parsed.get("output").is_some_and(Value::is_object){
        parsed.get("output").cloned()
    }else{None}
}
fn child<'a>(job:&'a Value,parent:&str,node:&str,sha:&str)->Option<&'a Value>{
    tasks(job).iter().find(|t|
        t.pointer("/dagNode/parentTaskId").and_then(Value::as_str)==Some(parent)
        &&t.pointer("/dagNode/nodeId").and_then(Value::as_str)==Some(node)
        &&t.pointer("/dagNode/graphHash").and_then(Value::as_str)==Some(sha))
}
fn start_parent(graph_dir:&Path,job:&mut Value,id:&str,sha:&str)->Result<(),String>{
    let Some(index)=tasks(job).iter().position(|t|field(t,"id")==id)
        else{return Ok(());};
    if field(job,"state")!="ACTIVE" ||job.get("pause").is_some_and(|v|!v.is_null())
        ||field(&job["tasks"][index],"state")!="QUEUED"
        ||!unified_dag(job,&job["tasks"][index]){return Ok(());}
    let now=iso8601_now();
    let parent=&mut job["tasks"][index];
    let changed=try_transition_task_event(graph_dir,parent,"task.started",
        &json!({}),&now)?;
    if changed.get("accepted")!=Some(&Value::Bool(true))
        ||field(&changed,"target")!="RUNNING"{
        return Err("Task lifecycle rejected DAG coordinator start".into());
    }
    parent["title"]=json!("Coordinator");
    parent["result"]=json!({
        "summary":"DAG coordinator",
        "data":{"dag":{"version":1,"graphHash":sha}}
    });
    parent["updatedAt"]=json!(now);
    Ok(())
}
fn result_directory(task:&Value,job_id:&str,project:&Path)->Result<PathBuf,String>{
    if task.pointer("/output/kind").and_then(Value::as_str)==Some("file"){
        let output=task.pointer("/output/path").and_then(Value::as_str).unwrap_or("");
        if Path::new(output).is_absolute(){
            return Path::new(output).parent().map(Path::to_path_buf)
                .ok_or("Graph Task output missing parent".into());
        }
    }
    Ok(project.join(".relay-dag-results").join(job_id).join(field(task,"id")))
}
fn graph_input(parent:&Value,job_id:&str,id:&str,node_id:&str,
    agent:&str,project:&Path,output_path:&Path,
    predecessor_outputs:&Value,
)->Value{
    let mut input=serde_json::from_str::<Value>(field(parent,"input"))
        .ok().filter(Value::is_object)
        .unwrap_or_else(||json!({"taskInput":field(parent,"input")}));
    if let Some(map)=input.as_object_mut(){
        for key in ["reviewDecision","interactiveInvocation","jobId","taskId","projectPath"]{
            map.remove(key);
        }
    }
    input["source"]=json!("relay-dag-task");
    input["jobId"]=json!(job_id);
    input["taskId"]=json!(id);
    input["parentTaskId"]=parent.get("id").cloned().unwrap_or(Value::Null);
    input["nodeId"]=json!(node_id);
    input["agent"]=json!(agent);
    input["projectPath"]=json!(project.to_string_lossy());
    input["predecessorOutputs"]=predecessor_outputs.clone();
    input["taskInput"]=parent.get("input").cloned().unwrap_or(Value::Null);
    input["outputPath"]=json!(output_path.to_string_lossy());
    input["requiredResult"]=json!({"status":"COMPLETED","output":{},"artifacts":[]});
    input["instruction"]=json!("Execute this Agent DAG role using only declared predecessorOutputs and authorized project inputs. Write the structured result to outputPath. Do not invent source evidence, review decisions or publishing authorization.");
    input
}
fn graph_done(job:&Value,parent:&str,sha:&str,graph:&AgentGraph)->bool{
    !graph.nodes.is_empty()
        &&graph.nodes.iter().all(|(node,_)|child(job,parent,node,sha)
            .is_some_and(|c|field(c,"state")=="SUCCEEDED"))
}
fn complete_parent(graph_dir:&Path,job:&mut Value,parent:&str,
    sha:&str,graph:&AgentGraph)->Result<(),String>{
    if !graph_done(job,parent,sha,graph){return Ok(());}
    let index=tasks(job).iter().position(|t|field(t,"id")==parent)
        .ok_or("DAG Coordinator Task vanished")?;
    if field(&job["tasks"][index],"state")!="RUNNING"
        ||!dag_coordinator(&job["tasks"][index]){return Ok(());}
    let mut children=serde_json::Map::new();
    for (node,_) in &graph.nodes{
        if let Some(task)=child(job,parent,node,sha){
            children.insert(node.clone(),task.get("id").cloned().unwrap_or(Value::Null));
        }
    }
    let now=iso8601_now();
    let task=&mut job["tasks"][index];
    let decision=try_transition_task_event(graph_dir,task,"task.completed",
        &json!({}),&now)?;
    if decision.get("accepted")!=Some(&Value::Bool(true))
        ||field(&decision,"target")!="SUCCEEDED"{
        return Err("Task Lifecycle rejected DAG completion".into());
    }
    task["result"]=json!({"summary":"DAG completed","data":{
        "dag":{"version":1,"graphHash":sha},"nodes":children
    }});
    task["updatedAt"]=json!(now);
    Ok(())
}
/// One reconciliation pass on a snapshot protected by a concurrent
/// SQLite generation check. All mutations must be committed through the
/// authoritative Store; they do not independently reserve DAG leases.
pub fn reconcile_dag_tasks<Script>(
    graph_dir:&Path,store_dir:&Path,job:&Value,
    project:&Path,roots:&Value,
    mut is_script:Script,
)->Result<Value,String>
where Script:FnMut(&str,&Path,&Value)->Result<bool,String>{
    let mut current=job.clone();
    let parents:Vec<Value>=tasks(job).iter().filter(|task|
        unified_dag(job,task)
            &&!matches!(field(task,"state"),"SUCCEEDED"|"CANCELLED"|"FAILED"|"BLOCKED"))
        .cloned().collect();
    for parent in parents{
        let parent_id=field(&parent,"id").to_string();
        let graph_text=field(&parent,"agentGraph");
        let graph=parse_agent_graph(graph_text)?;
        let sha=graph_sha(graph_text);
        if field(&parent,"state")=="QUEUED"{
            start_parent(graph_dir,&mut current,&parent_id,&sha)?;
        }
        let Some(actual)=tasks(&current).iter().find(|t|field(t,"id")==parent_id)
            .cloned() else{continue;};
        if field(&actual,"state")!="RUNNING"||!dag_coordinator(&actual){continue;}
        if actual.pointer("/result/data/dag/graphHash").and_then(Value::as_str)
            !=Some(sha.as_str()){
            return Err("DAG changed after execution began".into());
        }
        let root=result_directory(&parent,field(job,"id"),project)?;
        for wave in &graph.waves{
            for node_id in wave {
                if child(&current,&parent_id,node_id,&sha).is_some(){continue;}
                let parents=graph.edges.iter().filter(|(_,to)|to==node_id)
                    .map(|(from,_)|from).cloned().collect::<Vec<_>>();
                let incoming=parents.iter().map(|id|child(&current,&parent_id,id,&sha))
                    .collect::<Vec<_>>();
                if incoming.iter().any(|task|
                    task.is_none_or(|t|field(t,"state")!="SUCCEEDED")){continue;}
                let mut outputs=serde_json::Map::new();
                for (index,node) in parents.iter().enumerate(){
                    let task=incoming[index].expect("predecessor checked");
                    let result=graph_node_output(task).ok_or_else(||format!(
                        "Completed DAG dependency {node} has no structured result"))?;
                    outputs.insert(node.clone(),result);
                }
                let agent=graph.nodes.iter().find(|(id,_)|id==node_id)
                    .map(|(_,agent)|agent.as_str()).ok_or("DAG node missing")?;
                let script=is_script(agent,project,roots)?;
                let id=allocate_entity_id(store_dir,field(&current,"repository"),
                    "task",Some(&format!("dag:{}:{parent_id}:{sha}:{node_id}",
                    field(job,"id"))),&HashSet::new())?;
                let output_path=root.join(".dag-node-results").join(format!("{id}.json"));
                fs::create_dir_all(output_path.parent()
                    .ok_or("DAG output missing parent")?).map_err(|e|e.to_string())?;
                let input=graph_input(&parent,field(job,"id"),&id,node_id,
                    agent,project,&output_path,&Value::Object(outputs));
                let now=iso8601_now();
                let deps:Vec<Value>=incoming.iter().filter_map(|task|
                    task.and_then(|t|t.get("id").cloned())).collect();
                let fields=json!({
                    "jobId":job.get("id"),"id":id,"parentTaskId":parent_id,
                    "dagNode":{"parentTaskId":parent_id,"nodeId":node_id,
                        "graphHash":sha,"executor":if script{"script"}else{"model"}},
                    "title":agent,"kind":"work","agentName":agent,
                    "dependencies":deps,
                    "capabilities":if script{vec!["script"]}else{vec!["model"]},
                    "adapter":if script{"script"}else{"codex"},
                    "workerRequirements":if script{Value::Null}else{json!({"capabilities":["model"]})},
                    "input":input.to_string(),
                    "output":{"kind":"file","path":output_path.to_string_lossy()},
                    "attempt":0,"maxAttempts":3,
                    "leaseOwner":null,"leaseExpiresAt":null,
                    "executionId":null,"threadId":null,"result":null,"error":null,
                    "timeoutMs":5_400_000,"createdAt":now,"updatedAt":now
                });
                if child(&current,&parent_id,node_id,&sha).is_some(){continue;}
                let child=create_task_entity(graph_dir,&current,&fields,false,&now)?;
                current.get_mut("tasks").and_then(Value::as_array_mut)
                    .ok_or("Job Task array missing")?.push(child);
            }
        }
        complete_parent(graph_dir,&mut current,&parent_id,&sha,&graph)?;
    }
    Ok(current)
}
/// Human Request Changes routes the same durable Script Task back to its
/// Model Worker. No duplicate revision Task or parallel recovery chain.
pub fn select_dag_review_executors(job:&Value)->Result<Value,String>{
    let mut current=job.clone();
    if field(&current,"state")!="ACTIVE"
        ||current.get("pause").is_some_and(|v|!v.is_null()){
        return Ok(current);
    }
    for task in current.get_mut("tasks").and_then(Value::as_array_mut)
        .into_iter().flatten(){
        if task.pointer("/dagNode/executor").and_then(Value::as_str)!=Some("script")
            ||field(task,"state")!="QUEUED"
            ||task.get("executionId").is_some_and(|v|!v.is_null()){continue;}
        let status=task.pointer("/interactiveInvocation/status")
            .and_then(Value::as_str).unwrap_or("");
        let desired=if status=="changes_requested"{"codex"}else{"script"};
        if field(task,"adapter")==desired{continue;}
        task["adapter"]=json!(desired);
        task["capabilities"]=json!(if desired=="codex"{"model"}else{"script"});
        if desired=="codex" {
            task["workerRequirements"]=json!({"capabilities":["model"]});
        }else if let Some(map)=task.as_object_mut(){map.remove("workerRequirements");}
        for key in ["routing","workerSelection"]{
            if let Some(map)=task.as_object_mut(){map.remove(key);}
        }
        if status=="changes_requested"{
            let mut input=serde_json::from_str::<Value>(field(task,"input"))
                .map_err(|e|e.to_string())?;
            input["reviewRevision"]=json!({
                "status":"changes_requested",
                "feedback":task.pointer("/interactiveInvocation/feedback"),
                "comments":task.pointer("/interactiveInvocation/comments"),
                "instruction":"Revise the current Stage Artifact from the human feedback. Verify it, then use agents-relay review interactive --path to submit a NEW review for this same Task Execution. Do not publish or emit task.completed until the new review is approved."
            });
            task["input"]=json!(input.to_string());
        }
        task["updatedAt"]=json!(iso8601_now());
    }
    Ok(current)
}
pub fn reconcile_dag_schedule<Script>(
    graph_dir:&Path,store_dir:&Path,job:&Value,
    project:&Path,roots:&Value,is_script:Script,
)->Result<Value,String>
where Script:FnMut(&str,&Path,&Value)->Result<bool,String>{
    if !tasks(job).iter().any(|task|unified_dag(job,task)){
        return Ok(job.clone());
    }
    let reconciled=reconcile_dag_tasks(graph_dir,store_dir,job,
        project,roots,is_script)?;
    select_dag_review_executors(&reconciled)
}
/// The default discovery adapter owns the model vs source-owned Shortcut
/// distinction, but does not launch either worker during reconciliation.
pub fn discover_dag_script(agent:&str,project:&Path,roots:&Value)
    ->Result<bool,String>{
    let project=project.to_string_lossy();
    Ok(discover_script_agent(agent,&project,
        roots.get("sharedRoot").and_then(Value::as_str),
        roots.get("workspaceRoot").and_then(Value::as_str),
        roots.get("globalRoot").and_then(Value::as_str))?.is_some())
}
