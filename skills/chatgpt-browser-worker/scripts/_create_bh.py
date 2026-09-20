import json
import re
import time

from browser_harness import *


CFG = json.load(open("__CFG_PATH__", encoding="utf-8"))


def _ax_nodes():
    return cdp("Accessibility.getFullAXTree").get("nodes", [])


def _click_exact(name, roles=()):
    matches = [node for node in _ax_nodes() if node.get("name", {}).get("value") == name and (not roles or node.get("role", {}).get("value") in roles)]
    if len(matches) != 1:
        raise RuntimeError(f"expected one accessible {name!r}, found {len(matches)}")
    backend_id = matches[0].get("backendDOMNodeId")
    box = cdp("DOM.getBoxModel", backendNodeId=backend_id).get("model", {}).get("content")
    if not box:
        raise RuntimeError(f"accessible {name!r} has no visible box")
    click_at_xy(sum(box[0::2]) / 4, sum(box[1::2]) / 4)
    return {"name": name, "role": matches[0].get("role", {}).get("value")}


def _click_if_present(name, roles=()):
    matches = [node for node in _ax_nodes() if node.get("name", {}).get("value") == name and (not roles or node.get("role", {}).get("value") in roles)]
    if len(matches) > 1:
        raise RuntimeError(f"ambiguous accessible {name!r}: found {len(matches)}")
    if matches:
        return _click_exact(name, roles)
    return None


def _find_composer():
    selector = js("""(() => {
      const candidates = [...document.querySelectorAll('textarea,[contenteditable="true"]')];
      const node = candidates.find(e => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && !e.disabled;
      });
      if (!node) return null;
      if (node.id) return '#' + CSS.escape(node.id);
      node.setAttribute('data-agents-relay-composer', 'true');
      return '[data-agents-relay-composer="true"]';
    })()""")
    if not selector:
        raise RuntimeError("ChatGPT composer was not observed")
    return selector


def _thread_id(existing_hrefs, timeout=20.0):
    deadline = time.time() + timeout
    existing_ids = set()
    for href in existing_hrefs or []:
        match = re.search(r"/c/([^/?#]+)", href or "")
        if match:
            existing_ids.add(match.group(1))
    while time.time() < deadline:
        match = re.search(r"/c/([^/?#]+)", page_info().get("url", ""))
        if match:
            return match.group(1)
        links = js("""(() => [...document.querySelectorAll('a[href*="/g/"][href*="/c/"]')].map(a => ({href:a.href,text:(a.textContent||'').trim()})))()""") or []
        prompt_hint = (CFG.get("prompt") or "").strip()[:60]
        matching = []
        for link in links:
            href = link.get("href") or ""
            link_match = re.search(r"/c/([^/?#]+)", href)
            if link_match and prompt_hint and prompt_hint in (link.get("text") or ""):
                matching.append(link_match.group(1))
        unique_matching = list(dict.fromkeys(matching))
        if len(unique_matching) == 1:
            return unique_matching[0]
        if len(unique_matching) > 1:
            new_matching = [value for value in unique_matching if value not in existing_ids]
            if len(new_matching) == 1:
                return new_matching[0]
            raise RuntimeError("multiple prompt-matching durable thread ids were observed after submission")
        time.sleep(0.25)
    raise RuntimeError("ChatGPT did not expose a new durable thread id before timeout")


ensure_real_tab()
if "chatgpt.com" not in page_info().get("url", ""):
    new_tab("https://chatgpt.com/")
    wait_for_load()
project = CFG["project"]
selected = {"name": project["name"], "action": "default_chat"}
if project["name"].casefold() not in ("unspecified", "default"):
    # Project rows expose a generic "Open project home" action, so bind that
    # action to the visible row whose marquee text exactly matches the requested
    # Project. This avoids relying on the project label itself being clickable.
    opened_project = js("""(() => {
      const wanted = %s;
      const labels = [...document.querySelectorAll('[data-marquee-text]')].filter(e => (e.textContent || '').trim() === wanted);
      for (const label of labels) {
        const button = label.closest('li')?.querySelector('button[aria-label="Open project home"]');
        if (!button) continue;
        const r = button.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight) { button.click(); return true; }
      }
      return false;
    })()""" % json.dumps(project["name"]))
    if not opened_project:
        raise RuntimeError(f"requested Project {project['name']!r} has no visible project-home action")
    deadline = time.time() + 8
    visible = ""
    while time.time() < deadline:
        info = page_info()
        visible = js("document.body.innerText") or ""
        if project["name"].casefold() in visible.casefold() and project["name"].casefold() in info.get("title", "").casefold() and "/project" in info.get("url", ""):
            break
        time.sleep(0.25)
    else:
        raise RuntimeError("requested Project home was not observed after navigation")
    selected = {"name": project["name"], "action": "Open project home"}

thinking = {"requested": CFG["thinking_level"], "effective_thinking_level": "unknown", "changed": False}
if CFG["thinking_level"] != "default":
    label = {"low": "Low", "medium": "Medium", "high": "High"}[CFG["thinking_level"]]
    level_buttons = []
    deadline = time.time() + 5
    while time.time() < deadline and len(level_buttons) != 1:
        level_buttons = [node for node in _ax_nodes() if node.get("role", {}).get("value") == "button" and node.get("name", {}).get("value") in ("Low", "Medium", "High")]
        if len(level_buttons) != 1:
            time.sleep(0.25)
    if len(level_buttons) == 1:
        current = level_buttons[0].get("name", {}).get("value")
        if current != label:
            _click_exact(current, roles=("button",))
            time.sleep(0.25)
            try:
                _click_exact(label, roles=("button", "menuitem", "option"))
                thinking = {"requested": CFG["thinking_level"], "effective_thinking_level": CFG["thinking_level"], "changed": True}
            except RuntimeError:
                thinking = {"requested": CFG["thinking_level"], "effective_thinking_level": "unknown", "changed": False}
        else:
            thinking = {"requested": CFG["thinking_level"], "effective_thinking_level": CFG["thinking_level"], "changed": False}

existing_hrefs = js("""(() => [...document.querySelectorAll('a[href*="/g/"][href*="/c/"]')].map(a => a.href))()""") or []
composer = _find_composer()
fill_input(composer, CFG["prompt"], clear_first=True)
deadline = time.time() + 5
sent = False
while time.time() < deadline:
    sent = bool(js("""(() => { const button = document.querySelector('button[data-testid="send-button"],button[aria-label="Send prompt"]'); if (!button) return false; const r=button.getBoundingClientRect(); if (!(r.width > 0 && r.height > 0)) return false; button.click(); return true; })()"""))
    if sent: break
    time.sleep(0.1)
if not sent: raise RuntimeError("ChatGPT Send prompt button was not observed after filling composer")
thread_id = _thread_id(existing_hrefs)
print(json.dumps({
    "thread_id": thread_id,
    "conversation_url": page_info().get("url"),
    "selected_project": selected,
    "thinking": thinking,
    "prompt_sent": True,
}, ensure_ascii=False))
