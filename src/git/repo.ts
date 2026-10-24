import path from "node:path";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { ArchaeologistError } from "../errors.js";
import type { RepoIdentity } from "../types.js";
import { git, gitOptional, GitError } from "./exec.js";

export function parseGitHubRemote(input: string): { owner: string; name: string } | null {
  const trimmed = input.trim().replace(/\.git$/i, "").replace(/\/$/, "");
  const match = trimmed.match(/github\.com[:/]([^/]+)\/([^/#?]+)$/i);
  if (!match?.[1] || !match[2]) return null;
  return { owner: match[1], name: match[2] };
}

export function isRemoteSpec(input: string): boolean {
  return /^(https?:\/\/|git@|ssh:\/\/)/i.test(input.trim());
}

export function normalizeRepoFile(file: string): string {
  const cleaned = file.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!cleaned || cleaned.startsWith("/") || cleaned.includes("\0") || cleaned.split("/").includes("..")) {
    throw new ArchaeologistError("File path must be relative and stay inside the repository.");
  }
  return cleaned;
}

export async function resolveRepo(spec: string, cacheDir: string, offline: boolean): Promise<RepoIdentity> {
  const trimmed = spec.trim();
  if (!trimmed) throw new ArchaeologistError("Repository path is required.");
  if (isRemoteSpec(trimmed)) {
    const remote = parseGitHubRemote(trimmed);
    if (!remote) {
      throw new ArchaeologistError("Only GitHub repository URLs are supported as remote targets.");
    }
    const dest = path.join(cacheDir, "mirrors", remote.owner, remote.name);
    if (!existsSync(path.join(dest, ".git"))) {
      if (offline) {
        throw new ArchaeologistError(
          "Offline mode cannot clone a remote repository. Clone it first, or pass a local path.",
        );
      }
      await mkdir(path.dirname(dest), { recursive: true });
      try {
        await git(["clone", "--origin", "origin", trimmed, dest], cacheDir);
      } catch (err) {
        const detail = err instanceof GitError ? err.message : "clone failed";
        throw new ArchaeologistError(`Could not clone ${trimmed}: ${detail}`);
      }
    }
    return identityFor(dest, trimmed);
  }

  const absolute = path.resolve(trimmed);
  try {
    await git(["rev-parse", "--is-inside-work-tree"], absolute);
  } catch (err) {
    const detail = err instanceof GitError ? err.message : "not a git repository";
    throw new ArchaeologistError(`Cannot open ${absolute}: ${detail}`);
  }
  return identityFor(absolute);
}

async function identityFor(repoPath: string, explicitRemote?: string): Promise<RepoIdentity> {
  const top = (await git(["rev-parse", "--show-toplevel"], repoPath)).trim();
  const head = (await git(["rev-parse", "HEAD"], top)).trim();
  const remoteUrl = explicitRemote ?? (await gitOptional(["remote", "get-url", "origin"], top))?.trim();
  const parsed = remoteUrl ? parseGitHubRemote(remoteUrl) : null;
  return {
    path: top,
    head,
    remoteUrl: remoteUrl || undefined,
    owner: parsed?.owner,
    name: parsed?.name,
  };
}

export async function readBlob(repo: string, file: string, rev = "HEAD"): Promise<string> {
  try {
    return await git(["show", `${rev}:${file}`], repo);
  } catch (err) {
    const detail = err instanceof GitError ? err.message : "unreadable";
    throw new ArchaeologistError(`File not found at ${rev}: ${file} (${detail})`);
  }
}
