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

  it("ends a Python body at its last code line, even at the end of the file", () => {
    const source = `def first():
    value = 1

    return value


def last(x):
    return x + 1
`;
    expect(locateSymbol(source, "first")).toMatchObject({ start: 1, end: 4 });
    expect(locateSymbol(source, "last")).toMatchObject({ start: 7, end: 8 });
  });

  it("prefers the declaration over an earlier call site", () => {
    const ts = `export function main() {
  return helper(1);
}

function helper(x: number) {
  const y = x + 1;
  return y;
}
`;
    expect(locateSymbol(ts, "helper")).toMatchObject({ start: 5, end: 8 });

    const py = `def main():
    return helper(1)

def helper(x):
    return x + 1
`;
    expect(locateSymbol(py, "helper")).toMatchObject({ start: 4, end: 5 });

    const method = `class Cart {
  total() {
    return this.price();
  }
  price() {
    return 1;
  }
}
`;
    expect(locateSymbol(method, "price")).toMatchObject({ start: 5, end: 7 });
  });

  it("finds generic function declarations", () => {
    const source = `export function first<T>(items: T[]): T | undefined {
  return items[0];
}
`;
    expect(locateSymbol(source, "first")).toMatchObject({ start: 1, end: 3 });
  });

  it("rejects an unknown symbol", () => {
    expect(() => locateSymbol("const value = 1;\n", "missing")).toThrow(ArchaeologistError);
  });
});
