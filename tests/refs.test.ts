import { describe, expect, it } from "vitest";
import { classifyRefs, parseRefs } from "../src/github/refs.js";

describe("parseRefs", () => {
  it("treats parenthetical numbers as pull requests and closing keywords as issues", () => {
    const refs = parseRefs("Fix the guard (#8)\n\nFixes #9\n");
    expect(refs.pulls).toEqual([8]);
    expect(refs.issues).toEqual([9]);
  });

  it("does not treat a pull number inside a revert subject as this commit's pull request", () => {
    const subject = 'Revert "Broaden the guard after review (#40)"';
    const refs = parseRefs(`${subject}\n\nThis reverts commit abcdef1234567890.\n`, subject);
    expect(refs.pulls).toEqual([]);
    expect(refs.bare).toEqual([]);
    expect(refs.reverts).toEqual(["abcdef1234567890"]);
  });

  it("captures discussion numbers", () => {
    expect(parseRefs("Refines the approach from discussion #3.").discussions).toEqual([3]);
  });

  it("classifies bare numbers with a fixture catalog", () => {
    const refs = parseRefs("See the notes in #40 and #12");
    const classified = classifyRefs(refs, { pulls: new Set([40]), issues: new Set([12]) });
    expect(classified.pulls).toEqual([40]);
    expect(classified.issues).toEqual([12]);
  });
});
