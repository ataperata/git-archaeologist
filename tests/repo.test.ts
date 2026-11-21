import { describe, expect, it } from "vitest";
import { parseGitHubRemote } from "../src/git/repo.js";

describe("parseGitHubRemote", () => {
  it("accepts the usual GitHub remote forms", () => {
    for (const url of [
      "https://github.com/acme/widget",
      "https://github.com/acme/widget.git",
      "https://github.com/acme/widget/",
      "git@github.com:acme/widget.git",
      "ssh://git@github.com/acme/widget",
    ]) {
      expect(parseGitHubRemote(url), url).toEqual({ owner: "acme", name: "widget" });
    }
  });

  it("rejects other hosts and names that would escape the mirror cache", () => {
    for (const url of [
      "https://evil.example/github.com/acme/widget",
      "https://notgithub.com/acme/widget",
      "https://github.com/../..",
      "https://github.com/acme/..",
    ]) {
      expect(parseGitHubRemote(url), url).toBeNull();
    }
  });
});
