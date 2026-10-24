import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DiskCache } from "../src/cache/disk-cache.js";
import { enrichHistory } from "../src/github/enrich.js";
import { LiveGitHub } from "../src/github/live.js";
import type { HistoryCommit } from "../src/types.js";

describe("LiveGitHub", () => {
  let dir = "";

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = "";
  });

  it("caches pull requests and enriches a commit from the API once", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "ga-live-"));
    const cache = new DiskCache(dir);
    let calls = 0;
    const fetchImpl = async (url: string) => {
      calls += 1;
      if (url.includes("/comments") || url.includes("/reviews")) return json([]);
      if (url.includes("/commits/")) return json([{ number: 7 }]);
      if (url.includes("/pulls/7")) {
        return json({
          number: 7,
          title: "Guard the call",
          body: "Fixes #12",
          state: "closed",
          merged_at: "2024-01-02T00:00:00Z",
          user: { login: "mina" },
          html_url: "https://example.test/pull/7",
        });
      }
      if (url.includes("/issues/12")) {
        return json({
          number: 12,
          title: "Null token crash",
          body: "refreshSession threw.",
          state: "closed",
          user: { login: "lina" },
          html_url: "https://example.test/issues/12",
        });
      }
      return json(null, 404);
    };
    const live = new LiveGitHub({
      token: "test-token",
      apiUrl: "https://api.github.test",
      cache,
      fetchImpl,
    });
    expect((await live.pull("acme", "widget", 7))?.title).toBe("Guard the call");
    expect((await live.pull("acme", "widget", 7))?.merged).toBe(true);
    const afterPull = calls;

    const commit: HistoryCommit = {
      sha: "a".repeat(40),
      parents: [],
      authorName: "Mina Ellison",
      authorEmail: "mina@example.com",
      authoredAt: "2024-01-01T00:00:00Z",
      summary: "Guard the call",
      body: "Fixes #12",
      added: ["if (token == null) return;"],
      removed: [],
      role: "introduced",
    };
    const artifacts = await enrichHistory({
      commits: [commit],
      owner: "acme",
      repo: "widget",
      fixture: null,
      live,
    });
    expect(artifacts.pulls.map((pull) => pull.number)).toEqual([7]);
    expect(artifacts.issues.map((issue) => issue.title)).toEqual(["Null token crash"]);
    const afterEnrich = calls;
    const again = await enrichHistory({
      commits: [commit],
      owner: "acme",
      repo: "widget",
      fixture: null,
      live,
    });
    expect(again.issues).toHaveLength(1);
    expect(calls).toBe(afterEnrich);
    expect(afterEnrich).toBeGreaterThan(afterPull);
  });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
