import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Prefer the private home copy so checkout updates cannot remove live targets.
// The ignored legacy file remains supported for existing local installations.
export function readBookConfig(localDirectory, homeDirectory = homedir()) {
  const privatePath = join(homeDirectory, ".onyx_kindle_books.json");
  const legacyPath = join(localDirectory, "books.json");
  const path = existsSync(privatePath) ? privatePath : legacyPath;
  if (!existsSync(path)) {
    throw new Error("Configure Kindle targets in ~/.onyx_kindle_books.json using books.example.json; keep the populated file private.");
  }
  // Invalid private configuration must fail visibly, not silently use stale targets.
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Cannot read Kindle configuration JSON; repair the private configuration locally.");
  }
}
