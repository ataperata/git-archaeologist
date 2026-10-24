import path from "node:path";
import { DiskCache } from "./cache/disk-cache.js";
import type { AppConfig } from "./config.js";
import { ArchaeologistError } from "./errors.js";
import { readBlob, normalizeRepoFile, resolveRepo } from "./git/repo.js";
import { lineCount, locateSymbol, sliceLines } from "./git/symbol.js";
import { traceLines } from "./git/trace.js";
import { createLiveClient, enrichHistory } from "./github/enrich.js";
import type { FetchLike, LiveGitHub } from "./github/live.js";
import { selectFixture } from "./github/fixture.js";
import { buildDecisionGraph } from "./graph/build.js";
import { narrateHeuristic } from "./narrative/heuristic.js";
import { narrateWithLlm } from "./narrative/llm.js";
import type { Investigation, InvestigateInput, NarrativeMode } from "./types.js";

export interface InvestigateDeps {
  fetchImpl?: FetchLike;
}

export async function investigate(
  input: InvestigateInput,
  config: AppConfig,
  deps: InvestigateDeps = {},
): Promise<Investigation> {
  const offline = input.offline ?? config.offline;
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
  const cache = new DiskCache(path.join(config.cacheDir, "http"));
  const explicitFixture = input.fixture ?? config.fixture;
  const resolved = await resolveRepo(input.repo, config.cacheDir, offline);
  const file = normalizeRepoFile(input.file);
  const blob = await readBlob(resolved.path, file);
  const total = lineCount(blob);
  const symbol = input.symbol?.trim() || undefined;

  let lineStart: number;
  let lineEnd: number;
  if (input.line !== undefined) {
    if (!Number.isInteger(input.line) || input.line < 1) {
      throw new ArchaeologistError("Line numbers start at 1.");
    }
    lineStart = input.line;
    lineEnd = input.end ?? input.line;
    if (!Number.isInteger(lineEnd) || lineEnd < lineStart) {
      throw new ArchaeologistError("--end must be an integer greater than or equal to --line.");
    }
  } else if (symbol) {
    const range = locateSymbol(blob, symbol);
    lineStart = range.start;
    lineEnd = range.end;
  } else {
    throw new ArchaeologistError("Provide a line number or a symbol name.");
  }
  if (lineEnd > total) {
    throw new ArchaeologistError(`Line range ${lineStart}-${lineEnd} is outside ${file} (${total} lines).`);
  }

  const question = input.question?.trim() || defaultQuestion(file, lineStart, lineEnd, symbol);
  const trace = await traceLines(resolved.path, file, lineStart, lineEnd);
  const useLive = !offline && !explicitFixture && Boolean(config.githubToken);
  const fixture = useLive
    ? null
    : selectFixture({
        explicit: explicitFixture,
        owner: resolved.owner,
        name: resolved.name,
        allowOriginMatch: true,
      });

  const preliminary: string[] = [];
  let live: LiveGitHub | null = null;
  if (useLive) {
    if (!resolved.owner || !resolved.name) {
      preliminary.push("No GitHub remote detected, so pull requests and issues were read from commit messages only.");
    } else if (!config.githubToken) {
      preliminary.push("No GitHub token set.");
    } else {
      live = createLiveClient({
        token: config.githubToken,
        apiUrl: config.githubApiUrl,
        cache,
        fetchImpl,
      });
    }
  } else if (fixture) {
    preliminary.push(
      offline
        ? "Offline mode: GitHub artifacts come from the local fixture, and the narrative was written without a model."
        : "No GitHub token set; matching artifacts were loaded from the local fixture.",
    );
  } else {
    preliminary.push(
      "GitHub was not queried. Referenced issues and pull requests were synthesized from commit messages.",
    );
  }

  const artifacts = await enrichHistory({
    commits: trace.commits,
    owner: resolved.owner,
    repo: resolved.name,
    fixture,
    live,
    warnings: preliminary,
  });

  const graph = buildDecisionGraph({
    question,
    file,
    lineStart,
    lineEnd,
    symbol,
    snippet: capSnippet(sliceLines(blob, lineStart, lineEnd)),
    artifacts,
    repo: resolved,
  });

  const canLlm = !offline && Boolean(config.llmApiKey && config.llmBaseUrl);
  let narrativeMode: NarrativeMode = "heuristic";
  let narrative: string;
  if (canLlm && config.llmApiKey && config.llmBaseUrl) {
    try {
      narrative = await narrateWithLlm(graph, config, cache, fetchImpl);
      narrativeMode = "llm";
    } catch (err) {
      const message = err instanceof Error ? err.message : "LLM request failed";
      artifacts.warnings.push(`${message} Fell back to the heuristic narrator.`);
      narrative = narrateHeuristic(graph);
    }
  } else {
    if (!offline && !config.llmApiKey) {
      artifacts.warnings.push("No LLM API key set; the narrative was written by the heuristic narrator.");
    }
    narrative = narrateHeuristic(graph);
  }

  return {
    question,
    narrative,
    narrativeMode,
    warnings: artifacts.warnings,
    graph,
    cache: cache.stats(),
    generatedAt: new Date().toISOString(),
    source: {
      repo: resolved.path,
      requestedRepo: input.repo,
      file,
      lineStart,
      lineEnd,
      symbol,
      offline: offline || (!useLive && narrativeMode === "heuristic"),
    },
  };
}

function defaultQuestion(file: string, start: number, end: number, symbol?: string): string {
  if (symbol) return `Why does ${symbol} in ${file} exist?`;
  if (start === end) return `Why does line ${start} of ${file} exist?`;
  return `Why do lines ${start}-${end} of ${file} exist?`;
}

function capSnippet(snippet: string): string {
  const lines = snippet.split("\n");
  if (lines.length <= 40) return snippet;
  return `${lines.slice(0, 40).join("\n")}\n…`;
}
