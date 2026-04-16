/**
 * Interaction Signal — Measures whether an action actually changed the page state.
 *
 * This defeats the "optimistic success" class of agent failure where the agent
 * reports a click succeeded but nothing happened (button disabled, modal absorbed
 * the click, JS handler errored silently, etc.).
 *
 * Captured deltas between a before/after snapshot:
 * - URL change (navigation happened?)
 * - Title change
 * - Interactive-element set change (count + content hash)
 * - Visible text length delta (new content loaded?)
 * - Scroll position change
 * - Focused element change
 *
 * Zero LLM cost.
 */

import type { Page } from "playwright";
import * as crypto from "node:crypto";

export interface PageSnapshot {
  url: string;
  title: string;
  interactive_hash: string;
  interactive_count: number;
  visible_text_length: number;
  scroll_y: number;
  focused_tag: string | null;
  taken_at: number;
}

export interface InteractionSignal {
  url_changed: boolean;
  title_changed: boolean;
  interactive_changed: boolean;
  /** Absolute count diff between before and after */
  interactive_count_delta: number;
  text_length_delta: number;
  scroll_changed: boolean;
  focus_changed: boolean;
  /** Overall: did ANY observable aspect of the page change? */
  any_change: boolean;
  before: PageSnapshot;
  after: PageSnapshot;
  duration_ms: number;
}

export interface InteractionExpectation {
  /** Require at least one observable change */
  must_change?: boolean;
  /** Require URL to change (navigation expected) */
  url_must_change?: boolean;
  /** Require title to change */
  title_must_change?: boolean;
  /** Require interactive DOM change */
  interactive_must_change?: boolean;
  /** Minimum added visible text length (new content loaded) */
  min_text_length_delta?: number;
}

export interface InteractionMatchResult {
  met: boolean;
  violations: string[];
}

const SNAPSHOT_SCRIPT = `
(() => {
  const els = document.querySelectorAll('a, button, input, select, textarea, [role="button"], [role="link"], [tabindex]');
  const sigs = [];
  let count = 0;
  for (const el of els) {
    count++;
    if (sigs.length < 80) {
      const txt = (el.textContent || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0, 40);
      sigs.push((el.tagName || '') + '#' + (el.id || '') + ':' + txt);
    }
  }
  sigs.sort();
  const visText = (document.body && document.body.innerText ? document.body.innerText : '');
  const active = document.activeElement;
  return {
    url: location.href,
    title: document.title || '',
    interactive_sig: sigs.join('|'),
    interactive_count: count,
    visible_text_length: visText.length,
    scroll_y: window.scrollY || 0,
    focused_tag: active && active !== document.body ? active.tagName.toLowerCase() : null,
  };
})()
`;

export async function takeSnapshot(page: Page): Promise<PageSnapshot> {
  try {
    const raw = await page.evaluate(SNAPSHOT_SCRIPT) as {
      url: string;
      title: string;
      interactive_sig: string;
      interactive_count: number;
      visible_text_length: number;
      scroll_y: number;
      focused_tag: string | null;
    };
    return {
      url: raw.url,
      title: raw.title,
      interactive_hash: hashString(raw.interactive_sig),
      interactive_count: raw.interactive_count,
      visible_text_length: raw.visible_text_length,
      scroll_y: raw.scroll_y,
      focused_tag: raw.focused_tag,
      taken_at: Date.now(),
    };
  } catch {
    return {
      url: "",
      title: "",
      interactive_hash: "",
      interactive_count: 0,
      visible_text_length: 0,
      scroll_y: 0,
      focused_tag: null,
      taken_at: Date.now(),
    };
  }
}

export function diffSnapshots(before: PageSnapshot, after: PageSnapshot): InteractionSignal {
  const url_changed = before.url !== after.url;
  const title_changed = before.title !== after.title;
  const interactive_changed = before.interactive_hash !== after.interactive_hash;
  const interactive_count_delta = after.interactive_count - before.interactive_count;
  const text_length_delta = after.visible_text_length - before.visible_text_length;
  const scroll_changed = before.scroll_y !== after.scroll_y;
  const focus_changed = before.focused_tag !== after.focused_tag;
  const any_change =
    url_changed ||
    title_changed ||
    interactive_changed ||
    scroll_changed ||
    focus_changed ||
    Math.abs(text_length_delta) > 0;
  return {
    url_changed,
    title_changed,
    interactive_changed,
    interactive_count_delta,
    text_length_delta,
    scroll_changed,
    focus_changed,
    any_change,
    before,
    after,
    duration_ms: Math.max(0, after.taken_at - before.taken_at),
  };
}

export function matchInteraction(
  signal: InteractionSignal,
  expected: InteractionExpectation,
): InteractionMatchResult {
  const violations: string[] = [];
  if (expected.must_change && !signal.any_change) {
    violations.push("no observable page change detected");
  }
  if (expected.url_must_change && !signal.url_changed) {
    violations.push("URL did not change");
  }
  if (expected.title_must_change && !signal.title_changed) {
    violations.push("title did not change");
  }
  if (expected.interactive_must_change && !signal.interactive_changed) {
    violations.push("interactive DOM did not change");
  }
  if (
    expected.min_text_length_delta !== undefined &&
    signal.text_length_delta < expected.min_text_length_delta
  ) {
    violations.push(
      `text_length_delta: ${signal.text_length_delta} < ${expected.min_text_length_delta}`,
    );
  }
  return { met: violations.length === 0, violations };
}

function hashString(s: string): string {
  return crypto.createHash("md5").update(s).digest("hex").slice(0, 12);
}
