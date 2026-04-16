// Service worker — collects actions across tabs and handles export.

const ACTIONS_KEY = "__AV_ACTIONS__";
const RECORDING_KEY = "__AV_RECORDING__";

async function getActions() {
  const v = await chrome.storage.local.get([ACTIONS_KEY]);
  return v[ACTIONS_KEY] || [];
}
async function setActions(actions) {
  await chrome.storage.local.set({ [ACTIONS_KEY]: actions });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg.type === "action") {
      const list = await getActions();
      list.push(msg.action);
      if (list.length > 500) list.shift(); // cap buffer
      await setActions(list);
      sendResponse({ ok: true, count: list.length });
      return;
    }
    if (msg.type === "clear") {
      await setActions([]);
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "get") {
      sendResponse({ actions: await getActions() });
      return;
    }
    if (msg.type === "toggle") {
      const on = !!msg.on;
      await chrome.storage.local.set({ [RECORDING_KEY]: on });
      if (on) await setActions([]); // fresh session when starting
      sendResponse({ on });
      return;
    }
    sendResponse({ error: "unknown message type" });
  })();
  return true; // async sendResponse
});

// Track full navigations so the scenario includes "visit" steps when the
// URL changes without a click (SPA push state / hard nav).
chrome.webNavigation?.onCommitted?.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const v = await chrome.storage.local.get([RECORDING_KEY]);
  if (!v[RECORDING_KEY]) return;
  const list = await getActions();
  const last = list[list.length - 1];
  if (last && last.url === details.url && last.kind === "navigation") return;
  list.push({ kind: "navigation", timestamp: Date.now(), url: details.url });
  await setActions(list);
});
