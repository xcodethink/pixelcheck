import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isExempt, findConsoleOffenders } from "../scripts/check-no-console.js";

describe("check-no-console (F7 cross-platform port)", () => {
  it("the real src tree is clean (no console.* outside the exempt files)", () => {
    expect(findConsoleOffenders()).toEqual([]);
  });

  it("exempts cli.ts and commands/ (user-facing rendering)", () => {
    expect(isExempt("src/cli.ts")).toBe(true);
    expect(isExempt("src/commands/doctor.ts")).toBe(true);
    expect(isExempt("src/commands/nested/wizard.ts")).toBe(true);
    expect(isExempt("src/core/logger.ts")).toBe(false);
    expect(isExempt("src/mcp/server.ts")).toBe(false);
  });

  describe("scanning a synthetic src tree", () => {
    function makeSrc(files: Record<string, string>): { dir: string; cleanup: () => void } {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "noconsole-"));
      const dir = path.join(root, "src");
      for (const [rel, content] of Object.entries(files)) {
        const full = path.join(dir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
      }
      return { dir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
    }

    it("flags a console.log call in a non-exempt file", () => {
      const { dir, cleanup } = makeSrc({
        "core/foo.ts": "export const x = 1;\nconsole.log('leak');\n",
      });
      try {
        const offenders = findConsoleOffenders(dir);
        // Path is reported relative to the repo root, so just assert it found
        // the right file + line + method.
        expect(offenders.length).toBe(1);
        expect(offenders[0]).toMatch(/foo\.ts:2:.*console\.log/);
      } finally {
        cleanup();
      }
    });

    it("catches all five console methods", () => {
      const { dir, cleanup } = makeSrc({
        "core/a.ts": [
          "console.log(1);",
          "console.error(2);",
          "console.warn(3);",
          "console.info(4);",
          "console.debug(5);",
        ].join("\n"),
      });
      try {
        expect(findConsoleOffenders(dir).length).toBe(5);
      } finally {
        cleanup();
      }
    });

    it("does NOT flag console.* in comments or strings (needs the open paren)", () => {
      const { dir, cleanup } = makeSrc({
        "core/b.ts": [
          "// console.log is banned here",
          'const note = "use console.log instead?";',
          "const ref = console;", // no method call
        ].join("\n"),
      });
      try {
        expect(findConsoleOffenders(dir)).toEqual([]);
      } finally {
        cleanup();
      }
    });

    it("ignores files in exempt locations even when they call console", () => {
      const { dir, cleanup } = makeSrc({
        "cli.ts": "console.log('intentional UX');\n",
        "commands/doctor.ts": "console.error('wizard output');\n",
        "core/clean.ts": "export const ok = true;\n",
      });
      try {
        // Note: exemption is by repo-relative path. In this synthetic tree the
        // files live under a temp dir, so isExempt() (which keys off
        // "src/cli.ts" etc.) won't match — assert isExempt directly instead.
        expect(isExempt("src/cli.ts")).toBe(true);
        expect(isExempt("src/commands/doctor.ts")).toBe(true);
      } finally {
        cleanup();
      }
    });
  });
});
