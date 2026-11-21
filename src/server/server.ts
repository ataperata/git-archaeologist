import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { buildSampleRepository } from "../demo/sample-repo.js";
import { ArchaeologistError } from "../errors.js";
import type { AppConfig } from "../config.js";
import { investigate } from "../pipeline.js";
import { packageRoot } from "../paths.js";
import type { InvestigateInput } from "../types.js";

export interface RunningServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

const STATIC: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
};

export function startServer(options: { host: string; port: number; config: AppConfig }): Promise<RunningServer> {
  const server = http.createServer((req, res) => {
    void handle(req, res, options.config).catch((err: unknown) => {
      if (err instanceof ArchaeologistError) {
        sendJson(res, 400, { error: err.message });
        return;
      }
      const message = err instanceof Error ? err.message : "Internal error";
      sendJson(res, 500, { error: message });
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new ArchaeologistError("Server did not bind a TCP port."));
        return;
      }
      resolve({
        url: `http://${options.host}:${address.port}`,
        port: address.port,
        close: () =>
          new Promise((done, fail) => {
            server.close((err) => (err ? fail(err) : done()));
          }),
      });
    });
  });
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function hostnameOf(value: string): string | null {
  try {
    return new URL(`http://${value}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The API can read any repository the process can see, so only answer requests
 * addressed to a loopback name (blocks DNS rebinding) and only accept POSTs that
 * a cross-origin page cannot send without a CORS preflight.
 */
function rejectForeignRequest(req: http.IncomingMessage): string | null {
  const host = req.headers.host;
  const hostname = host ? hostnameOf(host) : null;
  if (!hostname || !LOOPBACK_HOSTS.has(hostname)) return "Host must be a loopback address.";
  if (req.method === "POST") {
    const origin = req.headers.origin;
    if (origin && origin !== "null") {
      let originHost: string | null = null;
      try {
        originHost = new URL(origin).host.toLowerCase();
      } catch {
        originHost = null;
      }
      if (originHost !== host?.toLowerCase()) return "Cross-origin requests are not allowed.";
    } else if (origin === "null") {
      return "Cross-origin requests are not allowed.";
    }
    const type = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
    if (type !== "application/json") return "POST requests must use Content-Type: application/json.";
  }
  return null;
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, config: AppConfig): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const refusal = rejectForeignRequest(req);
  if (refusal) {
    sendJson(res, 403, { error: refusal });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/config") {
    sendJson(res, 200, {
      offlineDefault: true,
      github: Boolean(config.githubToken),
      llm: Boolean(config.llmApiKey && config.llmBaseUrl),
      model: config.llmApiKey ? config.llmModel : null,
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/demo") {
    const sample = await buildSampleRepository(path.join(config.cacheDir, "sample"));
    const report = await investigate(
      {
        repo: sample.path,
        file: sample.file,
        line: sample.line,
        symbol: sample.symbol,
        question: "Why does the null and expiry guard in refreshSession exist?",
        offline: true,
      },
      config,
    );
    sendJson(res, 200, report);
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/investigate") {
    const body = await readJson(req);
    const report = await investigate(parseInvestigateBody(body), config);
    sendJson(res, 200, report);
    return;
  }
  if (req.method === "GET" && STATIC[url.pathname]) {
    await sendStatic(res, STATIC[url.pathname]);
    return;
  }
  sendJson(res, 404, { error: "Not found" });
}

function parseInvestigateBody(body: unknown): InvestigateInput {
  if (!body || typeof body !== "object") throw new ArchaeologistError("Expected a JSON object.");
  const record = body as Record<string, unknown>;
  const repo = stringField(record, "repo");
  const file = stringField(record, "file");
  if (!repo || !file) throw new ArchaeologistError("repo and file are required.");
  const input: InvestigateInput = { repo, file };
  if (record.line !== undefined && record.line !== null && record.line !== "") {
    const line = Number(record.line);
    if (!Number.isInteger(line)) throw new ArchaeologistError("line must be an integer.");
    input.line = line;
  }
  if (record.end !== undefined && record.end !== null && record.end !== "") {
    const end = Number(record.end);
    if (!Number.isInteger(end)) throw new ArchaeologistError("end must be an integer.");
    input.end = end;
  }
  if (typeof record.symbol === "string" && record.symbol.trim()) input.symbol = record.symbol.trim();
  if (typeof record.question === "string" && record.question.trim()) input.question = record.question.trim();
  if (typeof record.offline === "boolean") input.offline = record.offline;
  if (typeof record.fixture === "string" && record.fixture.trim()) input.fixture = record.fixture.trim();
  return input;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new ArchaeologistError("Request body is too large.");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) throw new ArchaeologistError("Expected a JSON body.");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ArchaeologistError("Request body is not valid JSON.");
  }
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function sendStatic(
  res: http.ServerResponse,
  asset: { file: string; type: string },
): Promise<void> {
  const filePath = path.join(packageRoot(), "public", asset.file);
  const contents = await readFile(filePath);
  res.writeHead(200, {
    "Content-Type": asset.type,
    "Content-Length": contents.length,
    "Cache-Control": "no-store",
  });
  res.end(contents);
}
