import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ArchaeologistError } from "./errors.js";

export function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    if (
      existsSync(path.join(dir, "package.json")) &&
      existsSync(path.join(dir, "public", "index.html"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new ArchaeologistError("Could not locate the git-archaeologist package root.");
}

export function bundledFixturePath(): string {
  return path.join(packageRoot(), "fixtures", "github", "acme-widget.json");
}
