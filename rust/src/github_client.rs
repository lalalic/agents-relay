// Node provenance: src/github-client.ts. Read-only rate-limit telemetry
// and authenticated GitHub App/gh transports. Every CLI child is owned;
// no publish/deploy is performed during Phase1 migration.
use crate::{
    continuation::{run_delivery_owned_process,DeliveryProcessOptions},
    github_runtime_usage::{
        empty_github_runtime_rate_usage,observe_runtime_rate_limit,
        parse_github_cli_headers,runtime_rejection,
    },
    local_merge_lock::iso8601_now,
    events::random_uuid,
    owned_process::OwnedProcessManager,
};
use chrono::{DateTime,SecondsFormat,Utc};
use regex::Regex;
use serde_json::{json,Value};
use std::{
    collections::HashMap,
    fs::{self,OpenOptions},io::Write,
    time::{Duration,SystemTime},
};
fn field<'a>(v:&'a Value,key:&str)->&'a str{
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn now_millis()->i64{Utc::now().timestamp_millis()}
fn iso_at(timestamp:i64)->String{
    DateTime::<Utc>::from_timestamp_millis(timestamp)
        .map(|d|d.to_rfc3339_opts(SecondsFormat::Millis,true))
        .unwrap_or_default()
}
#[derive(Clone,Debug)]
pub struct GitHubAppAuthOptions {
    pub app_id:String,pub installation_id:String,pub private_key:String,
}
/// JWT signing is injected at the key-owner boundary. The signer must
/// produce an RS256 signature over the literal header.payload bytes;
/// private keys never enter provider diagnostics or worker prompts.
pub fn create_github_app_jwt<Sign,Base64>(
    options:&GitHubAppAuthOptions,now_seconds:i64,
    mut rs256_sign:Sign,base64_url:Base64,
)->Result<String,String>
where
    Sign:FnMut(&[u8],&str)->Result<Vec<u8>,String>,
    Base64:Fn(&[u8])->String,
{
    let header=base64_url(json!({"alg":"RS256","typ":"JWT"}).to_string().as_bytes());
    let payload=base64_url(json!({
        "iat":now_seconds-60,"exp":now_seconds+540,
        "iss":options.app_id
    }).to_string().as_bytes());
    let unsigned=format!("{header}.{payload}");
    let signature=rs256_sign(unsigned.as_bytes(),&options.private_key)?;
    Ok(format!("{unsigned}.{}",base64_url(&signature)))
}
fn request_context_ledger(counts:&mut HashMap<String,u64>,name:&str){
    *counts.entry(name.to_owned()).or_default()+=1;
}
#[derive(Clone,Debug)]
struct InstallationToken {value:String,expires_at:i64}
#[derive(Clone,Debug)]
struct CachedRateLimit {snapshot:Value,cached_at:i64}
pub struct GhApiClient {
    pub app_auth:Option<GitHubAppAuthOptions>,
    pub cooldown_until:i64,
    pub rate_limit_failures:u32,
    installation_token:Option<InstallationToken>,
    rate_limit_cache:Option<CachedRateLimit>,
    pub calls:HashMap<String,u64>,
    pub graphql_operations:HashMap<String,u64>,
    pub graphql_contexts:HashMap<String,u64>,
    pub runtime_rate_usage:Value,
    pub request_context:String,
}
impl GhApiClient {
    pub fn new(auth:Option<GitHubAppAuthOptions>)->Self{
        Self{app_auth:auth,cooldown_until:0,rate_limit_failures:0,
            installation_token:None,rate_limit_cache:None,
            calls:HashMap::new(),graphql_operations:HashMap::new(),
            graphql_contexts:HashMap::new(),
            runtime_rate_usage:empty_github_runtime_rate_usage(),
            request_context:"unscoped".into()}
    }
    pub fn with_request_context<R>(
        &mut self,name:&str,work:impl FnOnce(&mut Self)->R
    )->R{
        let previous=std::mem::replace(&mut self.request_context,name.to_owned());
        let result=work(self);
        self.request_context=previous;
        result
    }
    pub fn graphql_operation(query:&str)->&'static str{
        if Regex::new(r"mutation\s*\([^)]*\)\s*\{addComment\(")
            .unwrap().is_match(query){"comment.add"}
        else if query.contains("updateIssueComment("){"comment.update"}
        else if query.contains("deleteIssueComment("){"comment.delete"}
        else if query.contains("viewer {login")||query.contains("viewer { login"){"viewer.login"}
        else if query.contains("comments(first:100,after:$cursor)"){"pr.comments"}
        else if query.contains("comments(last:100)"){"pr.snapshot"}
        else if query.contains("headRefName")&&query.contains("headRefOid"){"pr.node"}
        else if query.contains("repository(owner:$owner,name:$name){id}"){"repository.id"}
        else if query.contains("pullRequests("){"repository.pull-requests"}
        else if query.trim_start().starts_with("mutation"){"mutation.other"}
        else{"query.other"}
    }
    pub fn rate_limit_status(&self)->Value{
        let limited=now_millis()<self.cooldown_until;
        json!({"limited":limited,
            "cooldownUntil":if limited{json!(iso_at(self.cooldown_until))}
                else{Value::Null},
            "calls":{
                "rest":self.calls.get("rest").copied().unwrap_or(0),
                "graphql":self.calls.get("graphql").copied().unwrap_or(0),
                "rateLimit":self.calls.get("rateLimit").copied().unwrap_or(0)
            },
            "graphql":{"operations":self.graphql_operations,
                "contexts":self.graphql_contexts},
            "runtimeRateUsage":self.runtime_rate_usage})
    }
    fn assert_available(&self)->Result<(),String>{
        if now_millis()<self.cooldown_until{
            return Err(format!("GitHub API cooldown active until {}",
                iso_at(self.cooldown_until)));
        }
        Ok(())
    }
    fn note_failure(&mut self,message:&str){
        if !Regex::new(r"(?i)rate limit|secondary rate|HTTP 429")
            .unwrap().is_match(message){return;}
        self.rate_limit_failures+=1;
        let factor=1u64<<(self.rate_limit_failures.saturating_sub(1)).min(4);
        self.cooldown_until=now_millis()+900_000i64.min(
            60_000i64.saturating_mul(factor as i64));
    }
    fn note_success(&mut self){
        if now_millis()>=self.cooldown_until{self.rate_limit_failures=0;}
    }
    /// A host-owned gh subprocess. For app-authenticated sessions caller
    /// provides a short-lived verified token; no credentials are invented.
    pub fn run_gh(
        &mut self,args:&[String],input:Option<&str>,
        access_token:Option<&str>,rate_limited:bool,include_headers:bool,
    )->Result<Value,String>{
        if rate_limited{self.assert_available()?;}
        let mut command:Vec<String>=if include_headers{
            let mut args=args.to_vec();
            args.insert(1,"--include".into());
            args
        }else{args.to_vec()};
        // gh --input supports a private file as well as stdin. A restricted
        // temporary file preserves Node's request-body semantics without
        // weakening the owned-process supervisor's stdin=deny contract.
        let input_file=if let Some(body)=input{
            let directory=std::env::temp_dir();
            let path=directory.join(format!("relay-gh-input-{}",random_uuid()));
            let mut options=OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)] {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file=options.open(&path).map_err(|e|e.to_string())?;
            file.write_all(body.as_bytes()).map_err(|e|e.to_string())?;
            if let Some(index)=command.iter().position(|arg|arg=="--input"){
                if command.get(index+1).is_some_and(|arg|arg=="-"){
                    command[index+1]=path.to_string_lossy().to_string();
                }
            }
            Some(path)
        }else{None};
        let refs=command.iter().map(String::as_str).collect::<Vec<_>>();
        let mut env:HashMap<String,String>=std::env::vars().collect();
        if let Some(token)=access_token{
            env.insert("GH_TOKEN".into(),token.into());
            env.insert("GITHUB_TOKEN".into(),token.into());
        }
        let mut last=Value::Null;
        for attempt in 0..2{
            let mut manager=OwnedProcessManager::default();
            let executed=run_delivery_owned_process(
                &mut manager,"gh",&refs,None,"github.api",
                DeliveryProcessOptions{
                    timeout:None,cancelled:None,supervisor_path:None,
                    environment:Some(&env),
                });
            if let Some(path)=input_file.as_ref(){let _=fs::remove_file(path);}
            let response=executed?;
            let mut parsed=parse_github_cli_headers(
                &response.stdout,include_headers);
            if response.code!=0{
                let message=if response.stderr.trim().is_empty(){
                    field(&parsed,"body").to_owned()
                }else{response.stderr.trim().to_owned()};
                parsed["stderr"]=json!(message);
            }
            if response.code!=0 ||!response.stderr.is_empty(){
                let message=parsed.get("stderr").and_then(Value::as_str)
                    .unwrap_or("gh CLI failed");
                if rate_limited{self.note_failure(message);}
            }else if rate_limited{self.note_success();}
            last=parsed;
            if response.code==0||attempt==1{break;}
        }
        Ok(last)
    }
    pub fn rate_limit_snapshot(
        &mut self,force:bool,token:Option<&str>,
    )->Result<Value,String>{
        let now=now_millis();
        if !force{
            if let Some(cache)=self.rate_limit_cache.as_ref(){
                if now-cache.cached_at<300_000{
                    return Ok(cache.snapshot.clone());
                }
                if now<self.cooldown_until{return Ok(cache.snapshot.clone());}
            }
        }
        request_context_ledger(&mut self.calls,"rateLimit");
        let response=self.run_gh(&[
            "api".into(),"rate_limit".into()],None,token,true,false)?;
        let data:Value=serde_json::from_str(field(&response,"body"))
            .map_err(|e|e.to_string())?;
        let mut resources=json!({});
        for name in ["core","graphql","search"]{
            let resource=&data["resources"][name];
            if ["limit","used","remaining","reset"].iter().all(|key|
                resource.get(*key).and_then(Value::as_f64)
                    .is_some_and(|v|v.is_finite())){
                resources[name]=resource.clone();
            }
        }
        let snapshot=json!({"observedAt":iso_at(now),"resources":resources});
        self.rate_limit_cache=Some(CachedRateLimit{
            snapshot:snapshot.clone(),cached_at:now
        });
        Ok(snapshot)
    }
    fn note_runtime_rate_limit(&mut self,channel:&str,transport:&Value)
        ->Result<(),String>{
        let observation=observe_runtime_rate_limit(channel,transport,&iso8601_now())?;
        let resource=field(&observation,"resource");
        self.runtime_rate_usage["resources"][resource]=observation.clone();
        self.runtime_rate_usage["rejection"]=runtime_rejection(&observation)?;
        Ok(())
    }
    pub fn request(
        &mut self,path:&str,method:&str,body:Option<&str>,
        token:Option<&str>,
    )->Result<Value,String>{
        self.assert_available()?;
        request_context_ledger(&mut self.calls,"rest");
        let mut args=vec!["api".into(),path.into()];
        if method!="GET"{args.extend(["--method".into(),method.into()]);}
        if body.is_some(){args.extend(["--input".into(),"-".into()]);}
        let response=self.run_gh(&args,body,token,true,true)?;
        self.note_runtime_rate_limit("rest",&response)?;
        if let Some(err)=response.get("stderr").and_then(Value::as_str){
            return Err(err.into());
        }
        let value=field(&response,"body");
        if value.trim().is_empty(){return Ok(Value::Null);}
        Ok(serde_json::from_str(value).unwrap_or(json!(value)))
    }
    pub fn graphql(
        &mut self,query:&str,variables:&Value,token:Option<&str>,
    )->Result<Value,String>{
        self.assert_available()?;
        request_context_ledger(&mut self.calls,"graphql");
        request_context_ledger(&mut self.graphql_operations,
            Self::graphql_operation(query));
        request_context_ledger(&mut self.graphql_contexts,&self.request_context);
        let body=json!({"query":query,"variables":variables}).to_string();
        let response=self.run_gh(&[
            "api".into(),"graphql".into(),"--input".into(),"-".into()],
            Some(&body),token,true,true)?;
        self.note_runtime_rate_limit("graphql",&response)?;
        if let Some(error)=response.get("stderr").and_then(Value::as_str){
            return Err(error.into());
        }
        let parsed:Value=serde_json::from_str(field(&response,"body"))
            .map_err(|e|e.to_string())?;
        if parsed.get("errors").and_then(Value::as_array)
            .is_some_and(|errors|!errors.is_empty()){
            let error=parsed["errors"].to_string();
            self.note_failure(&error);
            return Err(error);
        }
        Ok(parsed.get("data").cloned().unwrap_or(parsed))
    }
    pub fn local_login(&mut self)->Option<String>{
        let response=self.run_gh(&[
            "auth".into(),"status".into(),"--active".into(),
            "--json".into(),"hosts".into()],None,None,false,false).ok()?;
        let parsed:Value=serde_json::from_str(field(&response,"body")).ok()?;
        parsed.pointer("/hosts/github.com").and_then(Value::as_array)
            .into_iter().flatten().find(|host|{
                host.get("active")==Some(&Value::Bool(true))
                    &&field(host,"state")!="error"
                    &&host.get("error").and_then(Value::as_str).is_none()
            }).and_then(|host|host.get("login"))
            .and_then(Value::as_str).filter(|s|!s.is_empty())
            .map(str::to_owned)
    }
    pub fn current_login(&mut self,token:Option<&str>)->Result<String,String>{
        if self.app_auth.is_some(){
            let app=self.request("/app","GET",None,token)?;
            if let Some(slug)=app.get("slug").and_then(Value::as_str)
                .filter(|s|!s.is_empty()){
                return Ok(format!("{slug}[bot]"));
            }
            return Err("GitHub App identity lookup returned no slug".into());
        }
        if let Some(login)=self.local_login(){return Ok(login);}
        if let Ok(viewer)=self.graphql("query { viewer { login } }",&json!({}),token){
            if let Some(login)=viewer.pointer("/viewer/login")
                .and_then(Value::as_str).filter(|s|!s.is_empty()){
                return Ok(login.into());
            }
        }
        self.local_login().ok_or_else(||"gh authentication did not return a login".into())
    }
}
