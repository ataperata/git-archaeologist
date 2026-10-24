import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { buildSampleRepository } from "../src/demo/sample-repo.js";
import { git } from "../src/git/exec.js";
import { missingCitations } from "../src/narrative/citations.js";
import { investigate } from "../src/pipeline.js";

describe("investigate", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("answers the sample excavation offline with every artifact cited", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ga-pipe-"));
    dirs.push(root);
    const sample = await buildSampleRepository(root);
    const report = await investigate(
      {
        repo: sample.path,
        file: sample.file,
        line: sample.line,
        symbol: sample.symbol,
        question: "Why does the null and expiry guard in refreshSession exist?",
        offline: true,
      },
      config(root),
    );

    expect(report.narrativeMode).toBe("heuristic");
    expect(report.narrative).toContain("token.expired");
    expect(report.narrative).toContain('if (token == null) return { ok: false, reason: "missing-token" }');
    expect(report.narrative).toContain("missing-or-expired");
    expect(report.narrative).toContain("Dashboard alert matcher broke");
    expect(report.narrative).not.toContain("Also on the record");
    expect(missingCitations(report.narrative, report.graph)).toEqual([]);
    expect(new Set(report.graph.nodes.map((node) => node.type))).toEqual(
      new Set(["focus", "commit", "pull_request", "issue", "discussion"]),
    );
    const edges = new Set(report.graph.edges.map((edge) => edge.type));
    for (const kind of ["introduced", "modified", "motivated-by", "reverted", "linked"]) {
      expect(edges.has(kind)).toBe(true);
    }
    const reverted = report.graph.edges.find((edge) => edge.type === "reverted");
    expect(reverted?.source.startsWith("commit:")).toBe(true);
    expect(reverted?.target.startsWith("commit:")).toBe(true);
  });

  it("synthesizes artifacts for a repository that is not the fixture", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ga-synth-"));
    dirs.push(root);
    await git(["init", "-b", "main"], root);
    await git(["config", "user.email", "dev@example.com"], root);
    await git(["config", "user.name", "Dev"], root);
    await git(["config", "commit.gpgsign", "false"], root);
    await writeFile(path.join(root, "note.txt"), "keep the guard\n");
    await git(["add", "note.txt"], root);
    await git(
      ["commit", "--no-verify", "-m", "Fix the guard (#8)\n\nFixes #9\n"],
      root,
      {
        GIT_AUTHOR_DATE: "2024-06-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2024-06-01T00:00:00Z",
        GIT_AUTHOR_NAME: "Dev",
        GIT_AUTHOR_EMAIL: "dev@example.com",
        GIT_COMMITTER_NAME: "Dev",
        GIT_COMMITTER_EMAIL: "dev@example.com",
      },
    );
    const report = await investigate(
      { repo: root, file: "note.txt", line: 1, offline: true },
      config(root),
    );
    expect(report.graph.nodes.some((node) => node.type === "pull_request" && node.data.number === 8 && node.data.synthetic)).toBe(true);
    expect(report.graph.nodes.some((node) => node.type === "issue" && node.data.number === 9 && node.data.synthetic)).toBe(true);
    expect(report.narrative).toContain("[@pr:8]");
    expect(report.narrative).toContain("[@issue:9]");
    expect(missingCitations(report.narrative, report.graph)).toEqual([]);
  });

  it("uses the model when configured and still cites every artifact", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ga-llm-"));
    dirs.push(root);
    const sample = await buildSampleRepository(root);
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "Because the guard failed closed." } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const appConfig: AppConfig = {
      ...config(root),
      offline: false,
      llmBaseUrl: "https://llm.test/v1",
      llmApiKey: "test-key",
      llmModel: "test-model",
    };
    const first = await investigate(
      { repo: sample.path, file: sample.file, line: sample.line, offline: false },
      appConfig,
      { fetchImpl },
    );
    const second = await investigate(
      { repo: sample.path, file: sample.file, line: sample.line, offline: false },
      appConfig,
      { fetchImpl },
    );
    expect(first.narrativeMode).toBe("llm");
    expect(first.narrative).toContain("Because the guard failed closed.");
    expect(first.narrative).toContain("[@issue:12]");
    expect(missingCitations(first.narrative, first.graph)).toEqual([]);
    expect(second.narrativeMode).toBe("llm");
    expect(calls).toBe(1);
    expect(second.cache.hits).toBeGreaterThan(0);
  });

  it("falls back to the heuristic when the model request fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ga-llm-fail-"));
    dirs.push(root);
    const sample = await buildSampleRepository(root);
    const report = await investigate(
      { repo: sample.path, file: sample.file, symbol: "refreshSession", offline: false },
      {
        ...config(root),
        offline: false,
        llmBaseUrl: "https://llm.test/v1",
        llmApiKey: "test-key",
      },
      {
        fetchImpl: async () => new Response("nope", { status: 503 }),
      },
    );
    expect(report.narrativeMode).toBe("heuristic");
    expect(report.warnings.some((warning) => warning.includes("Fell back"))).toBe(true);
    expect(report.source.lineEnd).toBeGreaterThan(report.source.lineStart);
    expect(missingCitations(report.narrative, report.graph)).toEqual([]);
  });

  it("rejects paths that leave the repository", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ga-path-"));
    dirs.push(root);
    const sample = await buildSampleRepository(root);
    await expect(
      investigate({ repo: sample.path, file: "../secret.txt", line: 1, offline: true }, config(root)),
    ).rejects.toThrow(/inside the repository/);
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
