import json
import time

from browser_harness import *


CFG = json.load(open("__CFG_PATH__", encoding="utf-8"))
THREAD_ID = CFG["thread_id"]


def _ax_nodes():
    return cdp("Accessibility.getFullAXTree").get("nodes", [])


def _composer():
    selector = js("""(() => {
      const nodes = [...document.querySelectorAll('textarea,[contenteditable="true"]')];
      const node = nodes.find(e => { const r = e.getBoundingClientRect(); return r.width && r.height && !e.disabled; });
      if (!node) return null;
      if (node.id) return '#' + CSS.escape(node.id);
      if (node.getAttribute('aria-label')) return `${node.tagName.toLowerCase()}[aria-label=${JSON.stringify(node.getAttribute('aria-label'))}]`;
      return node.tagName === 'TEXTAREA' ? 'textarea' : 'div[contenteditable="true"]';
    })()""")
    if not selector:
        raise RuntimeError("ChatGPT composer was not observed")
    return selector


def _assistant_messages():
    return js("""(() => [...document.querySelectorAll('[data-message-author-role="assistant"]')]
      .map(e => ({text: e.innerText.trim(), id: e.getAttribute('data-message-id') || ''}))
      .filter(e => e.text))()""") or []


def _is_generating():
    return bool(js('!!document.querySelector(\'button[aria-label*="Stop" i],button[data-testid*="stop" i]\')'))


def _click_accessible(name, prefer_rightmost=False):
    visible = []
    info = page_info()
    for node in _ax_nodes():
        if node.get("name", {}).get("value") != name:
            continue
        backend_id = node.get("backendDOMNodeId")
        if not backend_id:
            continue
        try:
            box = cdp("DOM.getBoxModel", backendNodeId=backend_id).get("model", {}).get("content")
        except Exception:
            continue
        if not box:
            continue
        x, y = sum(box[0::2]) / 4, sum(box[1::2]) / 4
        if 0 <= x <= info.get("w", 0) and 0 <= y <= info.get("h", 0):
            visible.append((x, y))
    if not visible:
        raise RuntimeError(f"expected a visible accessible {name!r}, found 0")
    if len(visible) > 1 and not prefer_rightmost:
        raise RuntimeError(f"expected one visible accessible {name!r}, found {len(visible)}")
    click_at_xy(*(max(visible, key=lambda point: point[0]) if prefer_rightmost else visible[0]))


def _stable_assistant_result(delay=0.75):
    if _is_generating():
        return None
    first = _assistant_messages()
    if not first:
        return None
    candidate = first[-1]
    time.sleep(delay)
    if _is_generating():
        return None
    second = _assistant_messages()
    if not second:
        return None
    latest = second[-1]
    if latest.get("id") != candidate.get("id") or latest.get("text") != candidate.get("text"):
        return None
    return latest



def _wait_stable_assistant_result(timeout=15.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        message = _stable_assistant_result(delay=0.5)
        if message:
            return message
        time.sleep(0.25)
    return None


def _wait_for_requested_thread(timeout=12.0):
    deadline = time.time() + timeout
    last_url = ""
    while time.time() < deadline:
        info = page_info()
        last_url = info.get("url", "")
        body = js("document.body.innerText") or ""
        title = info.get("title", "")
        if f"/c/{THREAD_ID}" in last_url and (CFG["project"].casefold() in body.casefold() or CFG["project"].casefold() in title.casefold()):
            return body
        time.sleep(0.25)
    raise RuntimeError(f"requested Project/thread was not observed after navigation: {last_url}")

def _cleanup():
    """Delete exactly the requested durable thread and verify disappearance."""
    url = page_info().get("url", "")
    if f"/c/{THREAD_ID}" not in url:
        raise RuntimeError("browser is not on the requested durable thread")
    body = js("document.body.innerText") or ""
    if CFG["project"].casefold() not in body.casefold() and CFG["project"].casefold() not in page_info().get("title", "").casefold():
        lower_body = body.lower()
        missing_markers = ("conversation not found", "conversation doesn't exist", "conversation does not exist", "page not found")
        if any(marker in lower_body for marker in missing_markers):
            return {"thread_id": THREAD_ID, "outcome": "not_found", "verified": True, "url_after": url, "reason": "thread was not observable"}
        raise RuntimeError("requested thread could not be verified; refusing cleanup")

    opened = js("""(() => {
      const buttons = [...document.querySelectorAll('button[aria-label="More"]')].filter(button => {
        const r = button.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight;
      });
      if (buttons.length !== 1) return false;
      buttons[0].click();
      return true;
    })()""")
    if not opened:
        raise RuntimeError("thread actions menu was not uniquely observed")
    time.sleep(0.2)
    selected = js("""(() => {
      const items = [...document.querySelectorAll('[role="menuitem"]')].filter(item => (item.textContent || '').trim() === 'Delete');
      if (items.length !== 1) return false;
      items[0].click();
      return true;
    })()""")
    if not selected:
        raise RuntimeError("ChatGPT delete action was not uniquely observed")

    deadline = time.time() + 5
    confirmed = False
    while time.time() < deadline:
        confirmed = bool(js("""(() => {
          const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(dialog => (dialog.textContent || '').includes('Delete chat?'));
          if (dialogs.length !== 1) return false;
          const buttons = [...dialogs[0].querySelectorAll('button')].filter(button => (button.textContent || '').trim() === 'Delete');
          if (buttons.length !== 1) return false;
          buttons[0].click();
          return true;
        })()"""))
        if confirmed:
            break
        time.sleep(0.2)
    if not confirmed:
        raise RuntimeError("ChatGPT delete confirmation was not observed")

    deadline = time.time() + 8
    while time.time() < deadline:
        after_url = page_info().get("url", "")
        after_body = js("document.body.innerText") or ""
        if f"/c/{THREAD_ID}" not in after_url or "Undo" in after_body:
            return {"thread_id": THREAD_ID, "outcome": "deleted", "verified": True, "url_after": after_url, "undo_visible": "Undo" in after_body, "archive_visible": "Archive" in after_body}
        time.sleep(0.25)
    raise RuntimeError("requested thread is still observable after delete")


ensure_real_tab()
target = f"https://chatgpt.com/c/{THREAD_ID}"
if f"/c/{THREAD_ID}" not in page_info().get("url", ""):
    new_tab(target)
    wait_for_load()
body = _wait_for_requested_thread()
operation = CFG["operation"]
if operation == "delete":
    print(json.dumps(_cleanup(), ensure_ascii=False))
    raise SystemExit

base = {"thread_id": THREAD_ID, "conversation_url": page_info().get("url"), "project": {"name": CFG["project"]}}
if operation == "continue":
    fill_input(_composer(), CFG["prompt"], clear_first=True)
    time.sleep(0.1)
    _click_accessible("Send prompt")
    print(json.dumps({**base, "prompt_sent": True}, ensure_ascii=False))
elif operation == "status":
    messages = _assistant_messages()
    stable = _stable_assistant_result()
    status = "completed" if stable else ("running" if _is_generating() or messages else "awaiting_result")
    print(json.dumps({**base, "status": status, "assistant_message_count": len(messages)}, ensure_ascii=False))
elif operation == "result":
    message = _wait_stable_assistant_result()
    if not message:
        raise RuntimeError("ChatGPT assistant result was not observed stable and final before timeout")
    if not message["id"]:
        raise RuntimeError("assistant result had no observed message id")
    print(json.dumps({**base, "status": "completed", "text": message["text"], "message_id": message["id"]}, ensure_ascii=False))
else:
    print(json.dumps({**base, "status": "completed" if _assistant_messages() else "awaiting_result"}, ensure_ascii=False))
