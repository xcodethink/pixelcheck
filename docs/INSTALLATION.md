# Installation Guide

This guide covers `pixelcheck` installation across platforms,
container scenarios, and enterprise / air-gapped environments.

For the **5-minute happy path**, see the [Quick Start in README](../README.md#quick-start).
For **troubleshooting**, jump to the [Common errors](#common-install-errors--fixes) section.

---

## Table of contents

- [System requirements](#system-requirements)
- [Standard install](#standard-install-macos--linux--windows)
- [Per-platform prereqs](#per-platform-prereqs)
  - [macOS (Intel + Apple Silicon)](#macos-intel--apple-silicon)
  - [Linux (Ubuntu / Debian)](#linux-ubuntu--debian)
  - [Linux (Alpine, including Docker `node:*-alpine`)](#linux-alpine-including-docker-nodealpine)
  - [Windows (PowerShell or Git Bash)](#windows-powershell-or-git-bash)
  - [WSL2](#wsl2)
- [Docker](#docker)
- [Corporate proxy / firewall environments](#corporate-proxy--firewall-environments)
- [Air-gapped install](#air-gapped-install)
- [Common install errors + fixes](#common-install-errors--fixes)
- [Verifying your install](#verifying-your-install)

---

## System requirements

| Resource | Minimum | Recommended | Why |
|---|---|---|---|
| **Node.js** | 20.0.0 (Active LTS) | 20.x or 22.x | declared in `package.json > engines.node` (npm warns on older; the toolchain requires 20+ and 18 is untested) |
| **npm** | 9.0.0 | latest bundled with Node 20+ | `package.json > engines.npm` |
| **OS** | macOS 13 / Ubuntu 20.04 / Windows 10 / Alpine 3.18 | latest stable | Chromium prebuilt binaries available |
| **CPU** | x64 or arm64 | — | `package.json > cpu: ["x64", "arm64"]` |
| **Disk space** | ~500 MB | 1 GB | node_modules (~280 MB) + Chromium runtime (~200 MB) |
| **RAM** | 2 GB free | 4 GB free | Chromium spawn + audit pipeline |
| **Network** | HTTPS to api.anthropic.com + npmjs.org + cdn.playwright.dev | — | npm install + Chromium download + Claude API |

**Tier-1 platforms** (CI-tested every PR via the 8-config matrix):

- ubuntu-latest × Node 20 / 22
- macos-13 (Intel x64) × Node 20 / 22
- macos-14 (Apple Silicon arm64) × Node 20 / 22
- windows-latest × Node 20 / 22 — **non-blocking** (`continue-on-error`):
  the Windows configs run every PR and results are visible, but a Windows
  failure does not gate merges while a few cross-process test races
  (`mcp-stdio-e2e`, `mcp-concurrency-e2e`) are investigated. `package.json`
  still lists `win32` as a supported `os`.

**Tier-2** (best-effort, may need manual prereq install — see below):

- Alpine Linux (musl libc) — needs build deps for native compile
- Linux ARM64 — needs prebuilt or fallback to source compile
- WSL2 — works as Linux, but file-system performance varies

---

## Standard install (macOS / Linux / Windows)

### As a project dependency

```bash
npm install pixelcheck
```

### As a one-shot CLI

```bash
npx pixelcheck run
```

### Globally

```bash
npm install -g pixelcheck
pixelcheck run
```

After install, run `npx pixelcheck doctor` (T23 task — coming
in v1.0) to verify your environment.

---

## Per-platform prereqs

### macOS (Intel + Apple Silicon)

Out of the box on macOS 13+:

- **Node.js 20+**: install via [Node.js LTS installer](https://nodejs.org/) or [Homebrew](https://brew.sh/) (`brew install node`)
- **Xcode Command Line Tools**: required by `node-gyp` for native deps
  ```bash
  xcode-select --install
  ```

That's it — `better-sqlite3` and `sharp` ship prebuilt binaries for
both Intel and Apple Silicon, so no source compile needed.

If you hit a "node-gyp rebuild" error after upgrading Node major
versions, run `npm rebuild` to refresh native bindings.

### Linux (Ubuntu / Debian)

```bash
# Node.js 20.x via NodeSource (recommended)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Build tools for native deps (better-sqlite3 fallback)
sudo apt-get install -y build-essential python3

# Chromium runtime libs (for Playwright)
npx playwright install-deps chromium
```

Note: `npx playwright install-deps` is a Playwright-provided helper that
installs the exact apt packages Chromium needs (libnss3, libatk1.0-0,
libgbm1, etc). On Ubuntu 24.04+ some package names changed; if it
fails, see Playwright's [system requirements](https://playwright.dev/docs/intro#system-requirements).

### Linux (Alpine, including Docker `node:*-alpine`)

Alpine uses **musl libc** instead of glibc. Most prebuilt binaries are
glibc-only, so you'll need to either compile from source OR use a
glibc-based image.

**Recommended: switch to a glibc-based image** (`node:20-bookworm-slim` is
~80MB more but eliminates 90% of pain):

```dockerfile
FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y \
    libnss3 libatk1.0-0 libgbm1 libxshmfence1 \
    libxcomposite1 libxdamage1 libxext6 libxfixes3 \
    libxrandr2 libgtk-3-0 libcairo2 libpango-1.0-0 \
    && rm -rf /var/lib/apt/lists/*
```

**If you must stay on Alpine** (e.g., size-constrained edge runner):

```dockerfile
FROM node:20-alpine
RUN apk add --no-cache \
    python3 make g++ \
    chromium nss freetype harfbuzz ca-certificates ttf-freefont
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser
```

The `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` skips Playwright's own
chromium download (which is glibc-only) and uses Alpine's
`chromium-browser` package instead. Trade-off: Alpine's chromium
version may lag Playwright's bundled version.

### Windows (PowerShell or Git Bash)

```powershell
# Recommended: install Node 20 LTS via the official MSI installer
# https://nodejs.org/

# Verify
node --version    # v20.x.x
npm --version     # 10.x.x
```

For native deps, install
[Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022)
+ select "Desktop development with C++" workload. This gives
`node-gyp` what it needs to compile better-sqlite3 from source if
the prebuilt binary doesn't match your CPU/Node combo.

In **Git Bash** (recommended over PowerShell for the audit CLI), the
default behaviour is the same as Linux. In PowerShell, environment
variable syntax differs:

```powershell
$env:ANTHROPIC_API_KEY = "sk-ant-..."
npx pixelcheck run
```

### WSL2

WSL2 (Windows Subsystem for Linux 2) works exactly like Ubuntu — follow
the [Ubuntu / Debian instructions](#linux-ubuntu--debian) inside your
WSL distro. **Performance tip**: keep the project in the WSL filesystem
(`~/projects/...`) rather than mounted Windows drives (`/mnt/c/...`) —
Windows file-system performance is ~10x worse than native ext4.

---

## Docker

### Recommended: multi-stage build with Playwright official image

The cleanest way to ship `pixelcheck` in a container is to use
Playwright's pre-built image (Chromium + system libs already installed):

```dockerfile
# Stage 1: build
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: runtime (Playwright official image)
FROM mcr.microsoft.com/playwright:v1.49.0-jammy
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["run"]
```

**Build + run**:

```bash
docker build -t my-auditor .
docker run --rm \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  -v $(pwd)/reports:/app/reports \
  my-auditor run --base-url https://example.com
```

### Lightweight: node:20-alpine

```dockerfile
FROM node:20-alpine
RUN apk add --no-cache python3 make g++ \
    chromium nss freetype harfbuzz ca-certificates ttf-freefont
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist ./dist
ENTRYPOINT ["node", "dist/cli.js"]
```

Trade-off: ~150MB image vs 350MB for `mcr.microsoft.com/playwright`,
but Alpine chromium version may lag, and some advanced page-stability
heuristics may behave differently.

### Build args + secrets

Don't bake `ANTHROPIC_API_KEY` into the image. Pass it at runtime via
`-e` or use Docker BuildKit secrets for build-time access only:

```bash
# Runtime
docker run -e ANTHROPIC_API_KEY=sk-ant-... my-auditor run

# Build-time (BuildKit, only if absolutely needed for build steps)
docker buildx build --secret id=anthropic_key,env=ANTHROPIC_API_KEY .
```

---

## Corporate proxy / firewall environments

Node.js, npm, and Playwright all honor standard proxy environment
variables. Set them once in your shell rc (`.bashrc` / `.zshrc` /
`$PROFILE`) and everything routes correctly.

### Outbound proxy

```bash
export HTTP_PROXY="http://proxy.corp.example:8080"
export HTTPS_PROXY="http://proxy.corp.example:8080"
export NO_PROXY="localhost,127.0.0.1,internal.corp.example"

# npm config (alternative; persists per-user)
npm config set proxy http://proxy.corp.example:8080
npm config set https-proxy http://proxy.corp.example:8080
```

`npm install` will route through the proxy. The Anthropic SDK uses
Node's built-in `https.request`, which honors `HTTPS_PROXY`
automatically. Playwright's `chromium.launch()` similarly honors it
for any in-browser navigation.

### Self-signed certificates / corporate MITM

If your proxy intercepts TLS (corporate MITM), you'll need to add the
internal CA to Node's trust store:

```bash
# One-shot for current session
export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/corp-ca.pem

# Persistent
echo 'export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/corp-ca.pem' >> ~/.zshrc
```

If you see SSL handshake errors during `npm install` and adding the CA
doesn't fix it (last resort, **not recommended for security-sensitive
environments**):

```bash
# Disable strict TLS (TEMPORARILY, then re-enable)
export NODE_TLS_REJECT_UNAUTHORIZED=0
npm install
unset NODE_TLS_REJECT_UNAUTHORIZED
```

### Verifying connectivity

```bash
# Anthropic API
curl -I https://api.anthropic.com/v1/messages

# Chromium download CDN (Playwright)
curl -I https://cdn.playwright.dev/

# npm registry
npm ping
```

If `doctor` is available (T23, v1.0+):

```bash
npx pixelcheck doctor --verbose
# Reports proxy / CA / connectivity status
```

---

## Air-gapped install

For environments without internet access (regulated industries, gov, military, fully-isolated corp networks):

### Prep on internet-connected machine

```bash
# 1. Clone or download the repo
git clone https://github.com/xcodethink/pixelcheck.git
cd pixelcheck

# 2. Full install + verify
npm ci
npm run build

# 3. Pre-download the browser pixelcheck launches (Chrome Headless Shell).
#    Use pixelcheck's installer so the cached revision matches what it runs.
#    Add --headed to also cache full Chromium for headed runs.
npx pixelcheck install

# 4. Bundle everything
tar czf pixelcheck-offline-v1.0.0.tar.gz \
  pixelcheck/ \
  ~/.cache/ms-playwright/   # Linux
  # ~/Library/Caches/ms-playwright/   # macOS
```

### Transfer + install on air-gapped machine

```bash
# Transfer via your approved sneakernet (USB / cross-domain solution / etc)
scp pixelcheck-offline-v1.0.0.tar.gz airgapped:~/

# On airgapped machine:
tar xzf pixelcheck-offline-v1.0.0.tar.gz
cd pixelcheck

# Skip browser download during install (we already have it)
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Use bundled node_modules
npm install --offline --prefer-offline

# Restore Chromium cache
mkdir -p ~/.cache/
mv ms-playwright ~/.cache/

# Verify
npx pixelcheck --version
```

### Anthropic API access on air-gapped systems

If your air-gapped network has **no Internet at all**, the Claude API
isn't reachable, so the AI features (`see` / `judge` / `compare` / etc)
won't work. Options:

1. **Pure deterministic audits**: skip AI steps; `assert_a11y` (axe-core)
   and `assert_visual_diff` (odiff) work entirely offline
2. **Self-hosted relay**: route Anthropic API calls through a corporate
   relay that has selective Internet access (single egress point for
   audit + observability)
3. **Wait for v1.x local LLM fallback** (M4-4 task; not in v1.0)

Document which option you chose in your runbook so future maintainers
know the constraint.

---

## Common install errors + fixes

| Error | Likely cause | Fix |
|---|---|---|
| `EACCES: permission denied` on `npm install -g` | Running global install as non-root in a system-owned `node_modules` | Use a user-level Node manager (nvm / fnm / volta) — never `sudo npm install -g` |
| `Failed to launch chromium` on Linux | Missing system libraries (libnss3, libgbm1, etc) | `npx playwright install-deps chromium` |
| `node-gyp rebuild` failure on Windows | Missing Visual Studio Build Tools | Install MSVC Build Tools + "Desktop development with C++" workload |
| `node-gyp rebuild` failure on macOS | Missing Xcode CLT | `xcode-select --install` |
| `node-gyp rebuild` failure on Alpine | Missing python3 / make / g++ | `apk add --no-cache python3 make g++` |
| `Cannot find module 'better-sqlite3'` after Node major upgrade | Stale native binding from old Node ABI | `npm rebuild better-sqlite3` (or `npm rebuild` for everything) |
| `Error: ENOENT: no such file or directory ... chromium` | `npm install` skipped the browser download | `npx pixelcheck install` (or `pixelcheck doctor --fix`) |
| `request to https://api.anthropic.com failed, reason: self-signed certificate in certificate chain` | Corporate MITM proxy without trusted CA | Set `NODE_EXTRA_CA_CERTS=/path/to/corp-ca.pem` |
| `request failed, reason: getaddrinfo ENOTFOUND api.anthropic.com` | Outbound DNS / firewall blocking | Set `HTTPS_PROXY` env var or whitelist `api.anthropic.com` in firewall |
| `Error [ERR_REQUIRE_ESM]: require() of ES Module` | Trying to use the package as CommonJS | This is an ESM-only package; use `import` or set `"type": "module"` in your project |
| `npm error code ERESOLVE — peer dep mismatch` | Conflicting peer dep version with another package in your project | Try `npm install --legacy-peer-deps` (last resort); ideally pin the conflicting package |

---

## Verifying your install

After install, run these three commands. All should succeed:

```bash
# 1. Version check (proves npm install worked)
npx pixelcheck --version
# Expected: v1.x.x

# 2. Doctor (T23, v1.0+ — checks API key / config / network / Chromium)
npx pixelcheck doctor

# 3. Smoke run against a known-good URL (does NOT require API key for non-LLM steps)
echo 'scenarios:
  - id: smoke
    name: install smoke
    steps:
      - type: visit
        url: https://example.com
      - type: assert_a11y
        standard: wcag2aa' > smoke-scenario.yaml

npx pixelcheck run --scenarios smoke-scenario.yaml --no-pdf
# Expected: passes; writes reports/<runId>/audit.json
```

If all three succeed, you're ready to set `ANTHROPIC_API_KEY` and run a
full AI-driven audit. See the [Quick Start in README](../README.md#quick-start).

---

## Getting help

- **Bug reports**: [GitHub Issues](https://github.com/xcodethink/pixelcheck/issues)
- **Security disclosures**: [SECURITY.md](../SECURITY.md)
- **Stuck on install**: open a discussion / issue with `[install]` in
  the title + your platform / Node version / full `doctor --verbose`
  output

---

**Last updated**: 2026-05-01 (T30 — Wave 4 close)
