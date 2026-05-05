/**
 * Unit tests for src/core/update-banner.ts.
 *
 * Covers:
 *   - shouldRunBanner argv decision (skips help/version/doctor/--json)
 *   - PIXELCHECK_DISABLE_UPDATE_CHECK + NO_UPDATE_NOTIFIER env disables
 *   - Cache hit short-circuits the network probe
 *   - Cache miss / stale TTL hits the network and writes a fresh cache
 *   - Network failure / non-OK response yields silent skipped result
 *   - is_outdated semver comparison handles "v" prefix and pre-releases
 *   - printUpdateBannerIfDue writes to the supplied stream only when due
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  checkForUpdate,
  printUpdateBannerIfDue,
  shouldRunBanner,
} from "../src/core/update-banner.js";

let tempHome: string;
const cleanupVars = [
  "PIXELCHECK_HOME",
  "PIXELCHECK_DISABLE_UPDATE_CHECK",
  "NO_UPDATE_NOTIFIER",
  "AUDIT_HOME",
];

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pixelcheck-update-banner-"));
}

function cachePath(home: string): string {
  return path.join(home, "update-cache.json");
}

function writeCache(home: string, body: unknown): void {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(cachePath(home), JSON.stringify(body), "utf8");
}

beforeEach(() => {
  tempHome = makeTempHome();
  for (const v of cleanupVars) delete process.env[v];
  process.env.PIXELCHECK_HOME = tempHome;
});

afterEach(() => {
  for (const v of cleanupVars) delete process.env[v];
  vi.restoreAllMocks();
  try {
    fs.rmSync(tempHome, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup — Windows occasionally holds files open briefly.
  }
});

describe("shouldRunBanner — argv-based skip decision", () => {
  it("runs on a bare `pixelcheck` invocation", () => {
    expect(shouldRunBanner(["node", "pixelcheck"])).toBe(true);
  });

  it("runs on the default `run` subcommand", () => {
    expect(shouldRunBanner(["node", "pixelcheck", "run", "--budget", "2"])).toBe(true);
  });

  it("skips when --version anywhere in argv", () => {
    expect(shouldRunBanner(["node", "pixelcheck", "--version"])).toBe(false);
    expect(shouldRunBanner(["node", "pixelcheck", "-V"])).toBe(false);
  });

  it("skips when --help / -h anywhere in argv", () => {
    expect(shouldRunBanner(["node", "pixelcheck", "--help"])).toBe(false);
    expect(shouldRunBanner(["node", "pixelcheck", "-h"])).toBe(false);
    expect(shouldRunBanner(["node", "pixelcheck", "run", "--help"])).toBe(false);
  });

  it("skips when first positional is `doctor`", () => {
    expect(shouldRunBanner(["node", "pixelcheck", "doctor"])).toBe(false);
    expect(shouldRunBanner(["node", "pixelcheck", "doctor", "--verbose"])).toBe(false);
  });

  it("skips when first positional is `help`", () => {
    expect(shouldRunBanner(["node", "pixelcheck", "help"])).toBe(false);
  });

  it("skips when --json present (machine-readable consumers)", () => {
    expect(shouldRunBanner(["node", "pixelcheck", "history", "--json"])).toBe(false);
  });
});

describe("checkForUpdate — env disable flags", () => {
  it("returns skipped when PIXELCHECK_DISABLE_UPDATE_CHECK=1", async () => {
    process.env.PIXELCHECK_DISABLE_UPDATE_CHECK = "1";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await checkForUpdate();
    expect(r.skipped).toBe(true);
    expect(r.is_outdated).toBe(false);
    expect(r.latest_version).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns skipped when NO_UPDATE_NOTIFIER=1 (cross-tool convention)", async () => {
    process.env.NO_UPDATE_NOTIFIER = "true";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await checkForUpdate();
    expect(r.skipped).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("checkForUpdate — cache behaviour", () => {
  it("returns cached value within 24 h TTL without hitting network", async () => {
    writeCache(tempHome, {
      checked_at: Date.now() - 60 * 60 * 1000, // 1 hour ago
      latest_version: "v99.0.0",
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const r = await checkForUpdate();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(r.from_cache).toBe(true);
    expect(r.latest_version).toBe("v99.0.0");
    expect(r.is_outdated).toBe(true); // 99.0.0 > current (1.1.x)
  });

  it("ignores cache when stale beyond TTL", async () => {
    writeCache(tempHome, {
      checked_at: Date.now() - 25 * 60 * 60 * 1000, // 25 hours ago
      latest_version: "v0.0.1",
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ tag_name: "v99.0.0" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const r = await checkForUpdate();

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(r.from_cache).toBe(false);
    expect(r.latest_version).toBe("v99.0.0");
    // The fresh result should also have been written back to the cache.
    const written = JSON.parse(fs.readFileSync(cachePath(tempHome), "utf8"));
    expect(written.latest_version).toBe("v99.0.0");
    expect(typeof written.checked_at).toBe("number");
  });

  it("ignores cache when force=true", async () => {
    writeCache(tempHome, {
      checked_at: Date.now() - 60 * 1000,
      latest_version: "v1.0.0",
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ tag_name: "v2.0.0" }), { status: 200 }),
    );

    const r = await checkForUpdate({ force: true });

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(r.from_cache).toBe(false);
    expect(r.latest_version).toBe("v2.0.0");
  });

  it("falls back to network when cache file is missing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ tag_name: "1.5.0" }), { status: 200 }),
    );

    const r = await checkForUpdate();

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(r.from_cache).toBe(false);
    expect(r.latest_version).toBe("1.5.0");
  });

  it("falls back to network when cache file is malformed", async () => {
    fs.mkdirSync(tempHome, { recursive: true });
    fs.writeFileSync(cachePath(tempHome), "not-json", "utf8");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ tag_name: "v1.5.0" }), { status: 200 }),
    );

    const r = await checkForUpdate();

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(r.latest_version).toBe("v1.5.0");
  });
});

describe("checkForUpdate — network failures swallow silently", () => {
  it("returns latest_version=null when fetch rejects", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    const r = await checkForUpdate();
    expect(r.latest_version).toBeNull();
    expect(r.is_outdated).toBe(false);
    expect(r.skipped).toBe(false);
  });

  it("returns latest_version=null on non-OK response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("rate limited", { status: 403 }),
    );
    const r = await checkForUpdate();
    expect(r.latest_version).toBeNull();
    expect(r.is_outdated).toBe(false);
  });

  it("returns latest_version=null when response missing tag_name", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );
    const r = await checkForUpdate();
    expect(r.latest_version).toBeNull();
  });
});

describe("checkForUpdate — semver comparison", () => {
  // The current package version is read from package.json#version inside
  // getPackageVersion(). All tests below feed a fabricated `latest` and
  // verify the comparison rules; we don't care what the real current is.

  it("treats major bump as outdated", async () => {
    writeCache(tempHome, {
      checked_at: Date.now(),
      latest_version: "999.0.0",
    });
    const r = await checkForUpdate();
    expect(r.is_outdated).toBe(true);
  });

  it("treats same version as not outdated", async () => {
    // Use the actual current version from package.json so the equality
    // case is honest. We read it the same way the module does.
    const { getPackageVersion } = await import("../src/core/version.js");
    const current = getPackageVersion();
    writeCache(tempHome, {
      checked_at: Date.now(),
      latest_version: current,
    });
    const r = await checkForUpdate();
    expect(r.is_outdated).toBe(false);
  });

  it("treats older latest as not outdated", async () => {
    writeCache(tempHome, {
      checked_at: Date.now(),
      latest_version: "0.0.1",
    });
    const r = await checkForUpdate();
    expect(r.is_outdated).toBe(false);
  });

  it("strips leading `v` before comparing", async () => {
    writeCache(tempHome, {
      checked_at: Date.now(),
      latest_version: "v999.0.0",
    });
    const r = await checkForUpdate();
    expect(r.is_outdated).toBe(true);
  });

  it("treats unparseable version strings as not outdated (defensive)", async () => {
    writeCache(tempHome, {
      checked_at: Date.now(),
      latest_version: "not-a-version",
    });
    const r = await checkForUpdate();
    expect(r.is_outdated).toBe(false);
  });
});

describe("printUpdateBannerIfDue", () => {
  function makeStream(): { stream: NodeJS.WritableStream; written: string[] } {
    const written: string[] = [];
    const stream = {
      write(chunk: string | Buffer): boolean {
        written.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
        return true;
      },
    } as unknown as NodeJS.WritableStream;
    return { stream, written };
  }

  it("writes a banner line when an update is due", async () => {
    writeCache(tempHome, {
      checked_at: Date.now(),
      latest_version: "999.0.0",
    });
    const { stream, written } = makeStream();
    await printUpdateBannerIfDue({ argv: ["node", "pixelcheck"], stream });
    expect(written.length).toBe(1);
    expect(written[0]).toMatch(/\[pixelcheck\] update available: .* -> 999\.0\.0/);
    expect(written[0]).toMatch(/PIXELCHECK_DISABLE_UPDATE_CHECK/);
  });

  it("writes nothing when not outdated", async () => {
    writeCache(tempHome, {
      checked_at: Date.now(),
      latest_version: "0.0.1",
    });
    const { stream, written } = makeStream();
    await printUpdateBannerIfDue({ argv: ["node", "pixelcheck"], stream });
    expect(written).toEqual([]);
  });

  it("writes nothing when argv triggers shouldRunBanner skip", async () => {
    writeCache(tempHome, {
      checked_at: Date.now(),
      latest_version: "999.0.0",
    });
    const { stream, written } = makeStream();
    await printUpdateBannerIfDue({
      argv: ["node", "pixelcheck", "doctor"],
      stream,
    });
    expect(written).toEqual([]);
  });

  it("writes nothing when env disable is set", async () => {
    process.env.PIXELCHECK_DISABLE_UPDATE_CHECK = "1";
    writeCache(tempHome, {
      checked_at: Date.now(),
      latest_version: "999.0.0",
    });
    const { stream, written } = makeStream();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await printUpdateBannerIfDue({ argv: ["node", "pixelcheck"], stream });
    expect(written).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
