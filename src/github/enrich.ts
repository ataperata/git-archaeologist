import type { DiskCache } from "../cache/disk-cache.js";
import type {
  Artifacts,
  CommitLink,
  DiscussionArtifact,
  HistoryCommit,
  IssueArtifact,
  PullArtifact,
} from "../types.js";
import { classifyRefs, parseRefs, type RefCatalog } from "./refs.js";
import { subjectMatches, type FixtureFile } from "./fixture.js";
import { LiveGitHub, type FetchLike } from "./live.js";

export async function enrichHistory(options: {
  commits: HistoryCommit[];
  owner?: string;
  repo?: string;
  fixture: FixtureFile | null;
  live: LiveGitHub | null;
  warnings?: string[];
}): Promise<Artifacts> {
  const warnings = [...(options.warnings ?? [])];
  const catalog = catalogFromFixture(options.fixture);
  const links = new Map<string, CommitLink>();

  for (const commit of options.commits) {
    const text = `${commit.summary}\n${commit.body}`;
    const parsed = parseRefs(text, commit.summary);
    const classified = classifyRefs(parsed, catalog);
    const link = emptyLink(commit.sha);
    addNumbers(link.pullNumbers, classified.pulls);
    addNumbers(link.issueNumbers, classified.issues);
    addDiscussionNumbers(link.discussionIds, classified.discussions);
    if (options.fixture) {
      for (const match of options.fixture.commitMatches) {
        if (!subjectMatches(commit.summary, match.subjectIncludes)) continue;
        addNumbers(link.pullNumbers, match.pulls ?? []);
        addNumbers(link.issueNumbers, match.issues ?? []);
        addDiscussionNumbers(link.discussionIds, match.discussions ?? []);
      }
    }
    links.set(commit.sha, link);
  }

  if (options.live && options.owner && options.repo) {
    for (const commit of options.commits) {
      if (commit.role === "moved") continue;
      const numbers = await options.live.commitPullNumbers(options.owner, options.repo, commit.sha);
      const link = links.get(commit.sha) ?? emptyLink(commit.sha);
      addNumbers(link.pullNumbers, numbers);
      links.set(commit.sha, link);
    }
  }

  const pullNumbers = uniqueNumbers([...links.values()].flatMap((link) => link.pullNumbers));
  const issueNumbers = uniqueNumbers([...links.values()].flatMap((link) => link.issueNumbers));
  const discussionNumbers = uniqueNumbers(
    [...links.values()].flatMap((link) =>
      link.discussionIds
        .filter((id) => id.startsWith("thread:"))
        .map((id) => Number(id.slice("thread:".length)))
        .filter((number) => Number.isFinite(number)),
    ),
  );

  const pulls: PullArtifact[] = [];
  for (const number of pullNumbers) {
    pulls.push(await loadPull(number, options, warnings));
  }
  for (const pull of pulls) {
    const refs = classifyRefs(parseRefs(`${pull.title}\n${pull.body}`), catalog);
    addNumbers(issueNumbers, refs.issues);
    for (const discussionNumber of refs.discussions) {
      if (!discussionNumbers.includes(discussionNumber)) discussionNumbers.push(discussionNumber);
    }
  }

  const issues: IssueArtifact[] = [];
  const pullsFromIssues: PullArtifact[] = [];
  for (const number of issueNumbers) {
    if (pulls.some((pull) => pull.number === number)) continue;
    const loaded = await loadIssue(number, options, warnings);
    if (loaded.kind === "pull") pullsFromIssues.push(loaded.pull);
    else issues.push(loaded.issue);
  }
  for (const pull of pullsFromIssues) {
    if (!pulls.some((existing) => existing.number === pull.number)) pulls.push(pull);
  }

  const discussions: DiscussionArtifact[] = [];
  for (const pull of pulls) {
    discussions.push(...(await loadPullConversation(pull.number, options)));
  }
  for (const issue of issues) {
    discussions.push(...(await loadIssueConversation(issue.number, options)));
  }
  for (const number of discussionNumbers) {
    discussions.push(...(await loadThread(number, options, warnings)));
  }

  const dedupedDiscussions = dedupeDiscussions(discussions);
  return {
    commits: options.commits,
    pulls,
    issues,
    discussions: dedupedDiscussions,
    commitLinks: [...links.values()],
    warnings,
  };
}

export function createLiveClient(options: {
  token: string;
  apiUrl: string;
  cache: DiskCache;
  fetchImpl: FetchLike;
}): LiveGitHub {
  return new LiveGitHub(options);
}

function catalogFromFixture(fixture: FixtureFile | null): RefCatalog {
  return {
    pulls: new Set(Object.keys(fixture?.pulls ?? {}).map(Number)),
    issues: new Set(Object.keys(fixture?.issues ?? {}).map(Number)),
  };
}

async function loadPull(
  number: number,
  options: { owner?: string; repo?: string; fixture: FixtureFile | null; live: LiveGitHub | null },
  warnings: string[],
): Promise<PullArtifact> {
  const fixturePull = options.fixture?.pulls[String(number)];
  if (fixturePull) return { ...fixturePull };
  if (options.live && options.owner && options.repo) {
    const live = await options.live.pull(options.owner, options.repo, number);
    if (live) return live;
  }
  warnings.push(`Pull request #${number} was synthesized from text; GitHub details were not available.`);
  return syntheticPull(number, options.owner, options.repo);
}

async function loadIssue(
  number: number,
  options: { owner?: string; repo?: string; fixture: FixtureFile | null; live: LiveGitHub | null },
  warnings: string[],
): Promise<{ kind: "issue"; issue: IssueArtifact } | { kind: "pull"; pull: PullArtifact }> {
  const fixtureIssue = options.fixture?.issues[String(number)];
  if (fixtureIssue) return { kind: "issue", issue: { ...fixtureIssue } };
  const fixturePull = options.fixture?.pulls[String(number)];
  if (fixturePull) return { kind: "pull", pull: { ...fixturePull } };
  if (options.live && options.owner && options.repo) {
    const live = await options.live.issue(options.owner, options.repo, number);
    if (live && "pullRequest" in live) {
      const pull = await options.live.pull(options.owner, options.repo, number);
      if (pull) return { kind: "pull", pull };
    } else if (live) {
      return { kind: "issue", issue: live };
    }
  }
  warnings.push(`Issue #${number} was synthesized from text; GitHub details were not available.`);
  return { kind: "issue", issue: syntheticIssue(number, options.owner, options.repo) };
}

async function loadPullConversation(
  number: number,
  options: { owner?: string; repo?: string; fixture: FixtureFile | null; live: LiveGitHub | null },
): Promise<DiscussionArtifact[]> {
  if (options.fixture?.reviewComments[String(number)] || options.fixture?.reviews[String(number)]) {
    const comments = options.fixture.reviewComments[String(number)] ?? [];
    const reviews = options.fixture.reviews[String(number)] ?? [];
    return [
      ...comments.map((comment) => ({
        discussionId: `review-comment:${comment.id}`,
        kind: "review-comment" as const,
        body: comment.body,
        author: comment.author,
        parentType: "pull_request" as const,
        parentNumber: number,
        path: comment.path,
        line: comment.line ?? null,
        url: comment.url,
        createdAt: comment.createdAt,
      })),
      ...reviews
        .filter((review) => review.body.trim())
        .map((review) => ({
          discussionId: `review:${review.id}`,
          kind: "review" as const,
          body: review.body,
          author: review.author,
          parentType: "pull_request" as const,
          parentNumber: number,
          url: review.url,
        })),
    ];
  }
  if (options.live && options.owner && options.repo) {
    const [comments, reviews] = await Promise.all([
      options.live.reviewComments(options.owner, options.repo, number),
      options.live.reviews(options.owner, options.repo, number),
    ]);
    return [...comments, ...reviews];
  }
  return [];
}

async function loadIssueConversation(
  number: number,
  options: { owner?: string; repo?: string; fixture: FixtureFile | null; live: LiveGitHub | null },
): Promise<DiscussionArtifact[]> {
  const fixtureComments = options.fixture?.issueComments[String(number)];
  if (fixtureComments) {
    return fixtureComments.map((comment) => ({
      discussionId: `issue-comment:${comment.id}`,
      kind: "issue-comment" as const,
      body: comment.body,
      author: comment.author,
      parentType: "issue" as const,
      parentNumber: number,
      url: comment.url,
      createdAt: comment.createdAt,
    }));
  }
  if (options.live && options.owner && options.repo) {
    return options.live.issueComments(options.owner, options.repo, number);
  }
  return [];
}

async function loadThread(
  number: number,
  options: { owner?: string; repo?: string; fixture: FixtureFile | null; live: LiveGitHub | null },
  warnings: string[],
): Promise<DiscussionArtifact[]> {
  const fixtureThread = options.fixture?.discussions[String(number)];
  if (fixtureThread) {
    const id = `thread:${fixtureThread.number}`;
    const nodes: DiscussionArtifact[] = [
      {
        discussionId: id,
        kind: "thread",
        title: fixtureThread.title,
        body: fixtureThread.body,
        author: fixtureThread.author,
        parentType: "repository",
        parentNumber: fixtureThread.number,
        url: fixtureThread.url,
      },
    ];
    for (const comment of fixtureThread.comments ?? []) {
      nodes.push({
        discussionId: `thread-comment:${comment.id}`,
        kind: "thread-comment",
        body: comment.body,
        author: comment.author,
        parentType: "discussion",
        parentId: `discussion:${id}`,
        createdAt: comment.createdAt,
      });
    }
    return nodes;
  }
  if (options.live && options.owner && options.repo) {
    const live = await options.live.discussion(options.owner, options.repo, number);
    if (live) return live;
  }
  warnings.push(`Discussion #${number} was synthesized from text; GitHub details were not available.`);
  return [
    {
      discussionId: `thread:${number}`,
      kind: "thread",
      title: `Discussion #${number}`,
      body: "Referenced from commit or pull request text. No offline fixture or GitHub response was available.",
      author: "unknown",
      parentType: "repository",
      parentNumber: number,
      synthetic: true,
    },
  ];
}

function syntheticPull(number: number, owner?: string, repo?: string): PullArtifact {
  return {
    number,
    title: `Pull request #${number}`,
    body: "Referenced from commit text. No offline fixture or GitHub response was available for this number.",
    state: "unknown",
    merged: false,
    author: "unknown",
    url: owner && repo ? `https://github.com/${owner}/${repo}/pull/${number}` : undefined,
    synthetic: true,
  };
}

function syntheticIssue(number: number, owner?: string, repo?: string): IssueArtifact {
  return {
    number,
    title: `Issue #${number}`,
    body: "Referenced from commit or pull request text. No offline fixture or GitHub response was available for this number.",
    state: "unknown",
    author: "unknown",
    url: owner && repo ? `https://github.com/${owner}/${repo}/issues/${number}` : undefined,
    synthetic: true,
  };
}

function emptyLink(sha: string): CommitLink {
  return { sha, pullNumbers: [], issueNumbers: [], discussionIds: [] };
}

function addNumbers(target: number[], values: number[]): void {
  for (const value of values) {
    if (!target.includes(value)) target.push(value);
  }
  target.sort((a, b) => a - b);
}

function addDiscussionNumbers(target: string[], numbers: number[]): void {
  for (const number of numbers) {
    const id = `thread:${number}`;
    if (!target.includes(id)) target.push(id);
  }
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function dedupeDiscussions(discussions: DiscussionArtifact[]): DiscussionArtifact[] {
  const seen = new Set<string>();
  const out: DiscussionArtifact[] = [];
  for (const discussion of discussions) {
    if (seen.has(discussion.discussionId)) continue;
    seen.add(discussion.discussionId);
    out.push(discussion);
  }
  return out;
}
