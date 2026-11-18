// GitHub collaboration snapshot readers: fake GraphQL effects only.
// No real GitHub account, network, credential, or lifecycle Job is touched.
use agents_relay_rust2::{
 store::{
  load_managed_github_pull_request_graphql,load_managed_github_job_graphql,
  list_managed_github_jobs,with_github_request_context,
 },
 store_github::GitHubApi,
 markers::{render_job_body,render_task_comment},
};
use serde_json::{json,Value};
use std::{cell::RefCell,collections::HashSet};
#[derive(Default)]
struct Fixture{responses:Vec<Value>,calls:Vec<Value>}
impl GitHubApi for Fixture{
 fn graphql(&mut self,query:&str,variables:&Value)->Result<Value,String>{
  self.calls.push(json!({"query":query,"variables":variables}));
  if self.responses.is_empty(){return Err("Missing response".into());}
  let response=self.responses.remove(0);
  if let Some(err)=response.get("fixtureError").and_then(Value::as_str){
   return Err(err.to_owned());
  }
  Ok(response)
 }
 fn request(&mut self,_:&str,_:&str,_:Option<&Value>)->Result<Value,String>{
  Err("Unexpected write request".into())
 }
}
fn trusted()->HashSet<String>{HashSet::from(["trusted".to_owned()])}
fn job()->Value{
 json!({"id":"41","prNumber":7,"repository":"fixture/repo",
  "title":"test","state":"ACTIVE","objective":"fixture",
  "updatedAt":"2026-11-17T12:00:00.000Z",
  "tasks":[],"plans":[]})
}
fn pr(number:u64)->Value{
 let job=job();
 let task=json!({"id":"91","jobId":"41","kind":"work",
  "agentName":"worker","state":"QUEUED","input":"test",
  "attempt":0,"maxAttempts":3});
 json!({"number":number,"body":render_job_body(&job),
  "state":"OPEN","comments":{"nodes":[{
   "author":{"login":"trusted"},"body":render_task_comment(&task),
   "databaseId":19}]}})
}
#[test]
fn invalid_identity_causes_zero_graphql_effects(){
 let mut client=Fixture::default();
 assert!(load_managed_github_pull_request_graphql(
  &mut client,"fixture/repo",0,&trusted()).unwrap().is_empty());
 assert!(load_managed_github_pull_request_graphql(
  &mut client,"not-a-repository",4,&trusted()).unwrap().is_empty());
 assert!(client.calls.is_empty());
}
#[test]
fn snapshot_read_honors_trusted_marker_and_job_selection(){
 let mut client=Fixture{responses:vec![json!({"repository":{"pullRequest":pr(7)}})],..Default::default()};
 let rows=load_managed_github_pull_request_graphql(
  &mut client,"fixture/repo",7,&trusted()).unwrap();
 assert_eq!(rows.len(),1);
 assert_eq!(rows[0]["job"]["id"],"41");
 assert_eq!(rows[0]["job"]["tasks"][0]["id"],"91");
 assert_eq!(client.calls.len(),1);
 assert_eq!(client.calls[0]["variables"],
  json!({"owner":"fixture","name":"repo","number":7}));
 client.responses.push(json!({"repository":{"pullRequest":pr(7)}}));
 assert!(load_managed_github_job_graphql(
  &mut client,"fixture/repo",7,"missing",&trusted()).unwrap().is_none());
}
#[test]
fn pagination_reads_all_unique_prs_and_does_not_create_remote_pr(){
 let first=json!({"repository":{"open":{"nodes":[pr(6),pr(8)],"pageInfo":{
  "hasNextPage":true,"endCursor":"cursor-next"}},
  "recentMerged":{"nodes":[pr(9)]},"recentClosed":{"nodes":[]}}});
 let last=json!({"repository":{"open":{"nodes":[pr(8),pr(11)],"pageInfo":{
  "hasNextPage":false,"endCursor":null}}}});
 let mut client=Fixture{responses:vec![first,last],..Default::default()};
 let results=list_managed_github_jobs(&mut client,"fixture/repo",&trusted()).unwrap();
 assert_eq!(results.iter().map(|value|value["job"]["prNumber"].as_u64().unwrap())
  .collect::<Vec<_>>(),vec![11,9,8,6]);
 assert_eq!(client.calls.len(),2);
 assert_eq!(client.calls[1]["variables"]["cursor"],"cursor-next");
 assert!(client.calls.iter().all(|call|call["query"].as_str().unwrap()
  .starts_with("query(")));
}
#[test]
fn context_port_executes_once_and_restores_context_after_error(){
 let calls=RefCell::new(Vec::<String>::new());
 let value=with_github_request_context("dashboard",||{
  calls.borrow_mut().push("work".into());Ok::<_,String>(42)
 },Some(|context:&str,work:&mut dyn FnMut()->Result<i32,String>|{
  calls.borrow_mut().push(format!("enter:{context}"));
  let output=work()?;
  calls.borrow_mut().push("exit".into());
  Ok(output)
 })).unwrap();
 assert_eq!(value,42);
 assert_eq!(&*calls.borrow(),&["enter:dashboard","work","exit"]);
 let failure=with_github_request_context("test",||Err::<i32,_>("expected".to_owned()),
  None::<fn(&str,&mut dyn FnMut()->Result<i32,String>)->Result<i32,String>>)
  .unwrap_err();
 assert_eq!(failure,"expected");
}
#[test]
fn graphql_error_does_not_fabricate_snapshot_or_continue_paging(){
 let mut client=Fixture{responses:vec![json!({"fixtureError":"isolated failure"})],
  ..Default::default()};
 assert_eq!(list_managed_github_jobs(&mut client,"fixture/repo",&trusted())
  .unwrap_err(),"isolated failure");
 assert_eq!(client.calls.len(),1);
}
