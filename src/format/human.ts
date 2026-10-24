import type { Investigation } from "../types.js";

export function formatInvestigation(report: Investigation): string {
  const lines: string[] = [];
  lines.push(report.question, "", report.narrative, "");
  lines.push(`Narrator: ${report.narrativeMode}`);
  const nodeCount = report.graph.nodes.length;
  const edgeCount = report.graph.edges.length;
  lines.push(`Graph: ${nodeCount} nodes, ${edgeCount} edges (${report.graph.repo.owner ?? "local"}/${report.graph.repo.name ?? "repository"})`);
  if (report.warnings.length > 0) {
    lines.push("", "Notes:");
    for (const warning of report.warnings) lines.push(`- ${warning}`);
  }
  lines.push("", "Decision edges:");
  const decision = report.graph.edges.filter((edge) => edge.type !== "linked");
  for (const edge of decision) {
    lines.push(`- ${edge.type}  ${label(report, edge.source)}  →  ${label(report, edge.target)}`);
  }
  lines.push("");
  return lines.join("\n");
}

function label(report: Investigation, id: string): string {
  return report.graph.nodes.find((node) => node.id === id)?.label ?? id;
}
