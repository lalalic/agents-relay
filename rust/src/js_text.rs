// New shared compatibility helper: Node's JS \s/trim whitespace semantics differ from Rust char::is_whitespace.
// Referenced by direct ports of src/task-title.ts and src/planner-task-title.ts.
pub(crate) fn is_js_whitespace(ch: char) -> bool {
    matches!(
        ch,
        '\u{0009}'..='\u{000d}'
            | '\u{0020}'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

pub(crate) fn trim_js(value: &str) -> &str {
    value.trim_matches(is_js_whitespace)
}

pub(crate) fn collapse_js_whitespace(value: &str) -> String {
    let mut output = String::new();
    let mut was_whitespace = false;
    for ch in value.chars() {
        if is_js_whitespace(ch) {
            if !was_whitespace {
                output.push(' ');
                was_whitespace = true;
            }
        } else {
            output.push(ch);
            was_whitespace = false;
        }
    }
    output
}
