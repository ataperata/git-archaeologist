import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";

describe("cli", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("prints a JSON demo without contacting the network", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ga-cli-"));
    dirs.push(root);
    let stdout = "";
    let stderr = "";
    const code = await runCli(["demo", "--json"], {
      log: (message) => {
        stdout += message;
      },
      error: (message) => {
        stderr += message;
      },
    }, {
      loadEnvFile: false,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        GIT_ARCHAEOLOGIST_CACHE_DIR: path.join(root, "cache"),
        GIT_ARCHAEOLOGIST_OFFLINE: "1",
      },
    });
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as { narrative: string; graph: { edges: Array<{ type: string }> } };
    expect(report.narrative).toContain("[@pr:51]");
    expect(report.graph.edges.some((edge) => edge.type === "reverted")).toBe(true);
  });

  it("fails when a line and a symbol are both missing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ga-cli-bad-"));
    dirs.push(root);
    let stderr = "";
    const code = await runCli(["investigate", "--repo", root, "--file", "README.md", "--offline"], {
      log: () => undefined,
      error: (message) => {
        stderr += message;
      },
    }, {
      loadEnvFile: false,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        GIT_ARCHAEOLOGIST_CACHE_DIR: path.join(root, "cache"),
      },
    });
    expect(code).not.toBe(0);
    expect(stderr.length).toBeGreaterThan(0);
  });
});
