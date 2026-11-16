// Direct port of Node src/final-review-role.ts: preserve the canonical reviewer identity and legacy alias.
pub const FINAL_REVIEW_AGENT: &str = "job-acceptance-reviewer";

pub fn is_final_review_agent(name: Option<&str>) -> bool {
    matches!(name, Some(FINAL_REVIEW_AGENT | "reviewer"))
}
