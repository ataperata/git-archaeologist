import { describe, expect, it } from "vitest";
import { ArchaeologistError } from "../src/errors.js";
import { locateSymbol } from "../src/git/symbol.js";

describe("locateSymbol", () => {
  it("does not stop at a TypeScript type literal on the signature", () => {
    const source = `export function refreshSession(token: { value?: string; expired?: boolean } | null): SessionResult {
  if (token == null || token.expired) return { ok: false };
  return { ok: true, token: token.value ?? "" };
}
`;
    const range = locateSymbol(source, "refreshSession");
    expect(range.end).toBeGreaterThan(range.start);
    expect(source.split("\n")[range.end - 1]).toBe("}");
  });

  it("matches braces outside of strings", () => {
    const source = `export function refreshSession(token) {
  const example = "{ not a brace";
  if (!token) return null;
  return token;
}
`;
    const range = locateSymbol(source, "refreshSession");
    expect(range.start).toBe(1);
    expect(source.split("\n")[range.end - 1]).toBe("}");
  });

  it("uses indentation for Python", () => {
    const source = `def refresh_session(token):
    if token is None:
        return None
    return token

def other():
    return 1
`;
    const range = locateSymbol(source, "refresh_session");
    const text = source.split("\n").slice(range.start - 1, range.end).join("\n");
    expect(text).toContain("return token");
    expect(text).not.toContain("def other");
  });

  it("rejects an unknown symbol", () => {
    expect(() => locateSymbol("const value = 1;\n", "missing")).toThrow(ArchaeologistError);
  });
});
