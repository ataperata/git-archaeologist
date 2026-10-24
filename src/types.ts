export type NodeType = "focus" | "commit" | "pull_request" | "issue" | "discussion";

export type EdgeType = "introduced" | "modified" | "motivated-by" | "reverted" | "linked";

export type CommitRole = "introduced" | "modified" | "moved" | "related";

export type NarrativeMode = "heuristic" | "llm";

export type DiscussionKind = "review-comment" | "review" | "issue-comment" | "thread" | "thread-comment";

export interface HistoryCommit {
  sha: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  summary: string;
  body: string;
  file?: string;
  added: string[];
  removed: string[];
  role: CommitRole;
  revertedSha?: string;
  movedFrom?: string;
  movedTo?: string;
}

export interface TraceResult {
  commits: HistoryCommit[];
}

export interface PullArtifact {
  number: number;
  title: string;
  body: string;
  state: string;
  merged: boolean;
  author: string;
  url?: string;
  synthetic?: boolean;
}

export interface IssueArtifact {
  number: number;
  title: string;
  body: string;
  state: string;
  author: string;
  url?: string;
  synthetic?: boolean;
}

export interface DiscussionArtifact {
  discussionId: string;
  kind: DiscussionKind;
  title?: string;
  body: string;
  author: string;
  parentType: "pull_request" | "issue" | "discussion" | "repository";
  parentNumber?: number;
  parentId?: string;
  path?: string;
  line?: number | null;
  url?: string;
  createdAt?: string;
  synthetic?: boolean;
}

export interface CommitLink {
  sha: string;
  pullNumbers: number[];
  issueNumbers: number[];
  discussionIds: string[];
}

export interface Artifacts {
  commits: HistoryCommit[];
  pulls: PullArtifact[];
  issues: IssueArtifact[];
  discussions: DiscussionArtifact[];
  commitLinks: CommitLink[];
  warnings: string[];
}

export interface FocusData {
  file: string;
  lineStart: number;
  lineEnd: number;
  symbol?: string;
  snippet: string;
  question: string;
}

export interface CommitData {
  sha: string;
  shortSha: string;
  summary: string;
  body: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  parents: string[];
  role: CommitRole;
  file?: string;
  added: string[];
  removed: string[];
  revertedSha?: string;
  movedFrom?: string;
  movedTo?: string;
  url?: string;
}

export interface PullData {
  number: number;
  title: string;
  body: string;
  state: string;
  merged: boolean;
  author: string;
  url?: string;
  synthetic?: boolean;
}

export interface IssueData {
  number: number;
  title: string;
  body: string;
  state: string;
  author: string;
  url?: string;
  synthetic?: boolean;
}

export interface DiscussionData {
  discussionId: string;
  kind: DiscussionKind;
  title?: string;
  body: string;
  author: string;
  parentType: DiscussionArtifact["parentType"];
  parentNumber?: number;
  parentId?: string;
  path?: string;
  line?: number | null;
  url?: string;
  createdAt?: string;
  synthetic?: boolean;
}

export type GraphNode =
  | { id: string; type: "focus"; label: string; data: FocusData }
  | { id: string; type: "commit"; label: string; data: CommitData }
  | { id: string; type: "pull_request"; label: string; data: PullData }
  | { id: string; type: "issue"; label: string; data: IssueData }
  | { id: string; type: "discussion"; label: string; data: DiscussionData };

export interface GraphEdge {
  id: string;
  type: EdgeType;
  source: string;
  target: string;
  evidence?: string;
}

export interface RepoIdentity {
  path: string;
  owner?: string;
  name?: string;
  head: string;
  remoteUrl?: string;
}

export interface DecisionGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  repo: RepoIdentity;
}

export interface InvestigationSource {
  repo: string;
  requestedRepo: string;
  file: string;
  lineStart: number;
  lineEnd: number;
  symbol?: string;
  offline: boolean;
}

export interface Investigation {
  question: string;
  narrative: string;
  narrativeMode: NarrativeMode;
  warnings: string[];
  graph: DecisionGraph;
  cache: { hits: number; misses: number };
  generatedAt: string;
  source: InvestigationSource;
}

export interface InvestigateInput {
  repo: string;
  file: string;
  line?: number;
  end?: number;
  symbol?: string;
  question?: string;
  offline?: boolean;
  fixture?: string;
}

export interface CacheStats {
  hits: number;
  misses: number;
}
