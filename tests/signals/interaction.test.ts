/**
 * Tests for diffSnapshots + matchInteraction (pure functions — no browser needed).
 *
 * The browser-side snapshot script is covered by fixture-site integration tests.
 */

import { describe, it, expect } from "vitest";
import {
  diffSnapshots,
  matchInteraction,
  type PageSnapshot,
} from "../../src/agent/signals/interaction.js";

function mkSnap(overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: "https://app.example/page",
    title: "Page",
    interactive_hash: "abc",
    interactive_count: 10,
    visible_text_length: 1000,
    scroll_y: 0,
    focused_tag: null,
    taken_at: 100,
    ...overrides,
  };
}

describe("diffSnapshots", () => {
  it("detects url change", () => {
    const d = diffSnapshots(mkSnap(), mkSnap({ url: "https://app.example/other", taken_at: 200 }));
    expect(d.url_changed).toBe(true);
    expect(d.any_change).toBe(true);
    expect(d.duration_ms).toBe(100);
  });

  it("detects interactive DOM change via hash", () => {
    const d = diffSnapshots(mkSnap(), mkSnap({ interactive_hash: "xyz" }));
    expect(d.interactive_changed).toBe(true);
    expect(d.any_change).toBe(true);
  });

  it("reports text_length_delta (positive or negative)", () => {
    const pos = diffSnapshots(mkSnap(), mkSnap({ visible_text_length: 1500 }));
    expect(pos.text_length_delta).toBe(500);
    const neg = diffSnapshots(mkSnap(), mkSnap({ visible_text_length: 800 }));
    expect(neg.text_length_delta).toBe(-200);
  });

  it("any_change=false when nothing differs", () => {
    const d = diffSnapshots(mkSnap(), mkSnap());
    expect(d.any_change).toBe(false);
  });

  it("captures scroll and focus changes", () => {
    const d = diffSnapshots(
      mkSnap(),
      mkSnap({ scroll_y: 500, focused_tag: "input" }),
    );
    expect(d.scroll_changed).toBe(true);
    expect(d.focus_changed).toBe(true);
  });
});

describe("matchInteraction", () => {
  it("passes must_change when any change occurred", () => {
    const sig = diffSnapshots(mkSnap(), mkSnap({ scroll_y: 100 }));
    expect(matchInteraction(sig, { must_change: true }).met).toBe(true);
  });

  it("fails must_change when page is static", () => {
    const sig = diffSnapshots(mkSnap(), mkSnap());
    const r = matchInteraction(sig, { must_change: true });
    expect(r.met).toBe(false);
    expect(r.violations[0]).toMatch(/no observable/);
  });

  it("url_must_change requires URL delta", () => {
    const staticSig = diffSnapshots(mkSnap(), mkSnap({ scroll_y: 50 }));
    expect(matchInteraction(staticSig, { url_must_change: true }).met).toBe(false);
    const navSig = diffSnapshots(mkSnap(), mkSnap({ url: "https://app/other" }));
    expect(matchInteraction(navSig, { url_must_change: true }).met).toBe(true);
  });

  it("min_text_length_delta enforced", () => {
    const sig = diffSnapshots(mkSnap(), mkSnap({ visible_text_length: 1050 }));
    expect(matchInteraction(sig, { min_text_length_delta: 100 }).met).toBe(false);
    expect(matchInteraction(sig, { min_text_length_delta: 40 }).met).toBe(true);
  });

  it("reports multiple violations", () => {
    const sig = diffSnapshots(mkSnap(), mkSnap());
    const r = matchInteraction(sig, {
      must_change: true,
      url_must_change: true,
      interactive_must_change: true,
    });
    expect(r.violations.length).toBeGreaterThanOrEqual(3);
  });
});
