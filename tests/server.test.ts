import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { buildSampleRepository } from "../src/demo/sample-repo.js";
import { startServer } from "../src/server/server.js";

describe("local UI", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("serves the field report UI and excavates the sample", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ga-ui-"));
    dirs.push(root);
    const server = await startServer({ host: "127.0.0.1", port: 0, config: config(root) });
    try {
      const page = await fetch(`${server.url}/`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("git-archaeologist");
      const script = await fetch(`${server.url}/app.js`);
      expect(await script.text()).toContain("function simulate");
      const style = await fetch(`${server.url}/styles.css`);
      expect(await style.text()).toContain("--copper");

      const demo = await fetch(`${server.url}/api/demo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const report = (await demo.json()) as { narrative: string; graph: { nodes: Array<{ type: string }> } };
      expect(demo.status).toBe(200);
      expect(report.narrative).toContain("[@issue:12]");
      expect(report.graph.nodes.some((node) => node.type === "discussion")).toBe(true);

      const missing = await fetch(`${server.url}/api/investigate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: root, file: "missing.ts" }),
      });
      expect(missing.status).toBe(400);

      const sample = await buildSampleRepository(path.join(root, "sample"));
      const custom = await fetch(`${server.url}/api/investigate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo: sample.path,
          file: sample.file,
          symbol: sample.symbol,
          offline: true,
        }),
      });
      expect(custom.status).toBe(200);
      const body = (await custom.json()) as { source: { symbol: string }; narrativeMode: string };
      expect(body.source.symbol).toBe("refreshSession");
      expect(body.narrativeMode).toBe("heuristic");
    } finally {
      await server.close();
    }
  });

  it("refuses cross-origin posts and foreign Host headers", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ga-ui-"));
    dirs.push(root);
    const server = await startServer({ host: "127.0.0.1", port: 0, config: config(root) });
    try {
      const simple = await fetch(`${server.url}/api/demo`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "{}",
      });
      expect(simple.status).toBe(403);

      const crossOrigin = await fetch(`${server.url}/api/demo`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
        body: "{}",
      });
      expect(crossOrigin.status).toBe(403);

      const rebound = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port: server.port, path: "/api/config", headers: { Host: "evil.example" } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(rebound).toBe(403);

      const sameOrigin = await fetch(`${server.url}/api/config`, { headers: { Origin: server.url } });
      expect(sameOrigin.status).toBe(200);
    } finally {
      await server.close();
    }
  });
});

function config(root: string): AppConfig {
  return {
    offline: true,
    githubApiUrl: "https://api.github.com",
    llmModel: "gpt-4o-mini",
    cacheDir: path.join(root, "cache"),
  };
}
