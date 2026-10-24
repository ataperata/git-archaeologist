import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSampleRepository } from "../src/demo/sample-repo.js";
import { git } from "../src/git/exec.js";
import { parseLineLog } from "../src/git/trace.js";
import { traceLines } from "../src/git/trace.js";

describe("line history", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("parses a line log record", () => {
    const output = `@@ARCH-BEGIN@@
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

Mina Ellison
mina@example.com
2024-01-01T00:00:00+00:00
Add it
@@ARCH-BODY@@
Fixes #1
@@ARCH-ENDMETA@@
diff --git a/lib/session.ts b/lib/session.ts
--- /dev/null
+++ b/lib/session.ts
@@ -0,0 +1,1 @@
+if (token == null) return;
`;
    const commits = parseLineLog(output);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.role).toBe("introduced");
    expect(commits[0]?.file).toBe("lib/session.ts");
    expect(commits[0]?.body).toContain("Fixes #1");
  });

  it("follows the guard across a rename and a later revert", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ga-trace-"));
    dirs.push(root);
    const sample = await buildSampleRepository(root);
    const traced = await traceLines(sample.path, sample.file, sample.line, sample.line);
    const lineCommits = traced.commits.filter((commit) => commit.role === "introduced" || commit.role === "modified");
    expect(lineCommits.map((commit) => commit.file)).toEqual([
      "lib/session.ts",
      "lib/session.ts",
      "src/auth/session.ts",
      "src/auth/session.ts",
    ]);
    expect(lineCommits[0]?.role).toBe("introduced");
    expect(lineCommits.slice(1).every((commit) => commit.role === "modified")).toBe(true);
    const revert = lineCommits.find((commit) => commit.summary.startsWith("Revert "));
    const broadened = lineCommits.find((commit) => commit.summary.startsWith("Broaden the guard"));
    expect(revert?.revertedSha).toBe(broadened?.sha);
    const move = traced.commits.find((commit) => commit.role === "moved");
    expect(move?.movedFrom).toBe("lib/session.ts");
    expect(move?.movedTo).toBe("src/auth/session.ts");
    expect(lineCommits.at(-1)?.added.join("\n")).toContain("token.expired");
  });

  it("builds repositories with stable commit ids", async () => {
    const left = await mkdtemp(path.join(os.tmpdir(), "ga-stable-a-"));
    const right = await mkdtemp(path.join(os.tmpdir(), "ga-stable-b-"));
    dirs.push(left, right);
    const a = await buildSampleRepository(left);
    const b = await buildSampleRepository(right);
    expect(a.line).toBe(b.line);
    expect((await git(["rev-parse", "HEAD"], a.path)).trim()).toBe((await git(["rev-parse", "HEAD"], b.path)).trim());
  });
});
