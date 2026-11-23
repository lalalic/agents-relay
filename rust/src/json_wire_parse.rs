// Preserve JavaScript JSON parsing round-trip for existing durable SQLite values.
use serde_json::Value;
/// Decode JSON wire text like JavaScript JSON.parse, which permits lone
/// UTF-16 surrogate escapes. Keep unpaired code units in the same private-use
/// scalar encoding already used by observability::json_wire so they round-trip
/// to the identical JSON escapes on SQLite writes. Proper surrogate pairs
/// remain untouched and are decoded to the original Unicode scalar.
pub fn parse_js_json(raw: &str) -> Result<Value, String> {
    fn hex_digit(value: u8) -> Option<u16> {
        match value {
            b'0'..=b'9' => Some(u16::from(value - b'0')),
            b'a'..=b'f' => Some(u16::from(value - b'a') + 10),
            b'A'..=b'F' => Some(u16::from(value - b'A') + 10),
            _ => None,
        }
    }
    fn unit(input: &[u8], index: usize) -> Option<u16> {
        if index + 6 > input.len() || input[index] != b'\\' || input[index + 1] != b'u' {
            return None;
        }
        let mut value = 0u16;
        for digit in &input[index + 2..index + 6] {
            value = value * 16 + hex_digit(*digit)?;
        }
        Some(value)
    }
    let bytes = raw.as_bytes();
    let mut output = String::with_capacity(raw.len());
    let mut i = 0usize;
    let mut in_string = false;
    while i < bytes.len() {
        if bytes[i] == b'"' {
            in_string = !in_string;
            output.push('"');
            i += 1;
            continue;
        }
        if in_string && bytes[i] == b'\\' {
            if let Some(code) = unit(bytes, i) {
                if (0xD800..=0xDBFF).contains(&code) {
                    if let Some(low) = unit(bytes, i + 6) {
                        if (0xDC00..=0xDFFF).contains(&low) {
                            output.push_str(&raw[i..i + 12]);
                            i += 12;
                            continue;
                        }
                    }
                }
                if (0xD800..=0xDFFF).contains(&code) {
                    let marker = char::from_u32(0xF0000 + u32::from(code - 0xD800))
                        .ok_or("invalid surrogate placeholder")?;
                    output.push(marker);
                    i += 6;
                    continue;
                }
                output.push_str(&raw[i..i + 6]);
                i += 6;
                continue;
            }
            if i + 1 < bytes.len() {
                output.push_str(&raw[i..i + 2]);
                i += 2;
                continue;
            }
        }
        let ch = raw[i..]
            .chars()
            .next()
            .ok_or("invalid JSON character boundary")?;
        output.push(ch);
        i += ch.len_utf8();
    }
    serde_json::from_str(&output).map_err(|error| error.to_string())
}
