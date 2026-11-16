// Direct port of Node src/github-binding-order.ts: order projection candidates by binding priority.
use serde_json::Value;
use std::cmp::Ordering;

#[cfg(target_os = "macos")]
fn locale_compare(left: &str, right: &str) -> Ordering {
    use std::ffi::CString;
    let (Ok(lhs), Ok(rhs), Ok(locale_name)) = (
        CString::new(left),
        CString::new(right),
        CString::new("en_US.UTF-8"),
    ) else {
        return left.cmp(right);
    };
    let locale = unsafe {
        libc::newlocale(
            libc::LC_COLLATE_MASK,
            locale_name.as_ptr(),
            std::ptr::null_mut(),
        )
    };
    if locale.is_null() {
        return left.cmp(right);
    }
    unsafe extern "C" {
        fn strcoll_l(
            left: *const std::ffi::c_char,
            right: *const std::ffi::c_char,
            locale: libc::locale_t,
        ) -> libc::c_int;
    }
    let compared = unsafe { strcoll_l(lhs.as_ptr(), rhs.as_ptr(), locale) };
    unsafe { libc::freelocale(locale) };
    compared.cmp(&0)
}

#[cfg(not(target_os = "macos"))]
fn locale_compare(left: &str, right: &str) -> Ordering {
    // Canonical createdAt values are UTC ISO timestamps; lexicographic order is identical.
    left.cmp(right)
}

fn score(job: &Value) -> u8 {
    let bound = job["prNumber"].as_f64().unwrap_or(0.0) > 0.0;
    let terminal = matches!(job["state"].as_str(), Some("COMPLETED" | "CANCELLED"));
    match (terminal, bound) {
        (false, false) => 0,
        (false, true) => 1,
        (true, true) => 2,
        (true, false) => 3,
    }
}

pub fn order_github_binding_candidates(items: &[Value]) -> Vec<Value> {
    let mut result = items.to_vec();
    result.sort_by(|a, b| {
        score(&a["job"]).cmp(&score(&b["job"])).then_with(|| {
            locale_compare(
                a["job"]["createdAt"].as_str().unwrap_or(""),
                b["job"]["createdAt"].as_str().unwrap_or(""),
            )
        })
    });
    result
}
