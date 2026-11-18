// Explicit GitHubApi side-effect mock; never performs any live network.
use agents_relay_rust2::{
 store_pull_request::resolve_pull_request,
 store_github::GitHubApi
};
use serde_json::{json,Value};
struct Mock {responses:Vec<Value>,calls:Vec<Value>}
impl Mock{
 fn new(responses:Vec<Value>)->Self{Self{responses,calls:Vec::new()}}
 fn pop(&mut self)->Result<Value,String>{
  if self.responses.is_empty(){return Err("fixture exhausted".into());}
  let result=self.responses.remove(0);
  if let Some(error)=result.get("error").and_then(Value::as_str){
   return Err(error.to_owned());
  }
  Ok(result)
 }
}
impl GitHubApi for Mock{
 fn graphql(&mut self,query:&str,variables:&Value)->Result<Value,String>{
  self.calls.push(json!({"kind":"graphql","query":query,"vars":variables}));
  self.pop()
 }
 fn request(&mut self,path:&str,method:&str,body:Option<&Value>)
  ->Result<Value,String>{
  self.calls.push(json!({"kind":"request","path":path,"method":method,"body":body}));
  self.pop()
 }
}
fn empty()->Value{json!({"repository":{"pullRequests":{"nodes":[]}}})}
fn pr()->Value{json!({"number":43,"title":"fixture","body":"",
 "state":"OPEN","headRefName":"feature","baseRefName":"main"})}
fn options()->Value{json!({"head":"feature","base":"main","title":"fixture"})}
#[test]
fn invalid_repo_and_missing_head_do_not_make_any_network_effect(){
 let mut client=Mock::new(vec![]);
 assert_eq!(resolve_pull_request(&mut client,"missing",&options()).unwrap_err(),
  "Invalid GitHub repository missing");
 assert_eq!(resolve_pull_request(&mut client,"test/repo",&json!({})).unwrap_err(),
  "--head is required when --pr is not provided");
 assert!(client.calls.is_empty());
}
#[test]
fn existing_pr_never_calls_write_transport(){
 let mut client=Mock::new(vec![json!({"repository":{"pullRequests":{
  "nodes":[pr()]}}})]);
 let output=resolve_pull_request(&mut client,"test/repo",&options()).unwrap();
 assert_eq!(output["number"],43);
 assert_eq!(client.calls.len(),1);
 assert_eq!(client.calls[0]["kind"],"graphql");
 assert!(client.calls[0]["query"].as_str().unwrap().starts_with("query"));
}
#[test]
fn create_failure_does_not_fabricate_a_successful_pr(){
 let mut client=Mock::new(vec![empty(),json!({"ahead_by":2}),
  json!({"repository":{"id":"repo-id"}}),
  json!({"error":"GitHub create blocked"}),
  empty()]);
 assert_eq!(resolve_pull_request(&mut client,"test/repo",&options()).unwrap_err(),
  "GitHub create blocked");
 assert_eq!(client.calls.iter().filter(|call|call["query"].as_str()
  .is_some_and(|query|query.starts_with("mutation"))).count(),1);
 assert_eq!(client.calls.len(),5);
}
#[test]
fn bootstrap_rejects_unknown_tree_before_creating_remote_refs(){
 let mut client=Mock::new(vec![empty(),json!({"ahead_by":0}),
  json!({"repository":{"head":{"target":{"oid":"abc"}},
   "base":null}})]);
 assert_eq!(resolve_pull_request(&mut client,"test/repo",&options()).unwrap_err(),
  "Unable to resolve head branch feature or base branch main");
 assert!(client.calls.iter().all(|call|call["kind"]=="graphql"
  ||call["method"]=="GET"));
}
#[test]
fn existing_by_number_does_not_require_head_and_never_tries_creation(){
 let mut client=Mock::new(vec![json!({"repository":{"pullRequest":pr()}})]);
 let output=resolve_pull_request(&mut client,"test/repo",&json!({"prNumber":43}))
  .unwrap();
 assert_eq!(output["head"],"feature");
 assert_eq!(client.calls.len(),1);
}
