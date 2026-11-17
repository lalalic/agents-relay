// Direct port of src/z-oauth.ts using a caller-supplied HTTP transport.
// OAuth is worker-scoped; operator and refresh credentials are never returned.
// No Neo endpoint, provider SDK, or production cloud dependency is embedded.
use regex::Regex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, io::Read, path::Path};
use url::{form_urlencoded, Url};

pub const REDIRECT_URI: &str = "http://127.0.0.1:8765/agents-relay/oauth/callback";
#[derive(Debug, Clone)]
pub struct OAuthResponse {
    pub status: u16,
    pub body: String,
    pub location: Option<String>,
}
pub fn z_worker_mcp_endpoint(origin: Option<&str>) -> Result<String, String> {
    let configured = origin
        .unwrap_or("")
        .strip_suffix('/')
        .unwrap_or(origin.unwrap_or(""));
    let valid = Regex::new(r"^https://[A-Za-z0-9.-]+(?::\d{1,5})?$")
        .map_err(|e| e.to_string())?
        .is_match(configured);
    if !valid {
        return Err("Z OAuth origin must be HTTPS".into());
    }
    Ok(format!("{configured}/mcp"))
}
fn random(n: usize) -> Result<Vec<u8>, String> {
    let mut bits = vec![0u8; n];
    fs::File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut bits))
        .map_err(|e| format!("Secure OAuth randomness unavailable: {e}"))?;
    Ok(bits)
}
fn encode_base64url(bytes: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut s = String::new();
    let (chunks, last) = bytes.as_chunks::<3>();
    for chunk in chunks {
        let [a, b, c] = [chunk[0], chunk[1], chunk[2]];
        for idx in [
            a >> 2,
            ((a & 3) << 4) | (b >> 4),
            ((b & 15) << 2) | (c >> 6),
            c & 63,
        ] {
            s.push(T[idx as usize] as char);
        }
    }
    if let Some(&a) = last.first() {
        s.push(T[(a >> 2) as usize] as char);
        if last.len() == 1 {
            s.push(T[((a & 3) << 4) as usize] as char);
        } else {
            let b = last[1];
            s.push(T[(((a & 3) << 4) | (b >> 4)) as usize] as char);
            s.push(T[((b & 15) << 2) as usize] as char);
        }
    }
    s
}
fn form(items: &[(&str, &str)]) -> String {
    let mut writer = form_urlencoded::Serializer::new(String::new());
    for &(key, val) in items {
        writer.append_pair(key, val);
    }
    writer.finish()
}
fn body_json(response: &OAuthResponse) -> Result<Value, String> {
    serde_json::from_str(&response.body).map_err(|e| e.to_string())
}
fn query_value(url: &Url, key: &str) -> Option<String> {
    url.query_pairs()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.into_owned())
}
/// Fetcher receives a full absolute URL, method, optional request body, and
/// transport headers. The caller must enforce the 15-second timeout and manual
/// redirect contract (mirroring the supplied Node fetcher boundary).
pub fn issue_z_worker_credential<F>(
    origin: Option<&str>,
    operator_token: Option<&str>,
    operator_token_file: Option<&Path>,
    mut fetcher: F,
) -> Result<String, String>
where
    F: FnMut(&str, &str, Option<&str>, &[(&str, &str)]) -> Result<OAuthResponse, String>,
{
    let endpoint = z_worker_mcp_endpoint(origin)?;
    let base = endpoint.strip_suffix("/mcp").unwrap_or(&endpoint);
    let token = if let Some(token) = operator_token {
        token.to_owned()
    } else if let Some(file) = operator_token_file {
        fs::read_to_string(file)
            .unwrap_or_default()
            .trim()
            .to_owned()
    } else {
        String::new()
    };
    if token.is_empty() {
        return Err(
            "Configure AGENTS_RELAY_Z_OAUTH_OPERATOR_TOKEN_FILE or supply an operator token".into(),
        );
    }
    let verifier = encode_base64url(&random(32)?);
    let challenge = encode_base64url(&Sha256::digest(verifier.as_bytes()));
    let state = random(18)?
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let request =
        |path: &str,
         method: &str,
         body: Option<&str>,
         headers: &[(&str, &str)],
         fetcher: &mut F| fetcher(&format!("{base}{path}"), method, body, headers);
    let registration_body = json!({
        "client_name":"Agents Relay Z worker",
        "redirect_uris":[REDIRECT_URI],
        "grant_types":["authorization_code","refresh_token"],
        "response_types":["code"],
        "token_endpoint_auth_method":"none"
    })
    .to_string();
    let registration = request(
        "/register",
        "POST",
        Some(&registration_body),
        &[("Content-Type", "application/json")],
        &mut fetcher,
    )?;
    if registration.status != 201 {
        return Err(format!(
            "Z OAuth registration rejected: HTTP {}",
            registration.status
        ));
    }
    let client = body_json(&registration)?;
    let client_id = client["client_id"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("Z OAuth registration returned no client_id")?;
    let auth_query = form(&[
        ("response_type", "code"),
        ("client_id", client_id),
        ("redirect_uri", REDIRECT_URI),
        ("code_challenge", &challenge),
        ("code_challenge_method", "S256"),
        ("scope", "mcp"),
        ("resource", &endpoint),
        ("state", &state),
    ]);
    let page = request(
        &format!("/authorize?{auth_query}"),
        "GET",
        None,
        &[],
        &mut fetcher,
    )?;
    if page.status != 200 {
        return Err(format!(
            "OAuth authorization page rejected: HTTP {}",
            page.status
        ));
    }
    let regex =
        Regex::new(r#"name="rid"\s+value="([A-Za-z0-9_-]+)""#).map_err(|e| e.to_string())?;
    let rid = regex
        .captures(&page.body)
        .and_then(|m| m.get(1))
        .map(|s| s.as_str())
        .ok_or("OAuth authorization page lacked request ID")?;
    let approve = form(&[("rid", rid), ("token", &token)]);
    let approval = request(
        "/authorize",
        "POST",
        Some(&approve),
        &[("Content-Type", "application/x-www-form-urlencoded")],
        &mut fetcher,
    )?;
    if approval.status != 302 {
        return Err(format!("OAuth consent rejected: HTTP {}", approval.status));
    }
    let location = approval
        .location
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or("OAuth approval lacked callback")?;
    let callback = Url::parse(location).map_err(|e| e.to_string())?;
    let redirect = Url::parse(REDIRECT_URI).map_err(|e| e.to_string())?;
    if callback.origin() != redirect.origin()
        || callback.path() != redirect.path()
        || query_value(&callback, "state").as_deref() != Some(&state)
        || query_value(&callback, "iss").as_deref() != Some(base)
    {
        return Err("OAuth callback state, redirect, or issuer mismatch".into());
    }
    let code = query_value(&callback, "code")
        .filter(|s| !s.is_empty())
        .ok_or("OAuth callback lacked authorization code")?;
    let exchange = form(&[
        ("grant_type", "authorization_code"),
        ("client_id", client_id),
        ("redirect_uri", REDIRECT_URI),
        ("code", &code),
        ("code_verifier", &verifier),
    ]);
    let response = request(
        "/token",
        "POST",
        Some(&exchange),
        &[("Content-Type", "application/x-www-form-urlencoded")],
        &mut fetcher,
    )?;
    if response.status != 200 {
        return Err(format!(
            "OAuth token exchange rejected: HTTP {}",
            response.status
        ));
    }
    let worker = body_json(&response)?;
    let access = worker["access_token"].as_str().filter(|s| !s.is_empty());
    if access.is_none() || worker["expires_in"] != 3600 {
        return Err("OAuth returned an invalid worker access token".into());
    }
    if let Some(refresh) = worker["refresh_token"].as_str().filter(|s| !s.is_empty()) {
        let revoke = form(&[("token", refresh)]);
        let result = request(
            "/revoke",
            "POST",
            Some(&revoke),
            &[("Content-Type", "application/x-www-form-urlencoded")],
            &mut fetcher,
        )?;
        if result.status != 200 {
            return Err("OAuth failed to revoke unused refresh credential".into());
        }
    }
    Ok(access.expect("validated access token").to_owned())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn https_origin_validation_and_base64url_length() {
        assert_eq!(
            z_worker_mcp_endpoint(Some("https://oauth.example.test/")).unwrap(),
            "https://oauth.example.test/mcp"
        );
        for bad in [
            "http://host",
            "https://host/path",
            "https://u:pw@host",
            "https://host:123456",
            "https://host/?q=1",
        ] {
            assert!(z_worker_mcp_endpoint(Some(bad)).is_err(), "{bad}");
        }
        assert_eq!(encode_base64url(&[255]), "_w");
        assert_eq!(encode_base64url(&[255, 254]), "__4");
        assert_eq!(encode_base64url(&[255, 254, 253]), "__79");
    }
}

// Real opt-in HTTPS transport. Every OAuth call has a 15-second global limit,
// and redirects remain visible for exact issuer/state validation.
pub fn oauth_http_request(
    url: &str,
    method: &str,
    body: Option<&str>,
    headers: &[(&str, &str)],
) -> Result<OAuthResponse, String> {
    let config = ureq::Agent::config_builder()
        .timeout_global(Some(std::time::Duration::from_secs(15)))
        .max_redirects(0)
        .http_status_as_error(false)
        .build();
    let agent = ureq::Agent::new_with_config(config);
    let response = match method {
        "GET" => {
            let mut request = agent.get(url);
            for &(name, value) in headers {
                request = request.header(name, value);
            }
            request.call()
        }
        "POST" => {
            let mut request = agent.post(url);
            for &(name, value) in headers {
                request = request.header(name, value);
            }
            request.send(body.unwrap_or(""))
        }
        _ => return Err(format!("Unsupported OAuth HTTP method: {method}")),
    }
    .map_err(|error| error.to_string())?;
    let mut response = response;
    let location = response
        .headers()
        .get("location")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let status = response.status().as_u16();
    let body = response
        .body_mut()
        .read_to_string()
        .map_err(|e| e.to_string())?;
    Ok(OAuthResponse {
        status,
        body,
        location,
    })
}

/// Production-bound implementation (not activated without an explicit origin
/// and operator token). Never returns the operator or refresh credential.
pub fn issue_z_worker_credential_http(
    origin: Option<&str>,
    operator_token: Option<&str>,
    operator_token_file: Option<&Path>,
) -> Result<String, String> {
    issue_z_worker_credential(
        origin,
        operator_token,
        operator_token_file,
        oauth_http_request,
    )
}

#[cfg(test)]
mod native_http_tests {
    use super::*;
    use std::{io::Write as _, net::TcpListener, thread};
    fn read_complete_request(socket: &mut std::net::TcpStream) -> String {
        let mut data = Vec::new();
        let mut chunk = [0u8; 4096];
        let mut goal = None;
        loop {
            let count = socket.read(&mut chunk).unwrap();
            if count == 0 {
                break;
            }
            data.extend_from_slice(&chunk[..count]);
            if goal.is_none() {
                if let Some(header_end) = data.windows(4).position(|v| v == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&data[..header_end]);
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length: ")
                                .and_then(|v| v.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    goal = Some(header_end + 4 + length);
                }
            }
            if goal.is_some_and(|size| data.len() >= size) {
                break;
            }
        }
        String::from_utf8(data).unwrap()
    }
    #[test]
    fn local_http_transport_preserves_redirect_location_and_request_body() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(std::time::Duration::from_secs(3)))
                .unwrap();
            let request = read_complete_request(&mut socket);
            assert!(request.starts_with("POST /authorize HTTP/1.1"));
            assert!(request.contains("rid=fixture&token=operator"));
            socket.write_all(b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:8765/agents-relay/oauth/callback?code=x\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        });
        let url = format!("http://{address}/authorize");
        let result = oauth_http_request(
            &url,
            "POST",
            Some("rid=fixture&token=operator"),
            &[("Content-Type", "application/x-www-form-urlencoded")],
        )
        .unwrap();
        assert_eq!(result.status, 302);
        assert_eq!(
            result.location.as_deref(),
            Some("http://127.0.0.1:8765/agents-relay/oauth/callback?code=x")
        );
        server.join().unwrap();
    }
    #[test]
    fn complete_pkce_flow_over_disposable_local_http_server() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let mut count = 0;
            let mut state = String::new();
            for socket in listener.incoming().take(5) {
                let mut socket = socket.unwrap();
                socket
                    .set_read_timeout(Some(std::time::Duration::from_secs(3)))
                    .unwrap();
                let req = read_complete_request(&mut socket);
                let first = req.lines().next().unwrap_or("");
                let (status, body, extra) = match count {
                    0 => {
                        assert!(first.starts_with("POST /register "));
                        ("201 Created", r#"{"client_id":"fixture"}"#, String::new())
                    }
                    1 => {
                        assert!(first.starts_with("GET /authorize?"));
                        let url = first.split_whitespace().nth(1).unwrap();
                        state = Url::parse(&format!("http://localhost{url}"))
                            .unwrap()
                            .query_pairs()
                            .find(|(k, _)| k == "state")
                            .unwrap()
                            .1
                            .into_owned();
                        assert_eq!(state.len(), 36);
                        (
                            "200 OK",
                            r#"<input name="rid" value="rid1">"#,
                            String::new(),
                        )
                    }
                    2 => {
                        assert!(first.starts_with("POST /authorize "));
                        assert!(req.contains("token=operator"));
                        ("302 Found","",format!("Location: {REDIRECT_URI}?code=valid-code&state={state}&iss=https%3A%2F%2Foauth.test\r\n"))
                    }
                    3 => {
                        assert!(first.starts_with("POST /token "));
                        assert!(req.contains("code_verifier="));
                        (
                            "200 OK",
                            r#"{"access_token":"worker-only","expires_in":3600,"refresh_token":"refresh-secret"}"#,
                            String::new(),
                        )
                    }
                    _ => {
                        assert!(first.starts_with("POST /revoke "));
                        assert!(req.contains("token=refresh-secret"));
                        ("200 OK", "{}", String::new())
                    }
                };
                let reply=format!("HTTP/1.1 {status}\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
                socket.write_all(reply.as_bytes()).unwrap();
                count += 1;
            }
            assert_eq!(count, 5);
        });
        let token = issue_z_worker_credential(
            Some("https://oauth.test"),
            Some("operator"),
            None,
            |url, method, body, headers| {
                let parsed = Url::parse(url).unwrap();
                let local = format!(
                    "http://{address}{}{}",
                    parsed.path(),
                    parsed.query().map(|q| format!("?{q}")).unwrap_or_default()
                );
                oauth_http_request(&local, method, body, headers)
            },
        )
        .unwrap();
        assert_eq!(token, "worker-only");
        server.join().unwrap();
    }
}
