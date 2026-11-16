// Direct port of Node src/projection-failure-dedupe.ts: deduplicate terminal fault reports by Job version.
use std::collections::HashMap;

#[derive(Default)]
pub struct ProjectionFailureDeduplicator {
    seen: HashMap<String, String>,
    insertion_order: Vec<String>,
}

impl ProjectionFailureDeduplicator {
    pub fn reset(&mut self) {
        self.seen.clear();
        self.insertion_order.clear();
    }

    pub fn should_report(
        &mut self,
        job_id: &str,
        updated_at: &str,
        reason: &str,
        classification: &str,
    ) -> bool {
        if classification != "terminal" {
            self.seen.remove(job_id);
            self.insertion_order.retain(|id| id != job_id);
            return true;
        }
        let signature = format!("{updated_at}\0{reason}");
        if self.seen.get(job_id) == Some(&signature) {
            return false;
        }
        self.seen.remove(job_id);
        self.insertion_order.retain(|id| id != job_id);
        self.seen.insert(job_id.to_owned(), signature);
        self.insertion_order.push(job_id.to_owned());
        if self.seen.len() > 4096 {
            if let Some(oldest) = self.insertion_order.first().cloned() {
                self.insertion_order.remove(0);
                self.seen.remove(&oldest);
            }
        }
        true
    }
}
