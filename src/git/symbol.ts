import { ArchaeologistError } from "../errors.js";

export interface SymbolRange {
  start: number;
  end: number;
  line: string;
}

export function locateSymbol(source: string, symbol: string): SymbolRange {
  if (!symbol.trim()) throw new ArchaeologistError("Symbol name is empty.");
  const lines = normalizeNewlines(source).split("\n");
  const matches = declarationLines(lines, symbol);
  if (matches.length === 0) {
    throw new ArchaeologistError(`Could not find a declaration for “${symbol}”. Pass --line to point at it directly.`);
  }
  const startIndex = matches[0] ?? 0;
  const endIndex = rangeEnd(lines, startIndex);
  return {
    start: startIndex + 1,
    end: endIndex + 1,
    line: lines[startIndex] ?? "",
  };
}

export function lineCount(source: string): number {
  if (source.length === 0) return 0;
  const normalized = normalizeNewlines(source);
  const parts = normalized.split("\n");
  return normalized.endsWith("\n") ? parts.length - 1 : parts.length;
}

export function sliceLines(source: string, start: number, end: number): string {
  const lines = normalizeNewlines(source).split("\n");
  return lines.slice(start - 1, end).join("\n");
}

function normalizeNewlines(source: string): string {
  return source.replace(/\r\n/g, "\n");
}

function declarationLines(lines: string[], symbol: string): number[] {
  const name = escapeRegExp(symbol);
  const patterns = [
    new RegExp(`\\bfunction\\s+${name}\\s*\\(`),
    new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=`),
    new RegExp(`\\bdef\\s+${name}\\s*\\(`),
    new RegExp(`\\bfunc\\s+(?:\\([^)]*\\)\\s*)?${name}\\s*\\(`),
    new RegExp(`\\b${name}\\s*\\([^;]*\\)\\s*(?::[^{]+)?\\{`),
    new RegExp(`\\b${name}\\s*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|[A-Za-z_][\\w]*)\\s*=>`),
    new RegExp(`\\b${name}\\s*\\(`),
  ];
  const found: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (patterns.some((pattern) => pattern.test(line))) found.push(i);
  }
  return found;
}

function rangeEnd(lines: string[], startIndex: number): number {
  const signature = lines[startIndex] ?? "";
  if (/^\s*def\s+/.test(signature) || looksLikePython(lines, startIndex)) {
    return pythonEnd(lines, startIndex);
  }
  const brace = braceEnd(lines, startIndex);
  if (brace !== null) return brace;
  return indentEnd(lines, startIndex);
}

function looksLikePython(lines: string[], startIndex: number): boolean {
  const signature = lines[startIndex] ?? "";
  if (!signature.includes("(") || signature.includes("{")) return false;
  const next = lines.slice(startIndex + 1, startIndex + 6).join("\n");
  return !next.includes("{") && /^\s+\S/m.test(next);
}

function pythonEnd(lines: string[], startIndex: number): number {
  const base = indentOf(lines[startIndex] ?? "");
  let end = startIndex;
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (!line.trim()) {
      end = i;
      continue;
    }
    if (indentOf(line) <= base) break;
    end = i;
  }
  return end;
}

function indentEnd(lines: string[], startIndex: number): number {
  return pythonEnd(lines, startIndex);
}

function indentOf(line: string): number {
  const match = /^\s*/.exec(line);
  return match ? match[0].length : 0;
}

function braceEnd(lines: string[], startIndex: number): number | null {
  const text = lines.slice(startIndex).join("\n");
  const relative = scanBraces(text);
  if (relative === null) return null;
  const consumed = text.slice(0, relative + 1);
  return startIndex + consumed.split("\n").length - 1;
}

function scanBraces(text: string): number | null {
  let depth = 0;
  let bodyOpen = -1;
  let i = 0;
  let state: "code" | "single" | "double" | "template" | "line" | "block" = "code";
  while (i < text.length) {
    const ch = text[i] ?? "";
    const next = text[i + 1] ?? "";
    if (state === "line") {
      if (ch === "\n") state = "code";
      i += 1;
      continue;
    }
    if (state === "block") {
      if (ch === "*" && next === "/") {
        state = "code";
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (state === "single" || state === "double" || state === "template") {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      const quote = state === "single" ? "'" : state === "double" ? '"' : "`";
      if (ch === quote) state = "code";
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      state = "line";
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      state = "block";
      i += 2;
      continue;
    }
    if (ch === "'") {
      state = "single";
      i += 1;
      continue;
    }
    if (ch === '"') {
      state = "double";
      i += 1;
      continue;
    }
    if (ch === "`") {
      state = "template";
      i += 1;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) bodyOpen = i;
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0 && bodyOpen >= 0) {
        const sameLine = text.lastIndexOf("\n", bodyOpen) === text.lastIndexOf("\n", i);
        const lineEnd = text.indexOf("\n", i);
        const after = text.slice(i + 1, lineEnd === -1 ? text.length : lineEnd).trim();
        // A `{ ... }` pair that closes mid-signature is a type or object literal, not the body.
        if (!sameLine || /^[;),]*$/.test(after)) return i;
        bodyOpen = -1;
      }
    }
    i += 1;
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
