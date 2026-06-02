import { describe, it, expect } from "vitest";
import { getDashboardHtml } from "../src/observer/dashboard.js";
import { getGridHtml } from "../src/observer/grid-dashboard.js";

// Emoji / pictographic ranges banned by the project no-emoji standard (H8).
// Typographic glyphs like ▸ × … are NOT emoji and are allowed.
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}️]/u;

describe("observer dashboards (G3)", () => {
  describe("getDashboardHtml (live single-session observer)", () => {
    const html = getDashboardHtml();

    it("returns one complete HTML document", () => {
      expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
      expect(html).toContain("<html lang=\"en\">");
      expect(html.trimEnd().endsWith("</html>")).toBe(true);
      expect(html).toContain("<title>PixelCheck - Live Observer</title>");
    });

    it("wires the WebSocket feed + control commands", () => {
      expect(html).toContain("ws://' + location.host + '/ws");
      for (const cmd of ["pause", "resume", "takeover", "release"]) {
        expect(html).toContain(`send('${cmd}')`);
      }
    });

    it("links through to the multi-session grid", () => {
      expect(html).toContain('href="/grid"');
    });

    it("escapes interpolated text (XSS guard on event/action rendering)", () => {
      expect(html).toContain("function escapeHtml");
      expect(html).toContain("&amp;");
      expect(html).toContain("&lt;");
    });

    it("contains no emoji (no-emoji standard, H8)", () => {
      expect(EMOJI.test(html)).toBe(false);
    });
  });

  describe("getGridHtml (multi-session grid)", () => {
    const html = getGridHtml();

    it("returns one complete HTML document", () => {
      expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
      expect(html).toContain("<html lang=\"en\">");
      expect(html.trimEnd().endsWith("</html>")).toBe(true);
      expect(html).toContain("PixelCheck");
    });

    it("polls the grid API to refresh tiles", () => {
      expect(html).toContain("/api/grid");
    });

    it("contains no emoji (no-emoji standard, H8)", () => {
      expect(EMOJI.test(html)).toBe(false);
    });
  });

  it("the two dashboards are distinct documents", () => {
    expect(getDashboardHtml()).not.toBe(getGridHtml());
  });
});
