// Node ReconcilerReviewBase.currentHeadSha: local Git is authoritative,
// not the Job's cached headSha or remote GitHub PR metadata. Read the
// immutable managed source ref when bound, otherwise the checked-out HEAD.
use crate::local_git_merge::{local_source_head,local_working_head};
use serde_json::Value;
use std::path::Path;

/// Git failures (unavailable path, unborn HEAD, malformed source ref) use
/// the same durable Job/review fallback as original Node. The git helper is
/// executed through the existing owned-process manager with a bounded wait.
pub fn verified_local_head(job:&Value,project:&Path,use_git:bool)->Option<String>{
    let fallback=||job.get("headSha").and_then(Value::as_str)
        .or_else(||job.pointer("/review/headSha").and_then(Value::as_str))
        .map(str::to_owned);
    if !use_git{return fallback();}
    let source_ref=job.pointer("/localMerge/sourceRef").and_then(Value::as_str)
        .filter(|reference|!reference.is_empty());
    let result=if let Some(source_ref)=source_ref{
        local_source_head(project,source_ref)
    }else{
        local_working_head(project)
    };
    result.ok().filter(|head|!head.is_empty()).or_else(fallback)
}
