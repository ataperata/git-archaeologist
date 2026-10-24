import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

interface Envelope<T> {
  storedAt: number;
  value: T;
}

export class DiskCache {
  hits = 0;
  misses = 0;

  constructor(
    private readonly dir: string,
    private readonly ttlMs = 24 * 60 * 60 * 1000,
  ) {}

  key(parts: unknown[]): string {
    return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  }

  async get<T>(key: string): Promise<{ hit: true; value: T } | { hit: false }> {
    const file = this.fileFor(key);
    try {
      const raw = await readFile(file, "utf8");
      const parsed = JSON.parse(raw) as Envelope<T>;
      if (this.ttlMs <= 0 || Date.now() - parsed.storedAt > this.ttlMs) {
        this.misses += 1;
        return { hit: false };
      }
      this.hits += 1;
      return { hit: true, value: parsed.value };
    } catch {
      this.misses += 1;
      return { hit: false };
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    const file = this.fileFor(key);
    await mkdir(path.dirname(file), { recursive: true });
    const envelope: Envelope<T> = { storedAt: Date.now(), value };
    await writeFile(file, JSON.stringify(envelope), "utf8");
  }

  stats(): { hits: number; misses: number } {
    return { hits: this.hits, misses: this.misses };
  }

  private fileFor(key: string): string {
    return path.join(this.dir, key.slice(0, 2), `${key}.json`);
  }
}
