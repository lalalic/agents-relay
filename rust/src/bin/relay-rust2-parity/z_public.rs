// Original z-adapter.ts and z-oauth.ts public API differential: Z worker
// execution-source identity, bounded task brief, short-lived credential
// bootstrap text, MCP endpoint validation, and the complete PKCE OAuth flow
// driven through an injected fetcher so both stacks observe identical HTTP
// traffic shapes (URL, method, content type, body keys) and identical
// success/error outcomes.
use agents_relay_rust2::adapters::WorkerAdapter as _;
use agents_relay_rust2::z_adapter::{
    z_bootstrap,z_execution_source,z_task_brief,z_terminal_recovery_request,
    z_worker_launch_request,ZAdapter,Z_ADAPTER_ID,Z_CAPABILITIES,
};
use agents_relay_rust2::z_oauth::{
    issue_z_worker_credential,z_worker_mcp_endpoint,OAuthResponse,
};
use serde_json::{json,Value};

pub fn invoke(request:&Value)->Option<Result<String,String>>{
    if request["op"]!="certZPublic"{return None;}
    Some((||{
        match request["method"].as_str().unwrap_or(""){
            "executionSource"=>match z_execution_source(
                request["prompt"].as_str().unwrap_or("")){
                Ok(source)=>Ok(json!({"ok":true,"source":source}).to_string()),
                Err(message)=>Ok(json!({"ok":false,"error":message}).to_string()),
            },
            "taskBrief"=>match z_task_brief(request["prompt"].as_str().unwrap_or("")){
                Ok(brief)=>Ok(json!({"ok":true,"brief":brief}).to_string()),
                Err(message)=>Ok(json!({"ok":false,"error":message}).to_string()),
            },
            "bootstrap"=>match z_bootstrap(
                request["accessToken"].as_str().unwrap_or(""),
                request["prompt"].as_str().unwrap_or(""),
                request["endpoint"].as_str()){
                Ok(text)=>Ok(json!({"ok":true,"text":text}).to_string()),
                Err(message)=>Ok(json!({"ok":false,"error":message}).to_string()),
            },
            "launchRequest"=>match z_worker_launch_request(
                request["prompt"].as_str().unwrap_or(""),
                &request["files"].as_array().map(|files|files.iter()
                    .filter_map(Value::as_str).map(str::to_string)
                    .collect::<Vec<String>>()).unwrap_or_default(),
                request["token"].as_str().unwrap_or(""),
                request["endpoint"].as_str(),
                request["executionId"].as_str().unwrap_or(""),
                request["timeoutMs"].as_u64().unwrap_or(0)){
                Ok(body)=>Ok(json!({"ok":true,"body":body}).to_string()),
                Err(message)=>Ok(json!({"ok":false,"error":message}).to_string()),
            },
            "terminalRecovery"=>match z_terminal_recovery_request(
                request["prompt"].as_str().unwrap_or(""),
                request["threadId"].as_str().unwrap_or(""),
                request["token"].as_str().unwrap_or(""),
                request["endpoint"].as_str().unwrap_or("")){
                Ok(body)=>Ok(json!({"ok":true,"body":body}).to_string()),
                Err(message)=>Ok(json!({"ok":false,"error":message}).to_string()),
            },
            "adapterIdentity"=>Ok(json!({
                "name":ZAdapter.name(),
                "id":ZAdapter.id(),
                "capabilities":ZAdapter.capabilities(),
                "adapterIdConstant":Z_ADAPTER_ID,
                "capabilitiesConstant":Z_CAPABILITIES,
            }).to_string()),
            "mcpEndpoint"=>match z_worker_mcp_endpoint(request["origin"].as_str()){
                Ok(endpoint)=>Ok(json!({"ok":true,"endpoint":endpoint}).to_string()),
                Err(message)=>Ok(json!({"ok":false,"error":message}).to_string()),
            },
            "issueCredential"=>issue_credential(request),
            other=>Err(format!("unknown certZPublic method {other}")),
        }
    })())
}

/// The fetcher closure runs inside the parity binary. It records every
/// request in a traffic-normalized form (path, method, sorted body keys,
/// content type) and answers from the fixture script, so the H2H suite can
/// compare the exact sequence of HTTP interactions against the Node run.
fn issue_credential(request:&Value)->Result<String,String>{
    let scenario=request["scenario"].as_str().unwrap_or("happy");
    let mut state_seed=request["stateSeed"].as_u64().unwrap_or(1) as u64;
    // Reset the per-call state echo so parallel parity calls stay isolated.
    LAST_STATE.with(|slot|*slot.borrow_mut()=String::new());
    let trace=std::sync::Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
    let trace_for_closure=std::sync::Arc::clone(&trace);
    let fetcher=move |url:&str,method:&str,body:Option<&str>,
        headers:&[(&str,&str)]|->Result<OAuthResponse,String>{
        let path=url.strip_prefix("https://oauth.test").unwrap_or(url);
        let normalized=json!({
            "path":path,
            "method":method,
            "contentType":headers.iter()
                .find(|(name,_)|name.eq_ignore_ascii_case("content-type"))
                .map(|(_,value)|value),
            "bodyKeys":body.map(form_keys),
        });
        trace_for_closure.lock().expect("z trace lock").push(normalized);
        // A stable PRNG stand-in for provider randomness so the redirect
        // state/rid values are reproducible for structural assertions.
        state_seed=state_seed.wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        fixture_response(scenario,path,body,state_seed)
    };
    let token_file=request["operatorTokenFile"].as_str()
        .map(std::path::Path::new);
    let outcome=issue_z_worker_credential(
        request["origin"].as_str(),
        request["operatorToken"].as_str(),
        token_file,
        fetcher);
    let trace=trace.lock().expect("z trace lock").clone();
    Ok(match outcome{
        Ok(token)=>json!({"ok":true,"token":token,"trace":trace}).to_string(),
        Err(message)=>json!({"ok":false,"error":message,"trace":trace}).to_string(),
    })
}

fn form_keys(body:&str)->Vec<String>{
    let mut keys:Vec<String>=body.split('&')
        .filter(|pair|!pair.is_empty())
        .map(|pair|pair.split('=').next().unwrap_or("").to_string())
        .collect();
    keys.sort();
    keys
}

/// Fixture provider mirroring the Node-side fake. Random verifier/state
/// values are per-stack, so the authorize step echoes back whatever state
/// the client sent (structural equality is asserted by the suite).
fn fixture_response(
    scenario:&str,path:&str,body:Option<&str>,seed:u64,
)->Result<OAuthResponse,String>{
    let redirect="http://127.0.0.1:8765/agents-relay/oauth/callback";
    let json_response=|status:u16,value:Value|OAuthResponse{
        status,body:value.to_string(),location:None};
    let redirect_response=|status:u16,location:String|OAuthResponse{
        status,body:String::new(),location:Some(location)};
    match path{
        "/register" if scenario=="register-reject"=>
            Ok(json_response(400,json!({"error":"registration denied"}))),
        "/register" if scenario=="no-client"=>
            Ok(json_response(201,json!({"client_name":"Agents Relay Z worker"}))),
        "/register" if scenario=="malformed-json"=>
            Ok(OAuthResponse{status:201,body:"not json".into(),location:None}),
        "/register"=>Ok(json_response(201,json!({"client_id":"client-fixture"}))),
        path if path.starts_with("/authorize?")=>{
            if scenario=="authorize-reject"{
                return Ok(json_response(403,json!({"error":"forbidden"})));
            }
            if scenario=="no-rid"{
                return Ok(OAuthResponse{status:200,
                    body:"<html><body>no form here</body></html>".into(),
                    location:None});
            }
            if scenario=="html-no-rid"{
                return Ok(OAuthResponse{status:200,
                    body:"<input name=\"other\" value=\"x\">".into(),
                    location:None});
            }
            if scenario=="bad-rid"{
                return Ok(OAuthResponse{status:200,
                    body:"<input name=\"rid\" value=\"bad rid!\">".into(),
                    location:None});
            }
            // Echo the caller's state back through the page so the approval
            // redirect can repeat it verbatim; remember it for /authorize.
            let state=query_param(path,"state").unwrap_or_default();
            LAST_STATE.with(|slot|*slot.borrow_mut()=state.clone());
            Ok(OAuthResponse{status:200,
                body:format!("<input name=\"rid\" value=\"rid-{seed:x}\">"),
                location:None})
        }
        "/authorize" if scenario=="consent-reject"=>
            Ok(json_response(200,json!({"error":"consent denied"}))),
        "/authorize" if scenario=="no-location"=>
            Ok(OAuthResponse{status:302,body:String::new(),location:None}),
        "/authorize" if scenario=="slow-consent"=>
            Ok(redirect_response(302,format!(
                "{redirect}?code=late&state=stale&iss=https%3A%2F%2Foauth.test"))),
        "/authorize" if scenario=="bad-redirect-host"=>
            Ok(redirect_response(302,
                "http://127.0.0.1:9999/agents-relay/oauth/callback?code=x"
                    .to_string())),
        "/authorize" if scenario=="bad-redirect-path"=>
            Ok(redirect_response(302,
                "http://127.0.0.1:8765/other/callback?code=x".to_string())),
        "/authorize" if scenario=="no-code"=>
            Ok(redirect_response(302,format!(
                "{redirect}?state={}&iss=https%3A%2F%2Foauth.test",
                last_state(body)))),
        "/authorize" if scenario=="no-iss"=>
            Ok(redirect_response(302,format!(
                "{redirect}?code=fixture-code&state={}",
                last_state(body)))),
        "/authorize" if scenario=="iss-mismatch"=>
            Ok(redirect_response(302,format!(
                "{redirect}?code=fixture-code&state={}&iss=https%3A%2F%2Fevil.test",
                last_state(body)))),
        "/authorize" if scenario=="state-mismatch"=>
            Ok(redirect_response(302,format!(
                "{redirect}?code=fixture-code&state=deadbeef&iss=https%3A%2F%2Foauth.test"))),
        "/authorize"=>Ok(redirect_response(302,format!(
            "{redirect}?code=fixture-code&state={}&iss=https%3A%2F%2Foauth.test",
            last_state(body)))),
        "/token" if scenario=="token-reject"=>
            Ok(json_response(500,json!({"error":"token denied"}))),
        "/token" if scenario=="expires"=>Ok(json_response(200,
            json!({"access_token":"worker-only","expires_in":1800}))),
        "/token" if scenario=="no-access-token"=>Ok(json_response(200,
            json!({"expires_in":3600}))),
        "/token" if scenario=="malformed-token"=>Ok(OAuthResponse{status:200,
            body:"not json".into(),location:None}),
        "/token" if scenario=="no-refresh"=>Ok(json_response(200,
            json!({"access_token":"worker-only","expires_in":3600}))),
        "/token" if scenario=="refresh"=>Ok(json_response(200,json!({
            "access_token":"worker-only","expires_in":3600,
            "refresh_token":"refresh-secret"}))),
        "/token"=>Ok(json_response(200,json!({
            "access_token":"worker-only","expires_in":3600,
            "refresh_token":"refresh-secret"}))),
        "/revoke" if scenario=="revoke-fails"=>
            Ok(json_response(400,json!({"error":"revocation denied"}))),
        "/revoke"=>Ok(json_response(200,json!({}))),
        other=>Err(format!("fixture saw unexpected path {other}")),
    }
}

/// The approval POST body carries the operator token, not the state; the
/// state was remembered from the authorize GET by rid linkage in the fixture.
fn last_state(_body:Option<&str>)->String{
    LAST_STATE.with(|slot|slot.borrow().clone())
}

thread_local!{
    static LAST_STATE:std::cell::RefCell<String>=
        const{std::cell::RefCell::new(String::new())};
}

fn query_param(path:&str,key:&str)->Option<String>{
    path.split('?').nth(1)?.split('&').find_map(|pair|{
        let mut split=pair.splitn(2,'=');
        if split.next()?==key{Some(split.next()?.to_string())}else{None}
    })
}
