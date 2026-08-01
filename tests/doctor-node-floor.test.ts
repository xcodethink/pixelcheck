import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { _MIN_NODE_MAJOR_FOR_TESTS } from "../src/commands/doctor.js";

/**
 * `doctor` and `package.json` must agree on the minimum Node version.
 *
 * They did not. `doctor` accepted Node 18 and printed "(>= 18 required)" while
 * `engines.node` said `>=20.0.0` — so the health check whose whole job is to
 * tell a user whether their environment will work told them it would, on a
 * runtime the package does not support and CI does not test.
 *
 * That drift is invisible to every other gate: both numbers are internally
 * consistent, nothing fails, and the disagreement only surfaces as a confusing
 * failure for whoever is on the older runtime. So it is pinned here.
 */

describe("doctor's Node floor", () => {
  it("matches engines.node in package.json", () => {
    const pkg = JSON.parse(
      fs.readFileSync(
        path.resolve(import.meta.dirname, "../package.json"),
        "utf8",
      ),
    ) as { engines?: { node?: string } };

    const declared = pkg.engines?.node;
    expect(declared, "package.json must declare engines.node").toBeDefined();

    const match = declared!.match(/(\d+)/);
    expect(match, `could not read a major version from "${declared}"`).not.toBeNull();

    expect(
      _MIN_NODE_MAJOR_FOR_TESTS,
      `doctor accepts Node ${_MIN_NODE_MAJOR_FOR_TESTS}+ but package.json declares "${declared}". ` +
        "A user on a version between the two is told their environment is fine and then hits failures.",
    ).toBe(Number(match![1]));
  });
});
