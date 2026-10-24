import type {
  Artifacts,
  CommitData,
  DecisionGraph,
  DiscussionData,
  EdgeType,
  FocusData,
  GraphEdge,
  GraphNode,
  HistoryCommit,
  IssueData,
  PullData,
  RepoIdentity,
} from "../types.js";
import { parseRefs } from "../github/refs.js";
import { shortSha } from "../text.js";

export function buildDecisionGraph(input: {
  question: string;
  file: string;
  lineStart: number;
  lineEnd: number;
  symbol?: string;
  snippet: string;
  artifacts: Artifacts;
  repo: RepoIdentity;
}): DecisionGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seenNodes = new Set<string>();
  const seenEdges = new Set<string>();

  const addNode = (node: GraphNode): void => {
    if (seenNodes.has(node.id)) return;
    seenNodes.add(node.id);
    nodes.push(node);
  };
  const addEdge = (type: EdgeType, source: string, target: string, evidence?: string): void => {
    if (!seenNodes.has(source) || !seenNodes.has(target) || source === target) return;
    const id = `${type}:${source}->${target}`;
    if (seenEdges.has(id)) return;
    seenEdges.add(id);
    const edge: GraphEdge = { id, type, source, target };
    if (evidence) edge.evidence = evidence;
    edges.push(edge);
  };

  const focusData: FocusData = {
    file: input.file,
    lineStart: input.lineStart,
    lineEnd: input.lineEnd,
    snippet: input.snippet,
    question: input.question,
  };
  if (input.symbol) focusData.symbol = input.symbol;
  addNode({
    id: "focus",
    type: "focus",
    label: input.symbol ?? `${input.file}:${input.lineStart}`,
    data: focusData,
  });

  for (const commit of input.artifacts.commits) {
    addNode({
      id: `commit:${commit.sha}`,
      type: "commit",
      label: `${shortSha(commit.sha)} ${clip(commit.summary)}`,
      data: commitData(commit, input.repo),
    });
  }

  for (const pull of input.artifacts.pulls) {
    addNode({
      id: `pr:${pull.number}`,
      type: "pull_request",
      label: `#${pull.number} ${clip(pull.title)}`,
      data: pullData(pull),
    });
  }
  for (const issue of input.artifacts.issues) {
    addNode({
      id: `issue:${issue.number}`,
      type: "issue",
      label: `#${issue.number} ${clip(issue.title)}`,
      data: issueData(issue),
    });
  }
  for (const discussion of input.artifacts.discussions) {
    addNode({
      id: `discussion:${discussion.discussionId}`,
      type: "discussion",
      label: clip(discussion.title || `${discussion.author}: ${discussion.body}`),
      data: discussionData(discussion),
    });
  }

  for (const commit of input.artifacts.commits) {
    const source = `commit:${commit.sha}`;
    if (commit.role === "introduced") {
      addEdge("introduced", source, "focus", commit.summary);
    } else if (commit.role === "modified") {
      addEdge("modified", source, "focus", commit.summary);
    }
    if (commit.revertedSha) {
      const targetSha = resolveSha(commit.revertedSha, input.artifacts.commits);
      if (targetSha) {
        addEdge("reverted", source, `commit:${targetSha}`, `This reverts commit ${targetSha}.`);
      }
    }
  }

  for (const link of input.artifacts.commitLinks) {
    const source = `commit:${link.sha}`;
    for (const number of link.pullNumbers) {
      addEdge("linked", source, `pr:${number}`, "Commit is associated with this pull request.");
    }
    for (const number of link.issueNumbers) {
      addEdge("motivated-by", source, `issue:${number}`, "Referenced from the commit message.");
    }
    for (const discussionId of link.discussionIds) {
      addEdge("motivated-by", source, `discussion:${discussionId}`, "Referenced from the commit message.");
    }
  }

  for (const pull of input.artifacts.pulls) {
    const refs = parseRefs(`${pull.title}\n${pull.body}`);
    for (const number of [...refs.issues, ...refs.bare]) {
      addEdge("motivated-by", `pr:${pull.number}`, `issue:${number}`, "Referenced from the pull request.");
    }
    for (const number of refs.discussions) {
      addEdge(
        "motivated-by",
        `pr:${pull.number}`,
        `discussion:thread:${number}`,
        "Referenced from the pull request.",
      );
    }
  }

  for (const discussion of input.artifacts.discussions) {
    const source = `discussion:${discussion.discussionId}`;
    if (discussion.parentType === "pull_request" && discussion.parentNumber) {
      addEdge("linked", source, `pr:${discussion.parentNumber}`, "Comment on this pull request.");
    } else if (discussion.parentType === "issue" && discussion.parentNumber) {
      addEdge("linked", source, `issue:${discussion.parentNumber}`, "Comment on this issue.");
    } else if (discussion.parentId) {
      addEdge("linked", source, discussion.parentId, "Reply in this discussion.");
    }
  }

  for (const commit of input.artifacts.commits) {
    const visible = `${commit.summary.replace(/"[^"]*"/g, "")}\n${commit.body}`;
    if (!/review/i.test(visible)) continue;
    const link = input.artifacts.commitLinks.find((item) => item.sha === commit.sha);
    if (!link) continue;
    for (const discussion of input.artifacts.discussions) {
      if (discussion.kind !== "review-comment" && discussion.kind !== "review") continue;
      if (!discussion.parentNumber || !link.pullNumbers.includes(discussion.parentNumber)) continue;
      addEdge(
        "motivated-by",
        `commit:${commit.sha}`,
        `discussion:${discussion.discussionId}`,
        "Follow-up commit after review on the same pull request.",
      );
    }
  }

  const lineCommits = input.artifacts.commits
    .filter((commit) => commit.role === "introduced" || commit.role === "modified")
    .slice()
    .sort((a, b) => Date.parse(a.authoredAt) - Date.parse(b.authoredAt));
  for (const move of input.artifacts.commits.filter((commit) => commit.role === "moved")) {
    const moveTime = Date.parse(move.authoredAt);
    const neighbor =
      lineCommits.find((commit) => Date.parse(commit.authoredAt) >= moveTime) ??
      lineCommits[lineCommits.length - 1];
    if (!neighbor) continue;
    addEdge(
      "linked",
      `commit:${move.sha}`,
      `commit:${neighbor.sha}`,
      `Renamed ${move.movedFrom ?? "the file"} to ${move.movedTo ?? "a new path"}.`,
    );
  }

  return { nodes, edges, repo: input.repo };
}

function commitData(commit: HistoryCommit, repo: RepoIdentity): CommitData {
  const data: CommitData = {
    sha: commit.sha,
    shortSha: shortSha(commit.sha),
    summary: commit.summary,
    body: commit.body,
    authorName: commit.authorName,
    authorEmail: commit.authorEmail,
    authoredAt: commit.authoredAt,
    parents: commit.parents,
    role: commit.role,
    added: commit.added,
    removed: commit.removed,
  };
  if (commit.file) data.file = commit.file;
  if (commit.revertedSha) data.revertedSha = commit.revertedSha;
  if (commit.movedFrom) data.movedFrom = commit.movedFrom;
  if (commit.movedTo) data.movedTo = commit.movedTo;
  if (repo.owner && repo.name) data.url = `https://github.com/${repo.owner}/${repo.name}/commit/${commit.sha}`;
  return data;
}

function pullData(pull: Artifacts["pulls"][number]): PullData {
  return { ...pull };
}

function issueData(issue: Artifacts["issues"][number]): IssueData {
  return { ...issue };
}

function discussionData(discussion: Artifacts["discussions"][number]): DiscussionData {
  return { ...discussion };
}

function resolveSha(prefix: string, commits: HistoryCommit[]): string | undefined {
  return commits.find((commit) => commit.sha === prefix || commit.sha.startsWith(prefix))?.sha;
}

function clip(text: string, max = 48): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1)}…`;
}
