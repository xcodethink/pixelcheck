// Popup — start/stop recording, preview + download the compiled YAML.
// The compile + YAML logic is duplicated inline (simplified) so the popup
// doesn't require a bundler. The authoritative version lives at
// extensions/scenario-recorder/src/recorder-core.ts and is unit-tested.

async function send(type, payload) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

function toSteps(actions) {
  const steps = [];
  let idx = 0;
  const nextId = (p) => p + "-" + (++idx);
  const seen = new Set();
  for (const a of actions) {
    if (a.kind === "visit" || a.kind === "navigation") {
      if (!seen.has(a.url)) {
        steps.push({ id: nextId("visit"), type: "visit", url: a.url, wait_until: "domcontentloaded" });
        seen.add(a.url);
      }
      continue;
    }
    if (a.kind === "click") {
      const label = (a.label || a.role || "element").trim();
      const instruction = a.role === "link" ? `Click the "${label}" link`
                       : a.role === "button" ? `Click the "${label}" button`
                       : `Click ${label}`;
      steps.push({ id: nextId("act"), type: "act", instruction, selector_hint: a.selector });
      continue;
    }
    if (a.kind === "fill" || a.kind === "change") {
      const label = (a.label || a.role || "field").trim();
      steps.push({ id: nextId("act"), type: "act", instruction: `Type "${a.value || ""}" into the ${label} field`, selector_hint: a.selector });
      continue;
    }
    if (a.kind === "submit") {
      steps.push({ id: nextId("act"), type: "act", instruction: "Submit the form", selector_hint: a.selector });
    }
  }
  if (steps.length > 0) {
    steps.push({ id: nextId("visual"), type: "assert_visual", instruction: "Verify the page after the recorded flow.", dimensions: ["visual_polish", "completion", "localization"] });
  }
  return steps;
}

function dedupe(actions) {
  const out = [];
  for (const a of actions) {
    const p = out[out.length - 1];
    if (p && p.kind === a.kind && p.selector === a.selector && p.value === a.value) continue;
    out.push(a);
  }
  return out;
}

function yamlString(s) {
  if (/^[^\s].*$/.test(s) && !/[:{}\[\]&*!|>'"%@`#\n]|^-\s/.test(s)) return s;
  return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';
}
function yamlVal(v, indent) {
  if (v === null || v === undefined) return "~";
  if (typeof v === "string") return yamlString(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    if (v.every((x) => typeof x === "string" || typeof x === "number" || typeof x === "boolean")) {
      return "[" + v.map((x) => yamlVal(x, indent)).join(", ") + "]";
    }
    const pad = "  ".repeat(indent);
    return "\n" + v.map((x) => {
      if (x && typeof x === "object" && !Array.isArray(x)) {
        const keys = Object.keys(x);
        return keys.map((k, i) => (i === 0 ? pad + "- " : pad + "  ") + k + ": " + yamlVal(x[k], indent + 2)).join("\n");
      }
      return pad + "- " + yamlVal(x, indent);
    }).join("\n");
  }
  if (typeof v === "object") {
    const keys = Object.keys(v);
    if (keys.length === 0) return "{}";
    const pad = "  ".repeat(indent);
    return "\n" + keys.map((k) => pad + k + ": " + yamlVal(v[k], indent + 1)).join("\n");
  }
  return String(v);
}
function toYaml(obj) {
  return Object.keys(obj).map((k) => k + ": " + yamlVal(obj[k], 1)).join("\n") + "\n";
}

function compile() {
  return send("get").then((resp) => {
    const actions = dedupe(resp.actions || []);
    const scenario = {
      id: document.getElementById("scenarioId").value.trim() || "recorded-scenario",
      name: (document.getElementById("goal").value.trim() || "Recorded scenario").slice(0, 60),
      priority: "P1",
      goal: document.getElementById("goal").value.trim() || "Recorded scenario",
      applies_to: { personas: [document.getElementById("personaId").value.trim() || "us-desktop-pro"] },
      scoring_dimensions: ["completion", "visual_polish", "localization"],
      mode: "scripted",
      steps: toSteps(actions),
      persistent_storage: false,
    };
    return toYaml(scenario);
  });
}

async function refreshStatus() {
  const resp = await send("get");
  const count = (resp.actions || []).length;
  const storage = await chrome.storage.local.get(["__AV_RECORDING__"]);
  const on = !!storage.__AV_RECORDING__;
  document.getElementById("status").textContent = (on ? "● recording" : "○ stopped") + " — " + count + " actions";
}

document.getElementById("btnStart").onclick = async () => {
  await send("toggle", { on: true });
  refreshStatus();
};
document.getElementById("btnStop").onclick = async () => {
  await send("toggle", { on: false });
  refreshStatus();
};
document.getElementById("btnClear").onclick = async () => {
  await send("clear");
  refreshStatus();
  document.getElementById("preview").textContent = "";
};
document.getElementById("btnExport").onclick = async () => {
  const yaml = await compile();
  document.getElementById("preview").textContent = yaml;
  const blob = new Blob([yaml], { type: "text/yaml" });
  const url = URL.createObjectURL(blob);
  const scenarioId = document.getElementById("scenarioId").value.trim() || "recorded-scenario";
  const a = document.createElement("a");
  a.href = url;
  a.download = scenarioId + ".yaml";
  a.click();
  URL.revokeObjectURL(url);
};
document.getElementById("btnCopy").onclick = async () => {
  const yaml = await compile();
  document.getElementById("preview").textContent = yaml;
  try { await navigator.clipboard.writeText(yaml); } catch (e) { /* ignore */ }
};

refreshStatus();
