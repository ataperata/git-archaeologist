import { afterEach, beforeEach } from "vitest";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) {
      return originalFetch(input, init);
    }
    throw new Error(`Network access is disabled in tests (${url})`);
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});
