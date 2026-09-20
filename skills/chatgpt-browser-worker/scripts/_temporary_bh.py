import atexit
import json
import os
import re
import time

from browser_harness import *


CFG = json.load(open("__CFG_PATH__", encoding="utf-8"))
_OWNED_TABS = []
_KEEP_OWNED_TAB_OPEN = CFG.get("close_policy", "after-start") == "never"


def _new_owned_tab(url):
    target_id = cdp("Target.createTarget", url="about:blank", background=True)["targetId"]
    switch_tab(target_id)
    _OWNED_TABS.append(target_id)
    if url != "about:blank":
        goto_url(url)
    return target_id


def _close_owned_tabs():
    if _KEEP_OWNED_TAB_OPEN:
        return
    while _OWNED_TABS:
        try:
            close_tab(_OWNED_TABS.pop())
        except Exception:
            pass


atexit.register(_close_owned_tabs)


def _composer():
    selector = js("""(() => {
      const preferred = document.querySelector('#prompt-textarea');
      if (preferred) {
        const r=preferred.getBoundingClientRect();
        if (r.width>0 && r.height>0) return '#prompt-textarea';
      }
      const fallback = [...document.querySelectorAll('textarea,[contenteditable="true"]')]
        .find(e => { const r=e.getBoundingClientRect(); return r.width>0 && r.height>0 && !e.disabled; });
      if (!fallback) return null;
      return fallback.tagName === 'TEXTAREA' ? 'textarea' : '[contenteditable="true"]';
    })()""")
    if not selector:
        raise RuntimeError("Temporary Chat composer was not observed")
    return selector


def _composer_text(selector):
    return js(f"""(() => {{
      const e=document.querySelector({json.dumps(selector)});
      return e ? ((e.innerText ?? e.value) || '') : '';
    }})()""") or ""


def _wait_for_composer(timeout=30):
    def read_selector():
        try:
            return _composer()
        except RuntimeError:
            return None

    return wait_until_stable(
        lambda: {"selector": read_selector()},
        lambda state: bool(state["selector"]),
        timeout=timeout,
        phase="composer readiness",
    )["selector"]


def _same_text(observed, expected):
    normalize = lambda value: re.sub(r"\\s+", " ", value or "").strip()
    return normalize(expected) in normalize(observed)


def _normalized_text(value):
    return re.sub(r"\s+", " ", value or "").strip()


def _attachment_names():
    return js(r"""(() => [...document.querySelectorAll('button[aria-label^="Remove file"]')]
      .map(b => (b.getAttribute('aria-label') || '').replace(/^Remove file\s+\d+:\s*/, ''))
      .filter(Boolean))()""") or []


def _attachment_state():
    return js(r"""(() => {
      const names = [...document.querySelectorAll('button[aria-label^="Remove file"]')]
        .map(b => (b.getAttribute('aria-label') || '').replace(/^Remove file\s+\d+:\s*/, ''))
        .filter(Boolean);
      const pending = [...document.querySelectorAll(
        '[role="progressbar"], [aria-busy="true"], [data-state="loading"]'
      )].some(e => {
        const r=e.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      return {names, pending};
    })()""") or {"names": [], "pending": True}


def _send_state():
    return js(r"""(() => {
      const b=document.querySelector('button[data-testid="send-button"],button[aria-label="Send prompt"]');
      return {present: !!b, enabled: !!b && !b.disabled && b.getAttribute('aria-disabled') !== 'true'};
    })()""") or {"present": False, "enabled": False}


def _wait_for_attachments(expected, timeout=45):
    expected = set(expected)
    wait_until_stable(
        _attachment_state,
        lambda state: expected.issubset(state["names"]) and not state["pending"],
        timeout=timeout,
        phase="attachment upload readiness",
    )


def _upload_files(paths):
    if not paths:
        return []
    selector = js("""(() => {
      for (const s of ['#upload-files','#upload-media','input[name="upload-media"]','input[type="file"]'])
        if (document.querySelector(s)) return s;
      return null;
    })()""")
    if not selector:
        raise RuntimeError("ChatGPT file input was not observed")
    for path in paths:
        if not os.path.isfile(path):
            raise RuntimeError(f"attachment does not exist: {path}")
        upload_file(selector, path)
    expected = [os.path.basename(path) for path in paths]
    if expected:
        # Presence is a selection signal; upload readiness is checked separately.
        wait_until_stable(
            _attachment_state,
            lambda state: set(expected).issubset(state["names"]),
            timeout=30,
            phase="attachment presence",
        )
        _wait_for_attachments(expected)
    return expected


def _user_turns():
    return js("""(() => [...document.querySelectorAll('[data-message-author-role="user"]')]
      .map(e => ({text:e.innerText.trim(), id:e.getAttribute('data-message-id') || ''}))
      .filter(e => e.text))()""") or []


def _click_send():
    ok = js("""(() => {
      const b=document.querySelector('button[data-testid="send-button"],button[aria-label="Send prompt"]');
      if (!b || b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
      b.click(); return true;
    })()""")
    if not ok:
        raise RuntimeError("Temporary Chat send readiness changed before click")


def _wait_for_send_ready(selector, prompt, attachments):
    expected = set(attachments)

    def read_state():
        return {
            "text": _composer_text(selector),
            "attachments": _attachment_state(),
            "send": _send_state(),
        }

    wait_until_stable(
        read_state,
        lambda state: (
            _normalized_text(prompt) in _normalized_text(state["text"])
            and expected.issubset(state["attachments"]["names"])
            and not state["attachments"]["pending"]
            and state["send"]["enabled"]
        ),
        timeout=45 if expected else 15,
        phase="send readiness",
    )


def _wait_user_turn(before_count, prompt, timeout=20):
    deadline = time.time() + timeout
    while time.time() < deadline:
        turns = _user_turns()
        for turn in turns[before_count:]:
            if _normalized_text(prompt) in _normalized_text(turn["text"]):
                return turn
        time.sleep(.25)
    raise RuntimeError("Temporary Chat submission verification did not observe a new user turn")


def _diagnostic_thread_id():
    match = re.search(r"/c/([^/?#]+)", page_info().get("url", ""))
    return match.group(1) if match else None


_new_owned_tab("https://chatgpt.com/")
wait_for_load()

enabled = js("""(() => {
  const matches=[...document.querySelectorAll('button')].filter(
    b => (b.getAttribute('aria-label') || '').trim() === 'Temporary chat'
  );
  if (matches.length !== 1) return false;
  matches[0].click();
  return true;
})()""")
if not enabled:
    raise RuntimeError("Temporary Chat toggle was not uniquely observed")

deadline = time.time() + 20
while time.time() < deadline:
    if "temporary-chat=true" in page_info().get("url", ""):
        try:
            break
        except RuntimeError:
            pass
    time.sleep(.25)
else:
    raise RuntimeError("Temporary Chat composer readiness was not observed")

attachments = _upload_files(CFG.get("file", []))
selector = _wait_for_composer()
before_count = len(_user_turns())
prompt = CFG["prompt"]
is_contenteditable = bool(js(f"""(() => {{
  const e=document.querySelector({json.dumps(selector)});
  return !!e && e.getAttribute('contenteditable') === 'true';
}})()"""))
if is_contenteditable:
    cleared = js(f"""(() => {{
      const e=document.querySelector({json.dumps(selector)});
      if (!e) return false;
      e.focus();
      const sel=window.getSelection();
      const range=document.createRange();
      range.selectNodeContents(e);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('delete', false, null);
      return true;
    }})()""")
    if not cleared:
        raise RuntimeError("Temporary Chat contenteditable composer could not be cleared")
    for offset in range(0, len(prompt), 256):
        chunk = prompt[offset:offset + 256]
        inserted = js(f"""(() => {{
          const e=document.querySelector({json.dumps(selector)});
          if (!e) return false;
          e.focus();
          const ok=document.execCommand('insertText', false, {json.dumps(chunk)});
          e.dispatchEvent(new InputEvent('input', {{bubbles:true,inputType:'insertText',data:{json.dumps(chunk)}}}));
          return ok;
        }})()""")
        if not inserted:
            raise RuntimeError(f"Temporary Chat composer rejected prompt chunk at offset {offset}")
else:
    fill_input(selector, prompt, clear_first=True)

wait_until_stable(
    lambda: {"text": _composer_text(selector)},
    lambda state: _normalized_text(CFG["prompt"]) in _normalized_text(state["text"]),
    timeout=30,
    phase="composer readiness",
)

_wait_for_send_ready(selector, CFG["prompt"], attachments)
_click_send()
user_turn = _wait_user_turn(before_count, CFG["prompt"])

print(json.dumps({
    "operation": "submit",
    "status": "submitted",
    "temporary": True,
    "attachments": attachments,
    "diagnostic_thread_id": _diagnostic_thread_id(),
    "user_message_id": user_turn.get("id") or None,
    "verified": True,
}, ensure_ascii=False), flush=True)

# Keep the owned Temporary Chat tab alive until Relay observes the worker's
# post-launch task.started acknowledgement.  The parent releases this file;
# atexit then closes only this worker-owned tab.
release_file = CFG.get("release_file")
if not release_file:
    raise RuntimeError("worker release file was not configured")
if CFG.get("close_policy", "after-start") == "never":
    raise SystemExit(0)
while not os.path.exists(release_file):
    time.sleep(.1)
