import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DiskCache } from "../src/cache/disk-cache.js";

describe("DiskCache", () => {
  let dir = "";

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = "";
  });

  it("returns cached values and counts hits", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "ga-cache-"));
    const cache = new DiskCache(dir);
    const key = cache.key(["github", "GET", "https://api.github.com/repos/acme/widget"]);
    expect(cache.key(["github", "GET", "https://api.github.com/repos/acme/widget"])).toBe(key);
    expect((await cache.get(key)).hit).toBe(false);
    await cache.set(key, { ok: true });
    const hit = await cache.get<{ ok: boolean }>(key);
    expect(hit).toEqual({ hit: true, value: { ok: true } });
    expect(cache.stats()).toEqual({ hits: 1, misses: 1 });
  });

  it("treats a non-positive ttl as already expired", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "ga-cache-"));
    const cache = new DiskCache(dir, 0);
    const key = cache.key(["llm", "prompt"]);
    await cache.set(key, "narrative");
    expect((await cache.get(key)).hit).toBe(false);
  });
});
