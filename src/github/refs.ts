export interface ParsedRefs {
  pulls: number[];
  issues: number[];
  discussions: number[];
  reverts: string[];
  bare: number[];
}

export function parseRefs(text: string, subject?: string): ParsedRefs {
  const subjectText = subject ?? text.split("\n")[0] ?? "";
  const unquotedSubject = subjectText.replace(/"[^"]*"/g, "");
  const body = text.startsWith(subjectText) ? text.slice(subjectText.length).replace(/^\n/, "") : text;
  // Quoted revert subjects repeat the original pull number; don't treat that as this commit's link.
  const scan = `${unquotedSubject}\n${body}`;
  const pulls = new Set<number>();
  const issues = new Set<number>();
  const discussions = new Set<number>();
  const reverts = new Set<string>();
  const bare = new Set<number>();

  for (const match of unquotedSubject.matchAll(/\(#(\d+)\)/g)) pulls.add(Number(match[1]));
  for (const match of scan.matchAll(/\bmerge pull request #(\d+)\b/gi)) pulls.add(Number(match[1]));
  for (const match of scan.matchAll(/\bdiscussion\s+#(\d+)\b/gi)) discussions.add(Number(match[1]));
  for (const match of scan.matchAll(/This reverts commit ([0-9a-f]{7,40})\./gi)) reverts.add(match[1] ?? "");

  const closing = /\b(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?|see|refs?|references)\s+#(\d+)\b/gi;
  for (const match of scan.matchAll(closing)) issues.add(Number(match[1]));

  for (const match of scan.matchAll(/#(\d+)\b/g)) {
    const number = Number(match[1]);
    if (pulls.has(number) || issues.has(number) || discussions.has(number)) continue;
    bare.add(number);
  }

  return {
    pulls: [...pulls],
    issues: [...issues],
    discussions: [...discussions],
    reverts: [...reverts].filter(Boolean),
    bare: [...bare],
  };
}

export interface RefCatalog {
  pulls: Set<number>;
  issues: Set<number>;
}

export function classifyRefs(refs: ParsedRefs, catalog: RefCatalog): {
  pulls: number[];
  issues: number[];
  discussions: number[];
} {
  const pulls = new Set(refs.pulls);
  const issues = new Set(refs.issues);
  for (const number of refs.bare) {
    if (catalog.pulls.has(number) && !catalog.issues.has(number)) pulls.add(number);
    else issues.add(number);
  }
  for (const number of [...issues]) {
    if (catalog.pulls.has(number) && !catalog.issues.has(number)) {
      issues.delete(number);
      pulls.add(number);
    }
  }
  for (const number of [...pulls]) {
    if (catalog.issues.has(number) && !catalog.pulls.has(number)) {
      pulls.delete(number);
      issues.add(number);
    }
  }
  return {
    pulls: [...pulls].sort((a, b) => a - b),
    issues: [...issues].sort((a, b) => a - b),
    discussions: [...refs.discussions].sort((a, b) => a - b),
  };
}
