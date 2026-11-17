// Port of src/review-revision-policy.ts: resolve bounded review loops and stable finding fingerprints.
use serde_json::{json, Value};

pub fn review_revision_limits(env: &Value) -> Result<Value, String> {
    fn setting(env: &Value, name: &str, fallback: u64) -> Result<u64, String> {
        let Some(v) = env.get(name) else {
            return Ok(fallback);
        };
        let Some(raw) = v.as_str() else {
            return Err(format!("{name} must be an integer from 1 to 100"));
        };
        if raw.trim().is_empty() {
            return Ok(fallback);
        }
        let parsed = raw.trim().parse::<f64>().unwrap_or(f64::NAN);
        if !parsed.is_finite() || parsed.fract() != 0.0 || !(1.0..=100.0).contains(&parsed) {
            return Err(format!("{name} must be an integer from 1 to 100"));
        }
        Ok(parsed as u64)
    }
    Ok(
        json!({"maxRounds":setting(env,"AGENTS_RELAY_REVIEW_MAX_ROUNDS",5)?,"maxNoProgressRounds":setting(env,"AGENTS_RELAY_REVIEW_NO_PROGRESS_LIMIT",1)?}),
    )
}
fn js_space(c: char) -> bool {
    matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
fn js_trim(s: &str) -> &str {
    s.trim_matches(js_space)
}
fn normalized(findings: &[Value]) -> Vec<String> {
    let mut values: Vec<String> = findings
        .iter()
        .filter_map(Value::as_str)
        .map(|s| {
            let mut out = String::new();
            let mut pending = false;
            for c in js_trim(s).chars() {
                if js_space(c) {
                    pending = !out.is_empty();
                } else {
                    if pending {
                        out.push(' ');
                        pending = false;
                    }
                    out.extend(c.to_lowercase());
                }
            }
            out
        })
        .filter(|s| !s.is_empty())
        .collect();
    values.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    values.dedup();
    values
}
pub fn review_finding_fingerprint(findings: &[Value]) -> Option<String> {
    let values = normalized(findings);
    if values.is_empty() {
        return None;
    }
    let data = serde_json::to_vec(&values).ok()?;
    Some(sha256(&data))
}
pub fn review_round_finding_fingerprint(job: &Value, round: &Value) -> Option<String> {
    if let Some(fp) = round["findingFingerprint"]
        .as_str()
        .filter(|s| !s.is_empty())
    {
        return Some(fp.into());
    }
    let ids = round["requestIds"].as_array()?;
    let requests = job["reviewRevisionRequests"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let findings: Vec<Value> = requests
        .iter()
        .filter(|r| ids.contains(&r["requestId"]))
        .flat_map(|r| {
            r["findings"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|f| f["summary"].clone())
        })
        .collect();
    review_finding_fingerprint(&findings)
}
pub fn repeated_finding_rounds(job: &Value, current: &Value) -> u64 {
    let Some(fp) = review_round_finding_fingerprint(job, current) else {
        return 0;
    };
    if current["status"] != "changes_required" {
        return 0;
    }
    let mut prev: Vec<&Value> = job["reviewRevisionRounds"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| {
            r["reviewTaskId"] != current["reviewTaskId"] && r["status"] == "changes_required"
        })
        .collect();
    prev.sort_by(|a, b| {
        a["recordedAt"]
            .as_str()
            .unwrap_or("")
            .cmp(b["recordedAt"].as_str().unwrap_or(""))
            .then_with(|| {
                a["reviewTaskId"]
                    .as_str()
                    .unwrap_or("")
                    .cmp(b["reviewTaskId"].as_str().unwrap_or(""))
            })
    });
    let mut count = 0;
    for round in prev.iter().rev() {
        if review_round_finding_fingerprint(job, round).as_deref() != Some(&fp) {
            break;
        }
        count += 1;
    }
    count
}

fn sha256(input: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut data = input.to_vec();
    let bits = (data.len() as u64) * 8;
    data.push(0x80);
    while data.len() % 64 != 56 {
        data.push(0)
    }
    data.extend_from_slice(&bits.to_be_bytes());
    let mut h = [
        0x6a09e667u32,
        0xbb67ae85,
        0x3c6ef372,
        0xa54ff53a,
        0x510e527f,
        0x9b05688c,
        0x1f83d9ab,
        0x5be0cd19,
    ];
    for block in data.as_chunks::<64>().0 {
        let mut w = [0u32; 64];
        for (i, c) in block.as_chunks::<4>().0.iter().enumerate() {
            w[i] = u32::from_be_bytes(*c)
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1)
        }
        let (mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh) =
            (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]);
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ (!e & g);
            let t1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2)
        }
        for (i, v) in [a, b, c, d, e, f, g, hh].iter().enumerate() {
            h[i] = h[i].wrapping_add(*v)
        }
    }
    h.iter().map(|v| format!("{v:08x}")).collect()
}
