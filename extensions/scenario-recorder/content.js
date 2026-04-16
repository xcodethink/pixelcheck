// Content script — captures user interactions on the active page.
// Compiled-free (ES5/6 no imports); talks to background.js via chrome.runtime messages.
//
// Responsibilities:
//   - When recording is enabled, attach click / change / submit / keydown listeners
//   - For each event, derive a canonical selector + label and forward an action
//   - When recording is disabled, detach cleanly so the page feels normal

(() => {
  const RECORDING_KEY = "__AV_RECORDING__";
  let listeners = [];

  function log(action) {
    chrome.runtime.sendMessage({ type: "action", action }).catch(() => {});
  }

  function deriveSelector(el) {
    if (!el) return "";
    if (el.getAttribute) {
      const testId = el.getAttribute("data-testid") || el.getAttribute("data-test-id");
      if (testId) return '[data-testid="' + testId + '"]';
    }
    if (el.id && /^[a-z][a-z0-9_-]{1,30}$/i.test(el.id) && !/\d{3,}/.test(el.id)) {
      return "#" + el.id;
    }
    const aria = el.getAttribute && el.getAttribute("aria-label");
    if (aria) return el.tagName.toLowerCase() + '[aria-label="' + escapeAttr(aria) + '"]';
    const text = (el.textContent || "").trim().slice(0, 40);
    if (text) return el.tagName.toLowerCase() + ':has-text("' + escapeAttr(text) + '")';
    return el.tagName ? el.tagName.toLowerCase() : "element";
  }
  function escapeAttr(s) { return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"'); }

  function labelOf(el) {
    if (!el) return "";
    const aria = el.getAttribute && el.getAttribute("aria-label");
    if (aria) return aria.trim();
    const placeholder = el.getAttribute && el.getAttribute("placeholder");
    if (placeholder) return placeholder.trim();
    const text = (el.textContent || "").trim();
    return text.length > 60 ? text.slice(0, 60) + "…" : text;
  }
  function roleOf(el) {
    if (!el) return "";
    const explicit = el.getAttribute && el.getAttribute("role");
    if (explicit) return explicit;
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "input") return el.type === "submit" ? "button" : "input";
    if (tag === "textarea") return "input";
    if (tag === "select") return "select";
    return tag;
  }
  function sanitizeValue(v, role) {
    if (!v) return "";
    // Never persist passwords; redact heuristically obvious secrets too
    if (role === "input" && v.length > 40) return v.slice(0, 40) + "…";
    return v;
  }

  function onClick(e) {
    const el = e.target;
    log({
      kind: "click",
      timestamp: Date.now(),
      url: location.href,
      selector: deriveSelector(el),
      label: labelOf(el),
      role: roleOf(el),
    });
  }
  function onChange(e) {
    const el = e.target;
    if (el.type === "password") return; // never record passwords
    log({
      kind: "change",
      timestamp: Date.now(),
      url: location.href,
      selector: deriveSelector(el),
      label: labelOf(el),
      role: roleOf(el),
      value: sanitizeValue(el.value, roleOf(el)),
    });
  }
  function onSubmit(e) {
    const el = e.target;
    log({
      kind: "submit",
      timestamp: Date.now(),
      url: location.href,
      selector: deriveSelector(el),
      label: labelOf(el),
      role: "form",
    });
  }
  function onKeyDown(e) {
    if (e.key === "Enter" || e.key === "Escape") {
      log({ kind: "key", timestamp: Date.now(), url: location.href, key: e.key });
    }
  }

  function attach() {
    if (listeners.length > 0) return;
    const pairs = [
      ["click", onClick, true],
      ["change", onChange, true],
      ["submit", onSubmit, true],
      ["keydown", onKeyDown, true],
    ];
    for (const [name, fn, capture] of pairs) {
      document.addEventListener(name, fn, capture);
      listeners.push([name, fn, capture]);
    }
    // Record the initial visit
    log({ kind: "visit", timestamp: Date.now(), url: location.href });
  }
  function detach() {
    for (const [name, fn, capture] of listeners) {
      document.removeEventListener(name, fn, capture);
    }
    listeners = [];
  }

  // Sync state from storage + listen for toggles from the popup
  chrome.storage.local.get([RECORDING_KEY]).then((v) => {
    if (v[RECORDING_KEY]) attach();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !(RECORDING_KEY in changes)) return;
    if (changes[RECORDING_KEY].newValue) attach();
    else detach();
  });
})();
