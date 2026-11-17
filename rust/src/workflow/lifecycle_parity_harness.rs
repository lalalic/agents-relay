// Isolated direct Node/Rust parity adapter for eight Graph-authoritative Job/Task lifecycle modules.
// All callbacks are fixture-local; never touches production Relay or live Jobs.
use super::{
    entity_creation, escalation, job_reconcile_v2, lifecycle, orchestrator_rescue, review_v2,
    task_action_policy, task_related_action_v2 as related,
};
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    future::Future,
    path::Path,
    pin::pin,
    rc::Rc,
    task::{Context, Poll, Waker},
};
fn drive<T>(future: impl Future<Output = T>) -> T {
    let mut ctx = Context::from_waker(Waker::noop());
    let mut work = pin!(future);
    loop {
        if let Poll::Ready(out) = work.as_mut().poll(&mut ctx) {
            return out;
        }
        std::thread::yield_now();
    }
}
fn path(request: &Value) -> Result<&Path, String> {
    request["directory"]
        .as_str()
        .map(Path::new)
        .ok_or("workflow directory required".into())
}
fn timestamp(request: &Value) -> &str {
    request["timestamp"]
        .as_str()
        .unwrap_or("2026-11-17T06:00:00.000Z")
}
pub fn scenario(request: &Value) -> Result<Value, String> {
    let directory = path(request)?;
    let action = request["action"].as_str().unwrap_or("");
    let facts = request.get("facts").cloned().unwrap_or(json!({}));
    let task = request.get("task").cloned().unwrap_or(json!({}));
    let job = request.get("job").cloned().unwrap_or(json!({}));
    let event = request["event"].as_str().unwrap_or("reconcile");
    let mut effects = Vec::<String>::new();
    let value = match action {
        "reviewState" => json!(review_v2::review_graph_state(request["outcome"].as_str())),
        "reviewOutcome" => json!(review_v2::review_outcome(
            request["state"].as_str().unwrap_or("")
        )?),
        "reviewDecision" => review_v2::decide_review_lifecycle(
            directory,
            request["outcome"].as_str(),
            event,
            &facts,
        )?,
        "reviewDispatch" => drive(review_v2::dispatch_review_lifecycle(
            directory,
            request["outcome"].as_str(),
            event,
            &facts,
            |id| {
                effects.push(id.into());
                Ok(json!({}))
            },
        ))?,
        "taskDecide" => lifecycle::decide_task_lifecycle(directory, &task, event, &facts)?,
        "jobDecide" => lifecycle::decide_job_lifecycle(directory, &job, event, &facts)?,
        "taskDispatch" => {
            let mut task = task.clone();
            let decision = lifecycle::dispatch_task_lifecycle_sync(
                directory,
                &mut task,
                event,
                &facts,
                timestamp(request),
            )?;
            json!({"decision":decision,"task":task})
        }
        "jobDispatch" => {
            let mut job = job.clone();
            let decision = lifecycle::dispatch_job_lifecycle_sync(
                directory,
                &mut job,
                event,
                &facts,
                timestamp(request),
            )?;
            json!({"decision":decision,"job":job})
        }
        "jobReconcile" => job_reconcile_v2::decide_job_reconcile(directory, &job, &facts)?,
        "relatedFacts" => {
            related::related_task_action_facts(directory, &task, &request["candidate"])?
        }
        "relatedDecision" => related::decide_related_task_action(
            directory,
            &task,
            &request["candidate"],
            request["actionId"].as_str().unwrap_or("task.retry"),
        )?,
        "relatedMutations" => json!(task_action_policy::select_related_task_mutations(
            directory,
            &job,
            &task,
            request["actionId"].as_str().unwrap_or("task.retry")
        )?),
        "createTask" => entity_creation::create_task_entity(
            directory,
            &job,
            &task,
            request["defer"] == true,
            timestamp(request),
        )?,
        "createJob" => entity_creation::create_job_entity(
            directory,
            &job,
            request["activate"] == true,
            timestamp(request),
        )?,
        "rescueFacts" => orchestrator_rescue::orchestrator_rescue_facts(
            &task,
            request["now"].as_i64().unwrap_or(0),
        ),
        "rescueDecision" => orchestrator_rescue::decide_orchestrator_rescue(
            directory,
            &task,
            request["now"].as_i64().unwrap_or(0),
        )?,
        "rescuePrepare" => {
            let mut task = task.clone();
            let result = orchestrator_rescue::prepare_orchestrator_repair(
                directory,
                &mut task,
                request["now"].as_i64().unwrap_or(0),
            )?;
            json!({"result":result,"task":task})
        }
        "escalationRun" => {
            let call = Rc::new(RefCell::new(Vec::<String>::new()));
            let invoke_log = Rc::clone(&call);
            let resume_log = Rc::clone(&call);
            let fail_log = Rc::clone(&call);
            let block_log = Rc::clone(&call);
            let result = drive(escalation::run_escalation_graph(
                directory,
                &request["request"],
                |_req| {
                    invoke_log.borrow_mut().push("invoke".into());
                    if request["invokeError"].is_string() {
                        return Err(request["invokeError"].as_str().unwrap_or("").into());
                    }
                    Ok(request
                        .get("result")
                        .cloned()
                        .unwrap_or(json!({"status":"resolved","summary":"ok"})))
                },
                |_result| {
                    resume_log.borrow_mut().push("resumeRecovery".into());
                    Ok(())
                },
                |_result| {
                    fail_log.borrow_mut().push("technicalFailure".into());
                    Ok(())
                },
                |_result| {
                    block_log.borrow_mut().push("blockForUser".into());
                    Ok(())
                },
            ));
            json!({"result":result?,"effects":call.borrow().clone()})
        }
        _ => return Err(format!("Unknown lifecycle fixture operation {action}")),
    };
    if matches!(action, "reviewDispatch") {
        return Ok(json!({"result":value,"effects":effects}));
    }
    Ok(value)
}
