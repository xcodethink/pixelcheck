/**
 * Recorder Core — pure logic that converts a captured action stream into
 * an AI Browser Auditor scenario YAML.
 *
 * Extracted from the DOM-bound content/background scripts so it can be
 * unit-tested directly in Node.
 */

export type ActionKind =
  | "visit"
  | "click"
  | "fill"
  | "change"
  | "submit"
  | "navigation"
  | "key"
  | "wait";

export interface RecordedAction {
  kind: ActionKind;
  timestamp: number;
  /** URL at the time of the action */
  url: string;
  /** Canonical selector (data-testid > id > aria-label > tagname+text) */
  selector?: string;
  /** Visible text on the clicked element — used to build natural-language instructions */
  label?: string;
  /** Input value (sanitized by the caller to strip PII before storage) */
  value?: string;
  /** Key pressed, for key events */
  key?: string;
  /** Element role (button, link, input…) */
  role?: string;
}

export interface ExportOpts {
  scenario_id: string;
  goal: string;
  persona_id: string;
  /** Drop consecutive click/fill repeats on the same selector */
  dedupe?: boolean;
}

/** Produce a scenario object (pre-YAML) from a raw action log. */
export function compileScenario(actions: RecordedAction[], opts: ExportOpts): Record<string, unknown> {
  const filtered = opts.dedupe !== false ? dedupeConsecutive(actions) : [...actions];
  const steps = toSteps(filtered);
  return {
    id: opts.scenario_id,
    name: opts.goal.slice(0, 60) || opts.scenario_id,
    priority: "P1",
    goal: opts.goal,
    applies_to: { personas: [opts.persona_id] },
    scoring_dimensions: ["completion", "visual_polish", "localization"],
    mode: "scripted",
    steps,
    persistent_storage: false,
  };
}

/** Render the scenario object as YAML — minimal formatter, no dep. */
export function toYaml(scenario: Record<string, unknown>): string {
  return yaml(scenario, 0);
}

// ─────────────────────────────────────────────────────────────
// Step derivation
// ─────────────────────────────────────────────────────────────

export function toSteps(actions: RecordedAction[]): Array<Record<string, unknown>> {
  const steps: Array<Record<string, unknown>> = [];
  let stepIdx = 0;
  const nextId = (prefix: string): string => `${prefix}-${++stepIdx}`;
  const seenUrls = new Set<string>();

  for (const a of actions) {
    if (a.kind === "visit" || a.kind === "navigation") {
      if (!seenUrls.has(a.url)) {
        steps.push({
          id: nextId("visit"),
          type: "visit",
          url: a.url,
          wait_until: "domcontentloaded",
        });
        seenUrls.add(a.url);
      }
      continue;
    }

    if (a.kind === "click") {
      const label = a.label?.trim() || a.role || "element";
      steps.push({
        id: nextId("act"),
        type: "act",
        instruction: buildClickInstruction(label, a.role),
        selector_hint: a.selector,
      });
      continue;
    }

    if (a.kind === "fill" || a.kind === "change") {
      const label = a.label?.trim() || a.role || "field";
      const value = a.value ?? "";
      steps.push({
        id: nextId("act"),
        type: "act",
        instruction: `Type "${value}" into the ${label} field`,
        selector_hint: a.selector,
      });
      continue;
    }

    if (a.kind === "submit") {
      steps.push({
        id: nextId("act"),
        type: "act",
        instruction: "Submit the form",
        selector_hint: a.selector,
      });
      continue;
    }

    if (a.kind === "key") {
      if (a.key === "Enter") {
        steps.push({
          id: nextId("act"),
          type: "act",
          instruction: "Press Enter",
        });
      }
      continue;
    }

    if (a.kind === "wait") {
      steps.push({
        id: nextId("wait"),
        type: "wait_for",
        ms: 1000,
      });
    }
  }

  // End with a visual assertion so the scenario does something besides drive a browser.
  if (steps.length > 0) {
    steps.push({
      id: nextId("visual"),
      type: "assert_visual",
      instruction: "Verify the page looks correct after the recorded flow.",
      dimensions: ["visual_polish", "completion", "localization"],
    });
  }
  return steps;
}

function buildClickInstruction(label: string, role: string | undefined): string {
  if (role === "link") return `Click the "${label}" link`;
  if (role === "button") return `Click the "${label}" button`;
  return `Click ${label}`;
}

export function dedupeConsecutive(actions: RecordedAction[]): RecordedAction[] {
  const out: RecordedAction[] = [];
  for (const a of actions) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.kind === a.kind &&
      prev.selector === a.selector &&
      prev.value === a.value
    ) {
      continue;
    }
    out.push(a);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Selector derivation (used by the content script — exported for tests)
// ─────────────────────────────────────────────────────────────

/**
 * Canonical selector derivation, in priority order:
 *   1. [data-testid="..."]   (deterministic, test-tool convention)
 *   2. #id                   (when id is short + looks stable)
 *   3. [aria-label="..."]
 *   4. text-based fallback:  button:has-text("...")  / a:has-text("...")
 *   5. tag + nth-child under parent
 *
 * In the content script this is called against real DOM elements; here the
 * function is defined in a DOM-independent way so tests can drive it with
 * a minimal element shape.
 */
export interface MinimalElement {
  tagName: string;
  id?: string;
  getAttribute(name: string): string | null;
  textContent?: string;
  parentElement?: MinimalElement | null;
  children?: MinimalElement[];
}

export function deriveSelector(el: MinimalElement): string {
  const testId = el.getAttribute("data-testid") ?? el.getAttribute("data-test-id");
  if (testId) return `[data-testid="${testId}"]`;
  if (el.id && /^[a-z][a-z0-9_-]{1,30}$/i.test(el.id) && !/\d{3,}/.test(el.id)) {
    return `#${el.id}`;
  }
  const aria = el.getAttribute("aria-label");
  if (aria) return `${el.tagName.toLowerCase()}[aria-label="${escapeAttr(aria)}"]`;
  const text = (el.textContent ?? "").trim().slice(0, 40);
  if (text) {
    return `${el.tagName.toLowerCase()}:has-text("${escapeAttr(text)}")`;
  }
  // Fallback: nth-child under parent
  if (el.parentElement && el.parentElement.children) {
    const idx = el.parentElement.children.indexOf(el) + 1;
    return `${el.parentElement.tagName.toLowerCase()} > ${el.tagName.toLowerCase()}:nth-child(${idx})`;
  }
  return el.tagName.toLowerCase();
}

function escapeAttr(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// ─────────────────────────────────────────────────────────────
// Minimal YAML emitter (no dep — extension runtime)
// ─────────────────────────────────────────────────────────────

function yaml(value: unknown, indent: number): string {
  const pad = "  ".repeat(indent);
  if (value === null || value === undefined) return "~";
  if (typeof value === "string") return yamlString(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value
      .map((v) => {
        const childIndent = indent + 1;
        if (v && typeof v === "object" && !Array.isArray(v)) {
          const obj = v as Record<string, unknown>;
          const keys = Object.keys(obj);
          if (keys.length === 0) return `${pad}- {}`;
          const first = keys[0]!;
          const rest = keys.slice(1);
          const firstLine = `${pad}- ${first}: ${yamlInline(obj[first], childIndent + 1)}`;
          const tail = rest
            .map((k) => `${pad}  ${k}: ${yamlInline(obj[k], childIndent + 1)}`)
            .join("\n");
          return tail ? `${firstLine}\n${tail}` : firstLine;
        }
        return `${pad}- ${yamlInline(v, childIndent)}`;
      })
      .join("\n");
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) return "{}";
    return keys.map((k) => `${pad}${k}: ${yamlInline(obj[k], indent + 1)}`).join("\n");
  }
  return String(value);
}

function yamlInline(value: unknown, indent: number): string {
  if (value === null || value === undefined) return "~";
  if (typeof value === "string") return yamlString(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.every((v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")) {
      return `[${value.map((v) => yamlInline(v, indent)).join(", ")}]`;
    }
    return "\n" + yaml(value, indent);
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (Object.keys(obj).length === 0) return "{}";
    return "\n" + yaml(obj, indent);
  }
  return String(value);
}

function yamlString(s: string): string {
  // Quote when the string contains special YAML characters or starts with one.
  if (/^[^\s].*$/.test(s) && !/[:{}\[\]&*!|>'"%@`#\n]|^-\s/.test(s)) {
    return s;
  }
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}
