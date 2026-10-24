import type { DiskCache } from "../cache/disk-cache.js";
import type { AppConfig } from "../config.js";
import { ArchaeologistError } from "../errors.js";
import type { DecisionGraph } from "../types.js";
import { citationFor, ensureCitations } from "./citations.js";
import type { FetchLike } from "../github/live.js";

const SYSTEM = `You write field reports for git-archaeologist. Explain why the focused line or function exists, using only the JSON artifacts in the user message.

Rules:
- Cite every artifact at least once. Copy citation tokens exactly, for example [@commit:SHA], [@pr:12], [@issue:12], or [@discussion:ID].
- Do not invent commits, pull requests, issues, comments, quotes, or motives.
- Attribute motives only to issues, reviews, and commit messages that support them.
- If an artifact is marked synthetic, say its details were not available from GitHub.
- Write four to seven paragraphs of plain prose. No preamble, no bullet list, no trailing index.`;

export async function narrateWithLlm(
  graph: DecisionGraph,
  config: AppConfig,
  cache: DiskCache,
  fetchImpl: FetchLike,
): Promise<string> {
  if (!config.llmBaseUrl || !config.llmApiKey) {
    throw new ArchaeologistError("LLM_BASE_URL and LLM_API_KEY are required for the model narrator.");
  }
  const focus = graph.nodes.find((node) => node.type === "focus");
  const payload = {
    question: focus?.type === "focus" ? focus.data.question : "",
    focus: focus?.type === "focus" ? focus.data : null,
    nodes: graph.nodes
      .filter((node) => node.type !== "focus")
      .map((node) => ({ citation: citationFor(node), type: node.type, label: node.label, data: node.data })),
    edges: graph.edges,
  };
  const body = {
    model: config.llmModel,
    temperature: 0.2,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: JSON.stringify(payload) },
    ],
  };
  const key = cache.key(["llm", config.llmBaseUrl, body]);
  const cached = await cache.get<string>(key);
  if (cached.hit && cached.value.trim()) return ensureCitations(cached.value, graph);

  const response = await fetchImpl(`${config.llmBaseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.llmApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new ArchaeologistError(`LLM request failed (${response.status}).`);
  }
  const json: unknown = await response.json();
  const text = readContent(json);
  if (!text.trim()) throw new ArchaeologistError("LLM response did not include a narrative.");
  await cache.set(key, text);
  return ensureCitations(text, graph);
}

function readContent(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") return "";
  const message = (choices[0] as { message?: unknown }).message;
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return part.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}
