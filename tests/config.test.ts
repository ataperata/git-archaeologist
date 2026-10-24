import { describe, expect, it } from "vitest";
import { loadConfig, parseEnvFile } from "../src/config.js";

describe("config", () => {
  it("parses env files without keeping blanks or comments", () => {
    expect(parseEnvFile("# comment\n\nGITHUB_TOKEN=\nLLM_MODEL=\"gpt-test\"\nNOT VALID=1\n")).toEqual({
      GITHUB_TOKEN: "",
      LLM_MODEL: "gpt-test",
    });
  });

  it("lets the process environment override a file and ignores .env when asked", () => {
    const config = loadConfig(
      {
        HOME: "/tmp/git-archaeologist-home",
        GIT_ARCHAEOLOGIST_OFFLINE: "1",
        LLM_MODEL: "from-env",
        GITHUB_TOKEN: "",
      },
      { loadEnvFile: false },
    );
    expect(config.offline).toBe(true);
    expect(config.llmModel).toBe("from-env");
    expect(config.githubToken).toBeUndefined();
    expect(config.cacheDir).toContain("git-archaeologist");
  });
});
