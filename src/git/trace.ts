import { ArchaeologistError } from "../errors.js";
import type { CommitRole, HistoryCommit, TraceResult } from "../types.js";
import { git, GitError } from "./exec.js";

const BEGIN = "@@ARCH-BEGIN@@";
const BODY = "@@ARCH-BODY@@";
const END = "@@ARCH-ENDMETA@@";

const LOG_FORMAT = `${BEGIN}%n%H%n%P%n%an%n%ae%n%aI%n%s%n${BODY}%n%b%n${END}`;

export async function traceLines(repo: string, file: string, start: number, end: number): Promise<TraceResult> {
  if (start < 1 || end < start) {
    throw new ArchaeologistError(`Invalid line range ${start}-${end}.`);
  }
  let logOutput: string;
  try {
    logOutput = await git(
      ["log", `-L${start},${end}:${file}`, "--reverse", "-M", `--format=${LOG_FORMAT}`],
      repo,
    );
  } catch (err) {
    const detail = err instanceof GitError ? err.message : "git log failed";
    throw new ArchaeologistError(`Could not trace ${file}:${start}-${end}: ${detail}`);
  }
  const commits = parseLineLog(logOutput);
  if (commits.length === 0) {
    throw new ArchaeologistError(`No history found for ${file}:${start}-${end}.`);
  }
  await attachReverts(repo, commits);

  let moveOutput = "";
  try {
    moveOutput = await git(
      [
        "log",
        "--follow",
        "--name-status",
        `--format=${LOG_FORMAT}`,
        "--",
        file,
      ],
      repo,
    );
  } catch {
    moveOutput = "";
  }
  const moves = parseMoveLog(moveOutput);
  const known = new Set(commits.map((commit) => commit.sha));
  for (const move of moves) {
    const existing = commits.find((commit) => commit.sha === move.sha);
    if (existing) {
      existing.movedFrom = move.movedFrom;
      existing.movedTo = move.movedTo;
      continue;
    }
    if (!known.has(move.sha)) {
      commits.push(move);
      known.add(move.sha);
    }
  }

  for (const commit of [...commits]) {
    if (!commit.revertedSha || known.has(commit.revertedSha)) continue;
    const loaded = await loadCommit(repo, commit.revertedSha);
    if (!loaded) continue;
    commits.push(loaded);
    known.add(loaded.sha);
  }

  return { commits };
}

export function parseLineLog(output: string): HistoryCommit[] {
  return splitRecords(output).map((chunk) => {
    const { meta, rest } = splitMeta(chunk);
    const commit = headerToCommit(meta, "modified");
    const patch = parsePatch(rest);
    commit.file = patch.file || commit.file;
    commit.added = patch.added;
    commit.removed = patch.removed;
    commit.role = patch.removed.length === 0 && patch.added.length > 0 ? "introduced" : "modified";
    return commit;
  });
}

export function parseMoveLog(output: string): HistoryCommit[] {
  return splitRecords(output).flatMap((chunk) => {
    const { meta, rest } = splitMeta(chunk);
    const rename = rest.match(/^R\d+\t([^\t\n]+)\t([^\t\n]+)/m) ?? rest.match(/^C\d+\t([^\t\n]+)\t([^\t\n]+)/m);
    if (!rename?.[1] || !rename[2]) return [];
    const commit = headerToCommit(meta, "moved");
    commit.movedFrom = rename[1];
    commit.movedTo = rename[2];
    commit.file = rename[2];
    return [commit];
  });
}

export async function loadCommit(repo: string, sha: string): Promise<HistoryCommit | null> {
  let out: string;
  try {
    out = await git(["show", "-s", "--format=%H%n%P%n%an%n%ae%n%aI%n%s%n%b%x00", sha], repo);
  } catch {
    return null;
  }
  const text = out.replace(/\0$/, "").replace(/\n$/, "");
  const lines = text.split("\n");
  if (lines.length < 6 || !lines[0] || !/^[0-9a-f]{40}$/.test(lines[0])) return null;
  return {
    sha: lines[0],
    parents: (lines[1] ?? "").split(" ").filter(Boolean),
    authorName: lines[2] ?? "",
    authorEmail: lines[3] ?? "",
    authoredAt: lines[4] ?? "",
    summary: lines[5] ?? "",
    body: lines.slice(6).join("\n"),
    added: [],
    removed: [],
    role: "related",
  };
}

async function attachReverts(repo: string, commits: HistoryCommit[]): Promise<void> {
  for (const commit of commits) {
    const match = commit.body.match(/This reverts commit ([0-9a-f]{7,40})\./i);
    if (!match?.[1]) continue;
    const resolved = await git(["rev-parse", "--verify", `${match[1]}^{commit}`], repo).catch(() => "");
    commit.revertedSha = resolved.trim() || match[1];
  }
}

function splitRecords(output: string): string[] {
  return output
    .split(`${BEGIN}\n`)
    .map((part) => part.trimEnd())
    .filter((part) => part.trim().length > 0 && part.includes(END));
}

function splitMeta(chunk: string): { meta: string; rest: string } {
  const marker = `\n${END}`;
  const end = chunk.indexOf(marker);
  if (end < 0) throw new ArchaeologistError("Could not parse git history output.");
  let rest = chunk.slice(end + marker.length);
  if (rest.startsWith("\n")) rest = rest.slice(1);
  return { meta: chunk.slice(0, end), rest };
}

function headerToCommit(meta: string, role: CommitRole): HistoryCommit {
  const bodyMarker = `\n${BODY}\n`;
  const bodyAt = meta.indexOf(bodyMarker);
  if (bodyAt < 0) throw new ArchaeologistError("Could not parse git commit headers.");
  const header = meta.slice(0, bodyAt).split("\n");
  const body = meta.slice(bodyAt + bodyMarker.length);
  if (header.length < 6 || !header[0] || !/^[0-9a-f]{40}$/.test(header[0])) {
    throw new ArchaeologistError("Git history returned an unexpected commit header.");
  }
  return {
    sha: header[0],
    parents: (header[1] ?? "").split(" ").filter(Boolean),
    authorName: header[2] ?? "",
    authorEmail: header[3] ?? "",
    authoredAt: header[4] ?? "",
    summary: header.slice(5).join("\n"),
    body,
    added: [],
    removed: [],
    role,
  };
}

function parsePatch(diff: string): { file: string; added: string[]; removed: string[] } {
  const fileMatch = diff.match(/^\+\+\+ b\/(.+)$/m);
  const added: string[] = [];
  const removed: string[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) continue;
    if (line.startsWith("+")) added.push(line.slice(1));
    else if (line.startsWith("-")) removed.push(line.slice(1));
  }
  return { file: fileMatch?.[1] ?? "", added, removed };
}
