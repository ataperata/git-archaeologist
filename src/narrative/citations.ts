import type { DecisionGraph, GraphNode } from "../types.js";

export const CITATION_SOURCE = String.raw`\[@(commit|pr|issue|discussion):([^\]]+)\]`;

export function citationFor(node: GraphNode): string | null {
  switch (node.type) {
    case "focus":
      return null;
    case "commit":
      return `[@commit:${node.data.sha}]`;
    case "pull_request":
      return `[@pr:${node.data.number}]`;
    case "issue":
      return `[@issue:${node.data.number}]`;
    case "discussion":
      return `[@discussion:${node.data.discussionId}]`;
    default:
      return null;
  }
}

export function missingCitations(narrative: string, graph: DecisionGraph): string[] {
  const missing: string[] = [];
  for (const node of graph.nodes) {
    const token = citationFor(node);
    if (token && !narrative.includes(token)) missing.push(token);
  }
  return missing;
}

export function ensureCitations(narrative: string, graph: DecisionGraph): string {
  const missing = graph.nodes.flatMap((node) => {
    const token = citationFor(node);
    if (!token || narrative.includes(token)) return [];
    return [describe(node, token)];
  });
  const trimmed = narrative.trim();
  if (missing.length === 0) return trimmed;
  return `${trimmed}\n\nAlso on the record: ${missing.join("; ")}.`;
}

function describe(node: GraphNode, token: string): string {
  if (node.type === "commit") return `${node.data.summary} ${token}`;
  if (node.type === "pull_request") return `PR “${node.data.title}” ${token}`;
  if (node.type === "issue") return `issue “${node.data.title}” ${token}`;
  if (node.type === "discussion") return `${node.data.author}'s note ${token}`;
  return token;
}
