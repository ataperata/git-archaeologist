import type { DiskCache } from "../cache/disk-cache.js";
import { ArchaeologistError } from "../errors.js";
import type {
  DiscussionArtifact,
  IssueArtifact,
  PullArtifact,
} from "../types.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface LiveOptions {
  token: string;
  apiUrl: string;
  cache: DiskCache;
  fetchImpl: FetchLike;
}

export class LiveGitHub {
  constructor(private readonly options: LiveOptions) {}

  async commitPullNumbers(owner: string, repo: string, sha: string): Promise<number[]> {
    const payload = await this.getJson<Array<{ number?: number }>>(
      `/repos/${owner}/${repo}/commits/${sha}/pulls`,
    );
    if (!payload) return [];
    return payload.map((pull) => pull.number).filter((number): number is number => typeof number === "number");
  }

  async pull(owner: string, repo: string, number: number): Promise<PullArtifact | null> {
    const payload = await this.getJson<GitHubPull>(`/repos/${owner}/${repo}/pulls/${number}`);
    if (!payload) return null;
    return {
      number: payload.number,
      title: payload.title ?? `Pull request #${number}`,
      body: payload.body ?? "",
      state: payload.state ?? "unknown",
      merged: Boolean(payload.merged_at),
      author: payload.user?.login ?? "unknown",
      url: payload.html_url,
    };
  }

  async issue(owner: string, repo: string, number: number): Promise<IssueArtifact | { pullRequest: true } | null> {
    const payload = await this.getJson<GitHubIssue>(`/repos/${owner}/${repo}/issues/${number}`);
    if (!payload) return null;
    if (payload.pull_request) return { pullRequest: true };
    return {
      number: payload.number,
      title: payload.title ?? `Issue #${number}`,
      body: payload.body ?? "",
      state: payload.state ?? "unknown",
      author: payload.user?.login ?? "unknown",
      url: payload.html_url,
    };
  }

  async reviewComments(owner: string, repo: string, number: number): Promise<DiscussionArtifact[]> {
    const payload = await this.getJson<GitHubReviewComment[]>(
      `/repos/${owner}/${repo}/pulls/${number}/comments?per_page=30`,
    );
    if (!payload) return [];
    return payload.map((comment) => ({
      discussionId: `review-comment:${comment.id}`,
      kind: "review-comment" as const,
      body: comment.body ?? "",
      author: comment.user?.login ?? "unknown",
      parentType: "pull_request" as const,
      parentNumber: number,
      path: comment.path,
      line: comment.line ?? comment.original_line ?? null,
      url: comment.html_url,
      createdAt: comment.created_at,
    }));
  }

  async reviews(owner: string, repo: string, number: number): Promise<DiscussionArtifact[]> {
    const payload = await this.getJson<GitHubReview[]>(`/repos/${owner}/${repo}/pulls/${number}/reviews?per_page=30`);
    if (!payload) return [];
    return payload
      .filter((review) => (review.body ?? "").trim().length > 0)
      .map((review) => ({
        discussionId: `review:${review.id}`,
        kind: "review" as const,
        body: review.body ?? "",
        author: review.user?.login ?? "unknown",
        parentType: "pull_request" as const,
        parentNumber: number,
        url: review.html_url,
      }));
  }

  async issueComments(owner: string, repo: string, number: number): Promise<DiscussionArtifact[]> {
    const payload = await this.getJson<GitHubIssueComment[]>(
      `/repos/${owner}/${repo}/issues/${number}/comments?per_page=30`,
    );
    if (!payload) return [];
    return payload.map((comment) => ({
      discussionId: `issue-comment:${comment.id}`,
      kind: "issue-comment" as const,
      body: comment.body ?? "",
      author: comment.user?.login ?? "unknown",
      parentType: "issue" as const,
      parentNumber: number,
      url: comment.html_url,
      createdAt: comment.created_at,
    }));
  }

  async discussion(owner: string, repo: string, number: number): Promise<DiscussionArtifact[] | null> {
    const query = `query($owner:String!,$name:String!,$number:Int!){
      repository(owner:$owner, name:$name){
        discussion(number:$number){
          number
          title
          body
          url
          author { login }
          comments(first:5){ nodes { author { login } body } }
        }
      }
    }`;
    const payload = await this.postGraphql<{
      repository?: {
        discussion?: {
          number: number;
          title: string;
          body: string;
          url?: string;
          author?: { login?: string };
          comments?: { nodes?: Array<{ author?: { login?: string }; body?: string }> };
        } | null;
      };
    }>(query, { owner, name: repo, number });
    const thread = payload?.repository?.discussion;
    if (!thread) return null;
    const id = `thread:${thread.number}`;
    const nodes: DiscussionArtifact[] = [
      {
        discussionId: id,
        kind: "thread",
        title: thread.title,
        body: thread.body ?? "",
        author: thread.author?.login ?? "unknown",
        parentType: "repository",
        parentNumber: thread.number,
        url: thread.url,
      },
    ];
    for (const [index, comment] of (thread.comments?.nodes ?? []).entries()) {
      if (!(comment.body ?? "").trim()) continue;
      nodes.push({
        discussionId: `thread-comment:${thread.number}.${index + 1}`,
        kind: "thread-comment",
        body: comment.body ?? "",
        author: comment.author?.login ?? "unknown",
        parentType: "discussion",
        parentId: `discussion:${id}`,
      });
    }
    return nodes;
  }

  private async getJson<T>(pathname: string): Promise<T | null> {
    const url = `${this.options.apiUrl}${pathname}`;
    const key = this.options.cache.key(["github", "GET", url]);
    const cached = await this.options.cache.get<T | null>(key);
    if (cached.hit) return cached.value;
    const response = await this.options.fetchImpl(url, { headers: this.headers() });
    if (response.status === 404) {
      await this.options.cache.set(key, null);
      return null;
    }
    if (response.status === 401 || response.status === 403) {
      throw new ArchaeologistError(`GitHub rejected the token (${response.status}) for ${pathname}.`);
    }
    if (!response.ok) {
      throw new ArchaeologistError(`GitHub ${pathname} failed with ${response.status}.`);
    }
    const json = (await response.json()) as T;
    await this.options.cache.set(key, json);
    return json;
  }

  private async postGraphql<T>(query: string, variables: Record<string, unknown>): Promise<T | null> {
    const url = `${this.options.apiUrl}/graphql`;
    const body = JSON.stringify({ query, variables });
    const key = this.options.cache.key(["github", "POST", url, body]);
    const cached = await this.options.cache.get<T | null>(key);
    if (cached.hit) return cached.value;
    const response = await this.options.fetchImpl(url, {
      method: "POST",
      headers: this.headers(),
      body,
    });
    if (response.status === 401 || response.status === 403) {
      throw new ArchaeologistError(`GitHub GraphQL rejected the token (${response.status}).`);
    }
    if (!response.ok) return null;
    const json = (await response.json()) as { data?: T; errors?: unknown[] };
    const value = json.data ?? null;
    await this.options.cache.set(key, value);
    return value;
  }

  private headers(): Record<string, string> {
    return {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.options.token}`,
      "User-Agent": "git-archaeologist",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    };
  }
}

interface GitHubUser {
  login?: string;
}

interface GitHubPull {
  number: number;
  title?: string;
  body?: string | null;
  state?: string;
  merged_at?: string | null;
  user?: GitHubUser;
  html_url?: string;
}

interface GitHubIssue extends GitHubPull {
  pull_request?: { url?: string };
}

interface GitHubReviewComment {
  id: number;
  body?: string;
  user?: GitHubUser;
  path?: string;
  line?: number | null;
  original_line?: number | null;
  html_url?: string;
  created_at?: string;
}

interface GitHubReview {
  id: number;
  body?: string;
  user?: GitHubUser;
  html_url?: string;
}

interface GitHubIssueComment {
  id: number;
  body?: string;
  user?: GitHubUser;
  html_url?: string;
  created_at?: string;
}
