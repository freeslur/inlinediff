import { platform } from "node:os";

// Walk-skip hint only (performance): directories we never bother crawling when discovering
// projects or watching events. node_modules/dist are here so we don't crawl them, NOT because
// they are protected from tracking — that is governed by .diffignore (see isProtectedPathName).
const excludedNames = new Set([".git", ".inlinediff", "dist", "node_modules"]);
// The mandatory floor that file actions and tracking must never touch, regardless of .diffignore:
// the user's real Git repo and our own store.
const protectedNames = new Set([".git", ".inlinediff"]);
const isCaseInsensitiveFileSystem = platform() === "win32";

export function isInlineDiffStoreName(name: string): boolean {
  return (
    name === ".inlinediff" || (isCaseInsensitiveFileSystem && name.toLowerCase() === ".inlinediff")
  );
}

export function isStructurallyExcludedName(name: string): boolean {
  const normalizedName = name.toLowerCase();
  return (
    excludedNames.has(normalizedName) || normalizedName.startsWith(".inlinediff-initializing-")
  );
}

export function isProtectedPathName(name: string): boolean {
  const normalizedName = name.toLowerCase();
  return (
    protectedNames.has(normalizedName) || normalizedName.startsWith(".inlinediff-initializing-")
  );
}
