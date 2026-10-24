import { execFile } from "node:child_process";

export class GitError extends Error {
  readonly args: string[];
  readonly stderr: string;

  constructor(message: string, args: string[], stderr: string) {
    super(message);
    this.name = "GitError";
    this.args = args;
    this.stderr = stderr;
  }
}

export function git(args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const full = ["-c", "color.ui=false", "-c", "core.quotepath=false", ...args];
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      full,
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_PAGER: "cat",
          GIT_TERMINAL_PROMPT: "0",
          ...env,
        },
      },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || err.message).trim();
          reject(new GitError(detail || "git command failed", full, stderr ?? ""));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export async function gitOptional(args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    return await git(args, cwd, env);
  } catch {
    return null;
  }
}
