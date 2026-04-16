import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Exclude nested git worktrees so `npm test` doesn't double-count their
    // test files. Worktrees live under .claude/worktrees/ by convention.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/worktrees/**"],
  },
});
