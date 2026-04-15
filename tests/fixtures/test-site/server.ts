/**
 * Minimal HTTP server for fixture-site integration tests.
 *
 * Serves static HTML from tests/fixtures/test-site/ and a handful of JSON APIs:
 *   POST /api/signup       → 201 or 400 (based on body.email)
 *   GET  /api/items        → 200 { items: [...] }
 *   GET  /api/slow         → 200 after 2s delay
 *   GET  /api/error        → 500
 *
 * Start in a test with `startFixtureServer()` and stop with `close()` in afterAll.
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface FixtureServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
};

export async function startFixtureServer(): Promise<FixtureServer> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    // API routes
    if (url.pathname === "/api/signup" && req.method === "POST") {
      const body = await readBody(req);
      try {
        const parsed = JSON.parse(body) as { email?: string };
        if (parsed.email && parsed.email.includes("@")) {
          res.writeHead(201, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_email" }));
        }
      } catch {
        res.writeHead(400);
        res.end();
      }
      return;
    }

    if (url.pathname === "/api/items") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ items: [{ id: 1 }, { id: 2 }, { id: 3 }] }));
      return;
    }

    if (url.pathname === "/api/slow") {
      await new Promise((r) => setTimeout(r, 2000));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname === "/api/error") {
      res.writeHead(500);
      res.end("Internal Server Error");
      return;
    }

    // Static files
    let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    if (!filePath.endsWith(".html") && !filePath.includes(".")) {
      filePath += ".html";
    }
    const full = path.join(__dirname, filePath);
    if (!full.startsWith(__dirname)) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      const data = fs.readFileSync(full);
      const ext = path.extname(full);
      res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" });
      res.end(data);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not Found");
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind fixture server");
  }
  const port = address.port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
