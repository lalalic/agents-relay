// Direct port of src/service-publication.ts. Persist webhook facts to the
// caller's durable SQLite store before publishing observational events.
use crate::{events::event_for, publication_store::record_publication_in_database};
use rusqlite::Connection;
use serde_json::{json, Value};

fn payload_with_metadata(payload: &Value, wake: &Value, job: &Value) -> Value {
    let mut data = payload.clone();
    if let Some(obj) = data.as_object_mut() {
        obj.insert("deliveryId".into(), wake["deliveryId"].clone());
        obj.insert("repository".into(), job["repository"].clone());
        if let Some(pr) = job.get("prNumber") {
            obj.insert("prNumber".into(), pr.clone());
        }
    }
    data
}
/// Publish receives exactly the structured event. Its failure is propagated
/// after the SQLite write, as in Node, never rolling back durable publication.
pub fn handle_service_publication<F>(
    job: &Value,
    wake: &Value,
    db: &mut Connection,
    mut publish: F,
) -> Result<(), String>
where
    F: FnMut(&Value) -> Result<(), String>,
{
    let publication = wake
        .get("publication")
        .filter(|v| !v.is_null() && v.as_bool() != Some(false));
    let failure = wake
        .get("publishFailure")
        .filter(|v| !v.is_null() && v.as_bool() != Some(false));
    if publication.is_none() && failure.is_none() {
        return Ok(());
    }
    let job_id = job["id"].as_str().unwrap_or("");
    let delivery = wake["deliveryId"].as_str().unwrap_or("");
    record_publication_in_database(
        db,
        job_id,
        delivery,
        publication,
        failure,
        wake["publicationObservedAt"].as_str(),
    )?;
    if let Some(publication) = publication {
        let mut event = event_for(
            job_id,
            "release",
            None,
            "package.published",
            "succeeded",
            &format!(
                "Published {}@{}",
                publication["package"].as_str().unwrap_or("undefined"),
                publication["version"].as_str().unwrap_or("undefined")
            ),
            Some("orchestrator"),
            Some(payload_with_metadata(publication, wake, job)),
            None,
        );
        event["event_id"] = json!(format!("github:{job_id}:{delivery}:package.published"));
        publish(&event)?;
    }
    if let Some(failure) = failure {
        let mut event = event_for(
            job_id,
            "release",
            None,
            "package.publish_failed",
            "failed",
            &format!(
                "Publish failed: {}",
                failure["stage"].as_str().unwrap_or("undefined")
            ),
            Some("orchestrator"),
            Some(payload_with_metadata(failure, wake, job)),
            None,
        );
        event["event_id"] = json!(format!("github:{job_id}:{delivery}:package.publish_failed"));
        publish(&event)?;
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn persists_delivery_before_observer_failure() {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE publication_state(job_id TEXT PRIMARY KEY,json TEXT NOT NULL);\
            CREATE TABLE publication_delivery(job_id TEXT NOT NULL,delivery_id TEXT NOT NULL,type TEXT NOT NULL,json TEXT NOT NULL,observed_at TEXT NOT NULL,PRIMARY KEY(job_id,delivery_id));").unwrap();
        let job = json!({"id":"42","repository":"fixture","prNumber":0});
        let wake = json!({"deliveryId":"d1","publication":{"package":"pkg","version":"1"},"publicationObservedAt":"2026-11-17T12:00:00.000Z"});
        let error = handle_service_publication(&job, &wake, &mut db, |event| {
            assert_eq!(event["type"], "package.published");
            Err("fixture_bus_unavailable".into())
        })
        .unwrap_err();
        assert_eq!(error, "fixture_bus_unavailable");
        let count: i64 = db
            .query_row("SELECT COUNT(*) FROM publication_delivery", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(count, 1);
    }
}
