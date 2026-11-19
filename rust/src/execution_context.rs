// Node provenance: src/execution-context.ts. Runtime invocation context,
// layered project/parent/shared/global instructions, visible skills/agents
// and selected Agent Markdown. Uses the already-portered native cli_context
// filesystem scanner; no Node subprocess or browser client code is changed.
use crate::{
    agent_content_resolver::{agent_source_layers,resolve_agent_markdown},
    cli_context::resolve_context,
};
use serde_json::{json,Value};
use std::{collections::HashSet,path::Path};

fn field<'a>(v:&'a Value,key:&str)->&'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn values<'a>(v:&'a Value,key:&str)->&'a [Value] {
    v.get(key).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}
fn strings(v:&Value,key:&str)->Vec<String> {
    values(v,key).iter().filter_map(Value::as_str)
        .map(str::to_owned).collect()
}
pub fn bundled_agents_root()->String {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent().expect("repo").join("skills/agents-relay/agents")
        .to_string_lossy().to_string()
}
fn select_by_name(
    items:&[Value],names:&[String],kind:&str,
)->Result<Vec<Value>,String>{
    if names.is_empty(){return Ok(items.to_vec());}
    names.iter().map(|name|{
        items.iter().find(|item|field(item,"name")==name)
            .cloned().ok_or_else(||format!(
                "Explicit {kind} {name} is not visible in the resolved execution context"))
    }).collect()
}
pub fn resolve_execution_context(
    project_path:&str,role:&str,options:&Value,
)->Result<Value,String>{
    if !matches!(role,"orchestrator"|"planner"|"reviewer"|"troubleshooter"
        |"worker"|"nested-worker"){
        return Err(format!("Unknown execution role {role}"));
    }
    let skills=strings(options,"explicitSkills");
    let agents=strings(options,"explicitAgents");
    // Selected registered Agents are merged below, so restricting built-in
    // discovery by explicitAgents here would incorrectly reject an Agent
    // registered only in SQLite. Apply that filter AFTER the merged list.
    let mut context=resolve_context(project_path,role,
        options.get("workspaceRoot").and_then(Value::as_str),
        options.get("globalRoot").and_then(Value::as_str),
        options.get("sharedRoot").and_then(Value::as_str),
        &skills,&[])?;
    let mut agent_map:Vec<Value>=values(&context,"agents").to_vec();
    let registered=values(options,"registeredAgents");
    for registration in registered{
        let id=field(registration,"name");
        if id.is_empty(){continue;}
        if !agent_map.iter().any(|a|field(a,"name")==id){
            let mut agent=json!({
                "name":id,"source":"registry",
                "capabilities":registration.get("capabilities")
                    .cloned().unwrap_or(json!([])),
                "trustDomains":registration.pointer("/routing/trustDomains")
                    .cloned().unwrap_or(json!([])),
                "delegation":[],"restrictions":registration.get("boundaries")
                    .cloned().unwrap_or(json!([])),
                "registration":registration
            });
            if let Some(description)=registration.get("responsibility"){
                agent["description"]=description.clone();
            }
            if let Some(runtime)=registration.pointer("/runtime/adapter"){
                agent["runtime"]=runtime.clone();
            }
            agent_map.push(agent);
        }else if let Some(existing)=agent_map.iter_mut().find(|a|
            field(a,"name")==id){
            existing["registration"]=registration.clone();
        }
    }
    agent_map.sort_by(|a,b|field(a,"name").cmp(field(b,"name")));
    context["agents"]=json!(select_by_name(&agent_map,&agents,"agent")?);
    let runtimes:Vec<Value>=values(options,"runtimes").iter().map(|r|{
        json!({"name":r.get("name").filter(|name|!name.is_null())
            .or_else(||r.get("adapter").filter(|name|!name.is_null()))
            .unwrap_or(&json!("unknown")),
            "id":r.get("id"),"capabilities":r.get("capabilities"),
            "source":"runtime"})
    }).collect();
    context["runtimes"]=json!(runtimes);
    if let Some(provider)=options.get("providerInstructions")
        .filter(|p|p.is_object()){
        context["providerInstructions"]=provider.clone();
    }
    Ok(context)
}
pub fn resolve_agent_model_preference(
    project_path:&str,agent_name:&str,options:&Value,
)->Result<Option<Value>,String>{
    let workspace=options.get("workspaceRoot").and_then(Value::as_str)
        .or_else(||None);
    let global=options.get("globalRoot").and_then(Value::as_str)
        .or_else(||None);
    let shared=options.get("sharedRoot").and_then(Value::as_str);
    let layers=agent_source_layers(project_path,&json!({
        "workspaceRoot":workspace,"globalRoot":global,"sharedRoot":shared
    }));
    let agent=resolve_agent_markdown(agent_name,&bundled_agents_root(),
        project_path,shared,Some(&layers))?;
    let model=agent.pointer("/metadata/model").and_then(Value::as_str)
        .filter(|s|!s.is_empty());
    let reasoning=agent.pointer("/metadata/reasoning").and_then(Value::as_str)
        .filter(|s|!s.is_empty());
    if model.is_none()&&reasoning.is_none(){return Ok(None);}
    let mut result=json!({});
    if let Some(model)=model{result["model"]=json!(model);}
    if let Some(reasoning)=reasoning{result["reasoning"]=json!(reasoning);}
    Ok(Some(result))
}
pub fn resolve_agent_contract(
    context:&Value,agent_name:&str,
)->Result<Value,String>{
    let agent=values(context,"agents").iter()
        .find(|agent|field(agent,"name")==agent_name)
        .ok_or_else(||format!(
            "Agent {agent_name} is not visible in the resolved execution context"))?;
    if field(agent,"path").is_empty(){
        return Err(format!("Agent {agent_name} has no readable Markdown contract"));
    }
    let project=field(&context["project"],"path");
    let shared=context.pointer("/project/sharedRoot").and_then(Value::as_str);
    let layers=agent_source_layers(project,&context["project"]);
    let resolved=resolve_agent_markdown(agent_name,&bundled_agents_root(),
        project,shared,Some(&layers))?;
    if field(&resolved,"content").trim().is_empty(){
        return Err(format!("Agent {agent_name} Markdown contract is empty"));
    }
    Ok(json!({
        "agent":agent,
        "definition":resolved.get("content"),
        "hash":resolved.get("hash"),
        "sources":resolved.get("sources")
    }))
}
pub fn agent_contract_prompt(context:&Value,agent_name:&str)
    ->Result<String,String>{
    let resolved=resolve_agent_contract(context,agent_name)?;
    let agent=&resolved["agent"];
    let sources=values(&resolved,"sources").iter()
        .filter_map(Value::as_str).collect::<Vec<_>>().join(" -> ");
    Ok(format!(
        "[Selected task agent contract]\nAgent: {}\nSource: {}\nContract layers: {sources}\n\nThe following Markdown is the authoritative behavioral contract for this Task agent.\nFollow it in addition to the shared Job/Task and events-bus contracts. Worker/model routing\ndoes not change the selected agent identity.\n\n--- BEGIN AGENT CONTRACT ---\n{}\n--- END AGENT CONTRACT ---",
        field(agent,"name"),
        agent.get("path").and_then(Value::as_str)
            .unwrap_or_else(||field(agent,"source")),
        field(&resolved,"definition").trim(),
    ))
}
pub fn execution_context_prompt(context:&Value)->String{
    let lines=|items:&[Value],f:&dyn Fn(&Value)->String|->String{
        let all=items.iter().map(f).collect::<Vec<_>>();
        if all.is_empty(){"- none".into()}else{all.join("\n")}
    };
    let instructions=lines(values(context,"instructions"),&|item|
        format!("- {} [{}]",field(item,"path"),field(item,"source")));
    let skills=lines(values(context,"skills"),&|item|
        format!("- {}: {} [{}]",field(item,"name"),
            field(item,"path"),field(item,"source")));
    let agents=lines(values(context,"agents"),&|item|{
        let mut pieces=Vec::new();
        if !field(item,"description").is_empty(){
            pieces.push(format!("purpose={}",field(item,"description")));
        }
        if !values(item,"capabilities").is_empty(){
            pieces.push(format!("capabilities={}",strings(item,"capabilities").join(",")));
        }
        if !field(item,"runtime").is_empty(){
            pieces.push(format!("runtime={}",field(item,"runtime")));
        }
        if !values(item,"trustDomains").is_empty(){
            pieces.push(format!("trust={}",strings(item,"trustDomains").join(",")));
        }
        if !values(item,"restrictions").is_empty(){
            pieces.push(format!("restrictions={}",strings(item,"restrictions").join(" | ")));
        }
        let name=field(item,"name");
        let path=field(item,"path");
        let details=if pieces.is_empty(){String::new()}
            else{format!(" — {}",pieces.join("; "))};
        format!("- {name}{} [{}]{details}",
            if path.is_empty(){String::new()}else{format!(": {path}")},
            field(item,"source"))
    });
    let runtimes=lines(values(context,"runtimes"),&|item|
        format!("- {}{}: {}",field(item,"name"),
            if field(item,"id").is_empty(){String::new()}
            else{format!(" ({})",field(item,"id"))},
            strings(item,"capabilities").join(",")));
    let role=field(context,"role");
    let delegation=if role=="troubleshooter"{
        "This is an orchestrator-side recovery role. Follow the selected Troubleshooter contract for P0/self-job repair authority and use durable Agents Relay Jobs/Tasks for delegated work."
    }else{
        "Nested work MUST be created as an Agents Relay durable child task with parentTaskId lineage. Do not directly spawn arbitrary child agents. Leaf workers do not inherit top-level XChat orchestration duties merely because xchat-orchestrator is visible."
    };
    format!(
        "[Resolved execution context]\nRole: {role}\nProject path: {}\n\nInstructions (read in listed order; later/project-local instructions override earlier shared defaults):\n{instructions}\n\nVisible skills (already de-duplicated with project-local > shared > global precedence):\n{skills}\n\nVisible agents (Relay built-in + Job context only; registered agents may supplement):\n{agents}\n\nRuntime capabilities:\n{runtimes}\n\nDelegation contract:\n{delegation}",
        context.pointer("/project/path").and_then(Value::as_str).unwrap_or(""))
}
