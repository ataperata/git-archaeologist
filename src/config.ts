import { readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ArchaeologistError } from "./errors.js";

export interface AppConfig {
  offline: boolean;
  githubToken?: string;
  githubApiUrl: string;
  llmBaseUrl?: string;
  llmApiKey?: string;
  llmModel: string;
  cacheDir: string;
  fixture?: string;
}

export interface LoadConfigOptions {
  cwd?: string;
  loadEnvFile?: boolean;
}

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, options: LoadConfigOptions = {}): AppConfig {
  const merged: NodeJS.ProcessEnv = { ...env };
  if (options.loadEnvFile !== false) {
    const envPath = path.join(options.cwd ?? process.cwd(), ".env");
    if (existsSync(envPath)) {
      const parsed = parseEnvFile(readFileSync(envPath, "utf8"));
      for (const [key, value] of Object.entries(parsed)) {
        if (merged[key] === undefined) merged[key] = value;
      }
    }
  }
  return configFromEnv(merged);
}

export function configFromEnv(env: NodeJS.ProcessEnv): AppConfig {
  const offline = truthy(env.GIT_ARCHAEOLOGIST_OFFLINE);
  const token = blankToUndefined(env.GITHUB_TOKEN);
  const llmKey = blankToUndefined(env.LLM_API_KEY);
  const llmBase = blankToUndefined(env.LLM_BASE_URL);
  return {
    offline,
    githubToken: token,
    githubApiUrl: (blankToUndefined(env.GITHUB_API_URL) ?? "https://api.github.com").replace(/\/$/, ""),
    llmBaseUrl: llmBase,
    llmApiKey: llmKey,
    llmModel: blankToUndefined(env.LLM_MODEL) ?? "gpt-4o-mini",
    cacheDir: blankToUndefined(env.GIT_ARCHAEOLOGIST_CACHE_DIR) ?? defaultCacheDir(env),
    fixture: blankToUndefined(env.GIT_ARCHAEOLOGIST_FIXTURE),
  };
}

export function defaultCacheDir(env: NodeJS.ProcessEnv): string {
  const xdg = blankToUndefined(env.XDG_CACHE_HOME);
  if (xdg) return path.join(xdg, "git-archaeologist");
  const home = blankToUndefined(env.HOME) ?? os.homedir();
  return path.join(home, ".cache", "git-archaeologist");
}

export function assertLocalBind(host: string): void {
  const normalized = host.trim().toLowerCase();
  const loopback = new Set(["127.0.0.1", "localhost", "::1"]);
  if (!loopback.has(normalized)) {
    throw new ArchaeologistError(
      `Refusing to bind ${host}. The local UI can read any repository the process can see; use 127.0.0.1.`,
    );
  }
}

function truthy(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function blankToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
