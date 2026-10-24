import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { ArchaeologistError } from "../errors.js";
import { bundledFixturePath } from "../paths.js";

export interface FixtureReviewComment {
  id: number;
  author: string;
  body: string;
  path?: string;
  line?: number | null;
  createdAt?: string;
  url?: string;
}

export interface FixtureReview {
  id: number;
  author: string;
  body: string;
  state: string;
  url?: string;
}

export interface FixtureIssueComment {
  id: number;
  author: string;
  body: string;
  createdAt?: string;
  url?: string;
}

export interface FixtureDiscussionComment {
  id: number;
  author: string;
  body: string;
  createdAt?: string;
}

export interface FixtureDiscussion {
  number: number;
  title: string;
  body: string;
  author: string;
  url?: string;
  comments?: FixtureDiscussionComment[];
}

export interface FixturePull {
  number: number;
  title: string;
  body: string;
  state: string;
  merged: boolean;
  author: string;
  url?: string;
}

export interface FixtureIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  author: string;
  url?: string;
}

export interface FixtureFile {
  id: string;
  commitMatches: Array<{
    subjectIncludes: string;
    pulls?: number[];
    issues?: number[];
    discussions?: number[];
  }>;
  pulls: Record<string, FixturePull>;
  issues: Record<string, FixtureIssue>;
  discussions: Record<string, FixtureDiscussion>;
  reviewComments: Record<string, FixtureReviewComment[]>;
  reviews: Record<string, FixtureReview[]>;
  issueComments: Record<string, FixtureIssueComment[]>;
}

export function loadFixtureFile(idOrPath: string): FixtureFile {
  const target = idOrPath === "acme/widget" || idOrPath === "acme-widget" ? bundledFixturePath() : idOrPath;
  if (!existsSync(target)) throw new ArchaeologistError(`Fixture not found: ${idOrPath}`);
  const parsed = JSON.parse(readFileSync(target, "utf8")) as FixtureFile;
  if (!parsed.id || !parsed.pulls || !parsed.issues) {
    throw new ArchaeologistError(`Fixture ${idOrPath} is missing required fields.`);
  }
  return parsed;
}

export function selectFixture(options: {
  explicit?: string;
  owner?: string;
  name?: string;
  allowOriginMatch: boolean;
}): FixtureFile | null {
  if (options.explicit) return loadFixtureFile(options.explicit);
  if (options.allowOriginMatch && options.owner && options.name) {
    const id = `${options.owner}/${options.name}`;
    if (id === "acme/widget") return loadFixtureFile("acme/widget");
  }
  return null;
}

export function subjectMatches(summary: string, needle: string): boolean {
  const revert = summary.startsWith("Revert ");
  const needleRevert = needle.startsWith("Revert ");
  if (revert !== needleRevert) return false;
  return summary.includes(needle);
}
