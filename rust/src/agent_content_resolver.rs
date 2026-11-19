// Direct port of Node src/agent-content-resolver.ts: layered Agent Markdown inheritance, section operations, file-link anchoring and path confinement.
use crate::js_text::{is_js_whitespace, trim_js};
use regex::{Captures, Regex};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Component, Path, PathBuf},
};

fn sha(content: &str) -> String {
    format!("{:x}", Sha256::digest(content.as_bytes()))
}
fn absolute(raw: &str) -> PathBuf {
    let path = Path::new(raw);
    let mut result = PathBuf::new();
    let parts = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("/"))
            .join(path)
    };
    for component in parts.components() {
        match component {
            Component::ParentDir => {
                result.pop();
            }
            Component::CurDir => {}
            other => result.push(other.as_os_str()),
        }
    }
    result
}
fn string_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
fn truthy_str(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}
fn read_string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

pub fn agent_source_layers(project_path: &str, options: &Value) -> Value {
    let project = absolute(project_path);
    let mut layers = Vec::<Value>::new();
    if let Some(root) = truthy_str(options.get("globalRoot")) {
        layers.push(json!({"root":string_path(&absolute(root)),"source":"global"}));
    }
    if let Some(root) = truthy_str(options.get("workspaceRoot")) {
        let workspace = absolute(root);
        if workspace != project {
            layers.push(json!({"root":string_path(&workspace),"source":"parent"}));
        }
        if let Ok(relative) = project.strip_prefix(&workspace) {
            let mut cursor = workspace;
            let parts = relative.components().collect::<Vec<_>>();
            for part in parts.iter().take(parts.len().saturating_sub(1)) {
                cursor.push(part.as_os_str());
                if cursor != project {
                    layers.push(json!({"root":string_path(&cursor),"source":"parent"}));
                }
            }
        }
    }
    layers.push(json!({"root":string_path(&project),"source":"project"}));
    let mut seen = std::collections::HashSet::<String>::new();
    json!(layers.into_iter().filter(|layer| seen.insert(read_string(layer,"root"))).collect::<Vec<_>>())
}

#[derive(Clone, Debug)]
struct Document {
    body: String,
    name: Option<String>,
    extends_agent: Option<String>,
    mode: Option<String>,
    replace: Vec<String>,
    extend: Vec<String>,
    metadata: Map<String, Value>,
    path: String,
}

fn strip_one_quote(raw: &str) -> &str {
    let raw = raw.strip_prefix(['\'', '"']).unwrap_or(raw);
    raw.strip_suffix(['\'', '"']).unwrap_or(raw)
}
fn js_list(raw: &str) -> Vec<String> {
    let mut text = trim_js(raw);
    if let Some(value) = text.strip_prefix('[') {
        text = value;
    }
    if let Some(value) = text.strip_suffix(']') {
        text = value;
    }
    text.split(',')
        .map(|part| {
            let part = trim_js(part);
            let part = part.strip_prefix(['\'', '"']).unwrap_or(part);
            let part = part.strip_suffix(['\'', '"']).unwrap_or(part);
            part.to_string()
        })
        .filter(|part| !part.is_empty())
        .collect()
}

fn parse_document(raw: &str) -> Result<Document, String> {
    let front =
        Regex::new(r"(?s)^---\r?\n(.*?)\r?\n---\r?\n?").expect("fixed Agent frontmatter syntax");
    let empty = || Document {
        body: trim_js(raw).to_string(),
        name: None,
        extends_agent: None,
        mode: None,
        replace: vec![],
        extend: vec![],
        metadata: Map::new(),
        path: String::new(),
    };
    let Some(capture) = front.captures(raw) else {
        return Ok(empty());
    };
    let entire = capture.get(0).expect("frontmatter entire");
    let text = &capture[1];
    let scalar=Regex::new(r"^(name|extends|mode|sections):[\x09-\x0D\x20\u{00A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]*(.*)$").expect("fixed scalar grammar");
    let section=Regex::new(r"^  (replace|extend):[\x09-\x0D\x20\u{00A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]*(.+)$").expect("fixed Agent section grammar");
    let meta=Regex::new(r"^([A-Za-z0-9_-]+):[\x09-\x0D\x20\u{00A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]*(.*)$").expect("fixed Agent metadata grammar");
    let mut parsed = empty();
    parsed.body = trim_js(&raw[entire.end()..]).to_string();
    let mut in_sections = false;
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if let Some(capture) = scalar.captures(line) {
            let field = &capture[1];
            let value = trim_js(&capture[2]);
            in_sections = field == "sections";
            match field {
                "name" => parsed.name = Some(value.to_string()),
                "extends" => {
                    parsed.extends_agent = Some(strip_one_quote(value).to_string());
                }
                "mode" => {
                    if value != "replace" && value != "extend" {
                        return Err(format!("Invalid agent mode: {}", &capture[2]));
                    }
                    parsed.mode = Some(value.to_string());
                }
                _ => {}
            }
        } else if in_sections {
            if let Some(capture) = section.captures(line) {
                if &capture[1] == "replace" {
                    parsed.replace = js_list(&capture[2]);
                } else {
                    parsed.extend = js_list(&capture[2]);
                }
            } else if line.chars().next().is_some_and(|ch| !is_js_whitespace(ch)) {
                // Node /^\S/ does not reset sections on a blank line.
                in_sections = false;
            }
        }
        if let Some(capture) = meta.captures(line) {
            let value = trim_js(&capture[2]);
            let value = strip_one_quote(value);
            parsed.metadata.insert(capture[1].to_string(), json!(value));
        }
    }
    Ok(parsed)
}

fn metadata_from_raw(raw: &str) -> Map<String, Value> {
    // Node's metadata extraction uses /^---.../m separately from the
    // frontmatter parser: a later YAML-looking block still contributes
    // metadata even when the document body itself has no leading header.
    let front = Regex::new(r"(?ms)^---\r?\n(.*?)\r?\n---").expect("fixed metadata frontmatter");
    let field=Regex::new(r"^([A-Za-z0-9_-]+):[\x09-\x0D\x20\u{00A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]*(.*)$").expect("fixed scalar metadata");
    let mut metadata = Map::new();
    if let Some(capture) = front.captures(raw) {
        for line in capture[1].split('\n') {
            let line = line.strip_suffix('\r').unwrap_or(line);
            if let Some(value) = field.captures(line) {
                metadata.insert(
                    value[1].to_string(),
                    json!(strip_one_quote(trim_js(&value[2]))),
                );
            }
        }
    }
    metadata
}

fn absolute_agent_links(body: &str, source_path: &str) -> String {
    let fence_re=Regex::new(r"^[\x09-\x0D\x20\u{00A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]*(`{3,}|~{3,})").expect("fixed markdown fence regex");
    let links = Regex::new(r"(\]\()([^\x09-\x0D\x20\u{00A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF})]+)(\))").expect("fixed relative link regex");
    let scheme = Regex::new(r"(?i)^[a-z][a-z0-9+.-]*:").expect("fixed URL scheme regex");
    let mut fence: Option<char> = None;
    body.split('\n')
        .map(|line| {
            if let Some(capture) = fence_re.captures(line) {
                let start = capture[1].chars().next().unwrap_or('`');
                if fence.is_none() {
                    fence = Some(start);
                } else if fence == Some(start) {
                    fence = None;
                }
                return line.to_string();
            }
            if fence.is_some() {
                return line.to_string();
            }
            links
                .replace_all(line, |capture: &Captures<'_>| {
                    let destination = &capture[2];
                    if destination.starts_with('/')
                        || destination.starts_with('#')
                        || scheme.is_match(destination)
                    {
                        return capture[0].to_string();
                    }
                    let split = destination.find(['?', '#']).unwrap_or(destination.len());
                    let path = &destination[..split];
                    let fragment = &destination[split..];
                    let dirname = Path::new(source_path).parent().unwrap_or(Path::new("/"));
                    let resolved = absolute(&string_path(&dirname.join(path)));
                    format!(
                        "{}{}{}{}",
                        &capture[1],
                        string_path(&resolved),
                        fragment,
                        &capture[3]
                    )
                })
                .into_owned()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[derive(Clone, Debug)]
struct Section {
    path: String,
    start: usize,
    end: usize,
    level: usize,
}
fn index_sections(lines: &[String]) -> Result<Vec<Section>, String> {
    let heading = Regex::new(r"^(#{1,6})[\x09-\x0D\x20\u{00A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]+(.+?)[\x09-\x0D\x20\u{00A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]*#*[\x09-\x0D\x20\u{00A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]*$").expect("fixed heading regex");
    let fence = Regex::new(r"^[\x09-\x0D\x20\u{00A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]*(```|~~~)").expect("fixed fence regex");
    let mut sections = Vec::<Section>::new();
    let mut stack = Vec::<(String, usize)>::new();
    let mut inside = false;
    for (index, line) in lines.iter().enumerate() {
        if fence.is_match(line) {
            inside = !inside;
            continue;
        }
        if inside {
            continue;
        }
        let Some(capture) = heading.captures(line) else {
            continue;
        };
        let level = capture[1].len();
        while stack.last().is_some_and(|entry| entry.1 >= level) {
            stack.pop();
        }
        let current = trim_js(&capture[2]).to_string();
        let path = stack
            .iter()
            .map(|entry| entry.0.as_str())
            .chain(std::iter::once(current.as_str()))
            .collect::<Vec<_>>()
            .join("/");
        if sections.iter().any(|section| section.path == path) {
            return Err(format!("Ambiguous Markdown section {path}"));
        }
        for section in &mut sections {
            if section.end == lines.len() && section.level >= level {
                section.end = index;
            }
        }
        sections.push(Section {
            path,
            start: index,
            end: lines.len(),
            level,
        });
        stack.push((current, level));
    }
    Ok(sections)
}
fn merge_sections(base: &str, child: &Document) -> Result<String, String> {
    if child.mode.as_deref() == Some("replace") {
        if !child.replace.is_empty() || !child.extend.is_empty() {
            return Err("Whole-agent replace cannot contain sections overrides".into());
        }
        return Ok(child.body.clone());
    }
    let actions = child
        .replace
        .iter()
        .map(|path| (path, "replace"))
        .chain(child.extend.iter().map(|path| (path, "extend")))
        .collect::<Vec<_>>();
    let mut seen = std::collections::HashSet::new();
    for (path, _) in &actions {
        if !seen.insert(path.as_str()) {
            return Err(format!("Conflicting section operation: {path}"));
        }
    }
    if actions.is_empty() {
        return Ok(trim_js(&format!("{}\n\n{}", trim_js(base), child.body)).to_string());
    }
    let mut result = base.to_string();
    for (path, mode) in actions {
        let mut original = result.split('\n').map(str::to_string).collect::<Vec<_>>();
        let child_lines = child
            .body
            .split('\n')
            .map(str::to_string)
            .collect::<Vec<_>>();
        let target = index_sections(&original)?
            .into_iter()
            .find(|section| section.path == *path);
        let source = index_sections(&child_lines)?
            .into_iter()
            .find(|section| section.path == *path);
        if target.is_none() || source.is_none() {
            return Err(format!(
                "Section {path} missing in {} contract",
                if target.is_none() { "base" } else { "overlay" }
            ));
        }
        let target = target.expect("validated target");
        let source = source.expect("validated source");
        let subsection = child_lines[source.start..source.end].to_vec();
        if mode == "replace" {
            original.splice(target.start..target.end, subsection);
        } else {
            original.splice(target.end..target.end, subsection.into_iter().skip(1));
        }
        result = original.join("\n");
    }
    Ok(trim_js(&result).to_string())
}

#[derive(Debug)]
enum LoadError {
    Missing,
    Other(String),
}
fn load(path: &Path, root: &Path, expected_name: Option<&str>) -> Result<Document, LoadError> {
    let canonical = fs::canonicalize(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            LoadError::Missing
        } else if error.raw_os_error() == Some(20) {
            // fs.realpath is the original Node API boundary. Darwin/Linux
            // ENOTDIR (20) must retain the attempted Agent file path;
            // a generic OS error loses the evidence needed for parity.
            LoadError::Other(format!("ENOTDIR: not a directory, realpath '{}'",
                path.display()))
        } else {
            LoadError::Other(error.to_string())
        }
    })?;
    let canonical_root = fs::canonicalize(root).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            LoadError::Missing
        } else {
            LoadError::Other(error.to_string())
        }
    })?;
    if !canonical.starts_with(&canonical_root) {
        return Err(LoadError::Other("Agent file escapes context root".into()));
    }
    let bytes = fs::read(&canonical).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            LoadError::Missing
        } else {
            LoadError::Other(error.to_string())
        }
    })?;
    let raw = String::from_utf8_lossy(&bytes).into_owned();
    let mut doc = parse_document(&raw).map_err(LoadError::Other)?;
    doc.metadata = metadata_from_raw(&raw);
    doc.body = absolute_agent_links(&doc.body, &string_path(&canonical));
    if let (Some(expected), Some(actual)) = (
        expected_name,
        doc.name.as_deref().filter(|value| !value.is_empty()),
    ) {
        if actual != expected {
            return Err(LoadError::Other(format!(
                "Agent name mismatch {actual} != {expected}"
            )));
        }
    }
    doc.path = string_path(&canonical);
    Ok(doc)
}
fn load_layer(root: &Path, name: &str) -> Result<Option<Document>, String> {
    for suffix in [".agent.md", ".md"] {
        let path = root.join(format!("{name}{suffix}"));
        match load(&path, root, Some(name)) {
            Ok(document) => return Ok(Some(document)),
            Err(LoadError::Missing) => {}
            Err(LoadError::Other(error)) => return Err(error),
        }
    }
    Ok(None)
}
fn assigned_metadata(into: &mut Map<String, Value>, from: &Map<String, Value>) {
    for (key, value) in from {
        into.insert(key.clone(), value.clone());
    }
}

/** Resolve Agent Markdown by name (workspace / project layers) or an absolute
 * Markdown base path. The workspace is explicitly supplied by the caller; no
 * additional capability root is defined or inferred. */
pub fn resolve_agent_markdown(
    name: &str,
    builtins_root: &str,
    context_root: &str,
    layers: Option<&Value>,
) -> Result<Value, String> {
    let defaults = agent_source_layers(context_root, &json!({}));
    let selected = layers.unwrap_or(&defaults).as_array().cloned().unwrap_or_default();
    resolve_name(name,builtins_root,&selected,&mut Vec::new())
}

fn resolve_name(
    name: &str,
    builtins_root: &str,
    layers: &[Value],
    stack: &mut Vec<String>,
) -> Result<Value, String> {
    let allowed = Regex::new(r"^[a-zA-Z0-9_-]+$").expect("fixed Agent identifier grammar");
    if !allowed.is_match(name) { return Err(format!("Invalid agent name {name}")); }
    if stack.iter().any(|old| old == name) {
        return Err(format!("Agent extends cycle: {} -> {name}",stack.join(" -> ")));
    }
    stack.push(name.into());
    let mut effective = load_layer(Path::new(builtins_root), name)?;
    let mut sources = effective.as_ref().map(|a|vec![a.path.clone()]).unwrap_or_default();
    let mut metadata = effective.as_ref().map(|a|a.metadata.clone()).unwrap_or_default();
    for layer in layers {
        let root = read_string(layer,"root");
        if root.is_empty() { continue; }
        let Some(mut overlay) = load_layer(&Path::new(&root).join("agents"), name)? else {continue;};
        if (!overlay.replace.is_empty() || !overlay.extend.is_empty()) && overlay.extends_agent.is_none() {
            return Err("Section operations require extends".into());
        }
        let Some(parent_name) = overlay.extends_agent.clone() else {
            metadata = overlay.metadata.clone();
            sources = vec![overlay.path.clone()];
            effective = Some(overlay);
            continue;
        };
        let (parent_content,parent_metadata,parent_sources) = if Path::new(&parent_name).is_absolute() {
            if !parent_name.ends_with(".md") {return Err("Absolute Agent base must be a Markdown file".into());}
            let external = load(Path::new(&parent_name),Path::new(&parent_name).parent().unwrap_or(Path::new("/")),None)
                .map_err(|error| match error {LoadError::Missing=>format!("ENOENT: {parent_name}"),LoadError::Other(e)=>e})?;
            if external.name.as_deref().unwrap_or("").is_empty() || external.body.is_empty() {
                return Err("Absolute Agent base requires name frontmatter and nonempty body".into());
            }
            if external.extends_agent.is_some() {return Err("Absolute Agent base must be a standalone definition".into());}
            (external.body,external.metadata,vec![external.path])
        } else if allowed.is_match(&parent_name) {
            if parent_name == name {
                let base=effective.as_ref().ok_or_else(||format!("Missing base for agent {name}"))?;
                (base.body.clone(),metadata.clone(),sources.clone())
            } else {
                let resolved=resolve_name(&parent_name,builtins_root,layers,stack)
                    .map_err(|error| if error==format!("Unknown agent {parent_name}"){
                        format!("Missing base agent {parent_name} for {name}")
                    }else{error})?;
                (read_string(&resolved,"content"),resolved.get("metadata").and_then(Value::as_object).cloned().unwrap_or_default(),
                 resolved.get("sources").and_then(Value::as_array).map(|a|a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default())
            }
        } else {
            return Err(format!("Only extends: Agent name or absolute Markdown path is supported: {parent_name}"));
        };
        overlay.body=merge_sections(&parent_content,&overlay)?;
        metadata=parent_metadata;
        assigned_metadata(&mut metadata,&overlay.metadata);
        sources=parent_sources;
        sources.push(overlay.path.clone());
        effective=Some(overlay);
    }
    stack.pop();
    let effective=effective.ok_or_else(||format!("Unknown agent {name}"))?;
    let content=effective.body;
    Ok(json!({"content":content,"hash":sha(&content),"sources":sources,"metadata":metadata}))
}

#[cfg(test)]
mod name_inheritance_tests {
    use super::*;
    use std::{time::{SystemTime,UNIX_EPOCH},fs};
    fn fixture() -> PathBuf {
        let n=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root=std::env::temp_dir().join(format!("relay-extends-name-{}-{n}",std::process::id()));
        fs::create_dir_all(&root).unwrap();root
    }
    fn write(path:&Path,body:&str){fs::create_dir_all(path.parent().unwrap()).unwrap();fs::write(path,body).unwrap();}
    #[test]
    fn detached_worktree_inherits_named_workspace_general_agent() {
        let root=fixture();let workspace=root.join("neo");let project=root.join("elsewhere/job/project");
        let builtin=root.join("builtin");fs::create_dir_all(&builtin).unwrap();
        write(&workspace.join("agents/editor.agent.md"),"---\nname: editor\n---\n# General\nGeneral guidance");
        write(&project.join("agents/growth-editor.agent.md"),"---\nname: growth-editor\nextends: editor\n---\n# Growth\nLocal guidance");
        let layers=agent_source_layers(&string_path(&project),&json!({"workspaceRoot":string_path(&workspace)}));
        let result=resolve_agent_markdown("growth-editor",&string_path(&builtin),&string_path(&project),Some(&layers)).unwrap();
        assert!(read_string(&result,"content").contains("General guidance"));
        assert!(read_string(&result,"content").contains("Local guidance"));
        assert_eq!(result["sources"].as_array().unwrap().len(),2);
        assert_eq!(layers.as_array().unwrap()[0]["root"],string_path(&workspace));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn unsupported_prefixes_and_cycles_rejected_without_extra_root() {
        let root=fixture();let builtin=root.join("builtin");let project=root.join("project");
        fs::create_dir_all(&builtin).unwrap();
        let main=project.join("agents/alpha.agent.md");
        write(&main,"---\nname: alpha\nextends: shared/alpha\n---\n# Invalid");
        assert!(resolve_agent_markdown("alpha",&string_path(&builtin),&string_path(&project),None).unwrap_err().contains("Only extends:"));
        write(&main,"---\nname: alpha\nextends: beta\n---\n# Alpha");
        write(&project.join("agents/beta.agent.md"),"---\nname: beta\nextends: alpha\n---\n# Beta");
        assert!(resolve_agent_markdown("alpha",&string_path(&builtin),&string_path(&project),None).unwrap_err().contains("cycle"));
        fs::remove_dir_all(root).unwrap();
    }
}
