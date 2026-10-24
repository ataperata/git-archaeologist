import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { git } from "../git/exec.js";

export const SAMPLE_VERSION = "1";

export interface SampleRepository {
  path: string;
  file: string;
  line: number;
  symbol: string;
}

const INITIAL = `export type SessionResult =
  | { ok: true; token: string }
  | { ok: false; reason: "missing-token" };

/**
 * Refresh a caller-supplied session token.
 * Returns a fail-closed result when the caller has nothing safe to refresh.
 */
export function refreshSession(token: { value?: string } | null): SessionResult {
  if (token == null) return { ok: false, reason: "missing-token" };
  return { ok: true, token: token.value ?? "" };
}
`;

export async function buildSampleRepository(root: string): Promise<SampleRepository> {
  const dir = path.join(root, "widget");
  const markerPath = path.join(dir, ".git", "archaeologist-sample.json");
  if (existsSync(markerPath)) {
    const saved = JSON.parse(await readFile(markerPath, "utf8")) as {
      version?: string;
      file?: string;
      line?: number;
      symbol?: string;
    };
    if (saved.version === SAMPLE_VERSION && saved.file && saved.line && saved.symbol) {
      return { path: dir, file: saved.file, line: saved.line, symbol: saved.symbol };
    }
  }

  await rm(dir, { recursive: true, force: true });
  await mkdir(path.join(dir, "lib"), { recursive: true });
  await git(["init", "-b", "main"], dir);
  await git(["config", "user.email", "mina@example.com"], dir);
  await git(["config", "user.name", "Mina Ellison"], dir);
  await git(["config", "core.autocrlf", "false"], dir);
  await git(["config", "commit.gpgsign", "false"], dir);
  await git(["config", "core.hooksPath", "/dev/null"], dir);

  await writeFile(path.join(dir, "lib", "session.ts"), INITIAL);
  await commit(
    dir,
    "Add session refresh guard (#40)\n\nFixes #12\n",
    "2024-01-01T00:00:00Z",
    "Mina Ellison",
    "mina@example.com",
  );

  await writeFile(
    path.join(dir, "lib", "session.ts"),
    INITIAL.replace(
      'if (token == null) return { ok: false, reason: "missing-token" };',
      'if (token == null) return { ok: false, reason: "missing-or-expired" };',
    ),
  );
  await commit(
    dir,
    "Broaden the guard after review (#40)\n\nSee #12\n",
    "2024-02-01T00:00:00Z",
    "Mina Ellison",
    "mina@example.com",
  );
  const broadenSha = (await git(["rev-parse", "HEAD"], dir)).trim();

  await mkdir(path.join(dir, "src", "auth"), { recursive: true });
  await git(["mv", "lib/session.ts", "src/auth/session.ts"], dir);
  await commit(
    dir,
    "Move session module into auth/\n",
    "2024-03-01T00:00:00Z",
    "Mina Ellison",
    "mina@example.com",
  );

  await git(["revert", "--no-edit", broadenSha], dir, authorEnv("2024-04-01T00:00:00Z", "Jonas Hale", "jonas@example.com"));

  const moved = await readFile(path.join(dir, "src", "auth", "session.ts"), "utf8");
  const restored = moved
    .replace(
      "export function refreshSession(token: { value?: string } | null): SessionResult {",
      "export function refreshSession(token: { value?: string; expired?: boolean } | null): SessionResult {",
    )
    .replace(
      'if (token == null) return { ok: false, reason: "missing-token" };',
      "if (token == null || token.expired || !token.value) return { ok: false, reason: \"missing-token\" };",
    );
  await writeFile(path.join(dir, "src", "auth", "session.ts"), restored);
  await commit(
    dir,
    "Restore expired-token coverage (#51)\n\nFixes #18\n",
    "2024-05-01T00:00:00Z",
    "Mina Ellison",
    "mina@example.com",
  );

  await git(["remote", "add", "origin", "https://github.com/acme/widget.git"], dir);
  const finalText = await readFile(path.join(dir, "src", "auth", "session.ts"), "utf8");
  const line = finalText.split("\n").findIndex((entry) => entry.includes("token.expired")) + 1;
  if (line < 1) throw new Error("Sample repository is missing the expiry guard.");
  const meta = { version: SAMPLE_VERSION, file: "src/auth/session.ts", line, symbol: "refreshSession" };
  await writeFile(markerPath, `${JSON.stringify(meta)}\n`);
  return { path: dir, file: meta.file, line: meta.line, symbol: meta.symbol };
}

async function commit(dir: string, message: string, date: string, name: string, email: string): Promise<void> {
  const messagePath = path.join(dir, ".git", "ARCH_COMMIT_MSG");
  await writeFile(messagePath, message.endsWith("\n") ? message : `${message}\n`);
  await git(["add", "-A"], dir);
  await git(["commit", "--no-verify", "-F", messagePath], dir, authorEnv(date, name, email));
}

function authorEnv(date: string, name: string, email: string): NodeJS.ProcessEnv {
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  };
}
