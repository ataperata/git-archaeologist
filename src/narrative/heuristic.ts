import type { DecisionGraph, GraphNode } from "../types.js";
import { excerpt, formatDate, inlineCode, quote } from "../text.js";
import { citationFor, ensureCitations } from "./citations.js";

type CommitNode = Extract<GraphNode, { type: "commit" }>;
type PullNode = Extract<GraphNode, { type: "pull_request" }>;
type IssueNode = Extract<GraphNode, { type: "issue" }>;
type DiscussionNode = Extract<GraphNode, { type: "discussion" }>;

export function narrateHeuristic(graph: DecisionGraph): string {
  const focus = graph.nodes.find((node) => node.type === "focus");
  if (!focus || focus.type !== "focus") return ensureCitations("The focus of this question could not be resolved.", graph);

  const commits = nodesOf(graph, "commit").slice().sort(byDate);
  const lineCommits = commits.filter((commit) => commit.data.role === "introduced" || commit.data.role === "modified");
  const newest = lineCommits[lineCommits.length - 1];
  const pulls = nodesOf(graph, "pull_request").slice().sort((a, b) => a.data.number - b.data.number);
  const issues = nodesOf(graph, "issue").slice().sort((a, b) => a.data.number - b.data.number);
  const discussions = nodesOf(graph, "discussion").slice().sort((a, b) => a.data.discussionId.localeCompare(b.data.discussionId));

  const where = focus.data.symbol
    ? `${inlineCode(focus.data.symbol)} in ${inlineCode(focus.data.file)}`
    : `${inlineCode(focus.data.file)}:${focus.data.lineStart}`;
  const hint = focus.data.lineStart === focus.data.lineEnd ? focus.data.snippet.trim() : "";
  const currentLine = newest ? representativeLine(newest.data.added, hint) : representativeLine(focus.data.snippet.split("\n"), hint);
  const newestIssues = newest ? motivatedIssues(graph, newest.id) : [];
  const newestPulls = newest ? linkedPulls(graph, newest.id) : [];

  const paragraphs: string[] = [];
  const answerBits = [`This is about ${where}.`];
  if (newest && currentLine) {
    answerBits.push(
      `Its current text, ${inlineCode(currentLine)}, was set on ${formatDate(newest.data.authoredAt)} by ${cite(newest)} (${newest.data.authorName}), whose message says ${quote(newest.data.summary)}.`,
    );
  } else if (newest) {
    answerBits.push(
      `The latest edit was ${cite(newest)} on ${formatDate(newest.data.authoredAt)}: ${quote(newest.data.summary)}.`,
    );
  }
  if (newestIssues.length > 0) {
    answerBits.push(
      `That change names ${newestIssues.map((issue) => `${cite(issue)} (“${issue.data.title}”)`).join(" and ")} as its motive.`,
    );
  }
  if (newestPulls.length > 0) {
    answerBits.push(`It landed through ${newestPulls.map((pull) => `${cite(pull)} (“${pull.data.title}”)`).join(" and ")}.`);
  }
  paragraphs.push(answerBits.join(" "));

  if (commits.length > 0) {
    paragraphs.push(commits.map((commit) => commitSentence(graph, commit, hint)).join(" "));
  }

  if (pulls.length > 0) {
    paragraphs.push(
      `Pull requests: ${pulls
        .map((pull) => {
          const state = pull.data.synthetic ? "synthetic" : pull.data.merged ? "merged" : pull.data.state;
          return `${cite(pull)} “${pull.data.title}” by ${pull.data.author} (${state}). ${excerpt(pull.data.body)}`;
        })
        .join(" ")}`,
    );
  }

  if (issues.length > 0) {
    paragraphs.push(
      `Issues: ${issues
        .map((issue) => {
          const state = issue.data.synthetic ? "synthetic" : issue.data.state;
          return `${cite(issue)} “${issue.data.title}” by ${issue.data.author} (${state}). ${excerpt(issue.data.body)}`;
        })
        .join(" ")}`,
    );
  }

  if (discussions.length > 0) {
    paragraphs.push(
      `Reviews and discussions: ${discussions
        .map((discussion) => {
          const title = discussion.data.title ? ` “${discussion.data.title}”` : "";
          const whereNote = discussionPlace(discussion);
          return `${discussionLabel(discussion)}${title} by ${discussion.data.author}${whereNote} ${cite(discussion)}: ${excerpt(discussion.data.body)}`;
        })
        .join(" ")}`,
    );
  }

  const synthetic = [...pulls, ...issues, ...discussions].some((node) => node.data.synthetic);
  paragraphs.push(
    synthetic
      ? "Some of those artifacts were reconstructed from commit text because GitHub was not queried, so their titles are only as specific as the messages that named them."
      : "Taken together, the current text is the last edit in that chain, and the issues, pull requests, and review notes are the decisions that put it there.",
  );

  return ensureCitations(paragraphs.filter(Boolean).join("\n\n"), graph);
}

function commitSentence(graph: DecisionGraph, commit: CommitNode, hint: string): string {
  const when = formatDate(commit.data.authoredAt);
  if (commit.data.role === "moved") {
    return `On ${when}, ${cite(commit)} moved ${inlineCode(commit.data.movedFrom ?? "the file")} to ${inlineCode(commit.data.movedTo ?? "a new path")} (“${commit.data.summary}”).`;
  }
  const verb =
    commit.data.role === "introduced"
      ? "introduced the line"
      : commit.data.role === "modified"
        ? "modified the line"
        : "sits on the decision trail";
  const added = representativeLine(commit.data.added, hint);
  const became = added ? ` Afterwards it read ${inlineCode(added)}.` : "";
  const reverts = graph.edges
    .filter((edge) => edge.type === "reverted" && edge.source === commit.id)
    .map((edge) => graph.nodes.find((node) => node.id === edge.target))
    .filter((node): node is CommitNode => node?.type === "commit");
  const revertText =
    reverts.length > 0
      ? ` This reverts ${reverts.map((target) => `${cite(target)} (“${target.data.summary}”)`).join(" and ")}.`
      : "";
  return `On ${when}, ${cite(commit)} ${verb}: ${quote(commit.data.summary)}.${became}${revertText}`;
}

function motivatedIssues(graph: DecisionGraph, source: string): IssueNode[] {
  return graph.edges
    .filter((edge) => edge.type === "motivated-by" && edge.source === source)
    .map((edge) => graph.nodes.find((node) => node.id === edge.target))
    .filter((node): node is IssueNode => node?.type === "issue");
}

function linkedPulls(graph: DecisionGraph, source: string): PullNode[] {
  return graph.edges
    .filter((edge) => edge.type === "linked" && edge.source === source)
    .map((edge) => graph.nodes.find((node) => node.id === edge.target))
    .filter((node): node is PullNode => node?.type === "pull_request");
}

function nodesOf<T extends GraphNode["type"]>(graph: DecisionGraph, type: T): Extract<GraphNode, { type: T }>[] {
  return graph.nodes.filter((node): node is Extract<GraphNode, { type: T }> => node.type === type);
}

function byDate(a: CommitNode, b: CommitNode): number {
  return Date.parse(a.data.authoredAt) - Date.parse(b.data.authoredAt) || a.data.sha.localeCompare(b.data.sha);
}

function cite(node: GraphNode): string {
  return citationFor(node) ?? node.label;
}

function representativeLine(lines: string[], hint: string): string | undefined {
  const plus = lines.map((line) => line.trim()).filter((line) => line.length > 0);
  if (plus.length === 0) return undefined;
  if (!hint || plus.length === 1) return plus[0];
  let best = plus[0] ?? "";
  let bestScore = tokenScore(best, hint);
  for (const line of plus.slice(1)) {
    const score = tokenScore(line, hint);
    if (score >= bestScore) {
      best = line;
      bestScore = score;
    }
  }
  return best;
}

function tokenScore(line: string, hint: string): number {
  const tokens = new Set(hint.toLowerCase().match(/[a-z0-9_]+/g) ?? []);
  let score = 0;
  for (const token of line.toLowerCase().match(/[a-z0-9_]+/g) ?? []) {
    if (tokens.has(token)) score += 1;
  }
  return score;
}

function discussionLabel(discussion: DiscussionNode): string {
  switch (discussion.data.kind) {
    case "review-comment":
      return "Review comment";
    case "review":
      return "Review";
    case "issue-comment":
      return "Issue comment";
    case "thread":
      return "Discussion";
    case "thread-comment":
      return "Discussion reply";
    default:
      return "Note";
  }
}

function discussionPlace(discussion: DiscussionNode): string {
  if (discussion.data.parentType === "pull_request" && discussion.data.parentNumber) {
    return ` on PR #${discussion.data.parentNumber}`;
  }
  if (discussion.data.parentType === "issue" && discussion.data.parentNumber) {
    return ` on issue #${discussion.data.parentNumber}`;
  }
  if (discussion.data.parentType === "discussion") return " in the thread";
  return "";
}
