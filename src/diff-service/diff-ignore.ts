import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isMissingPathError } from "../errors/fs-errors.ts";
import { gitRepositoryPath, runProjectGit, withProjectGitLock } from "./git-command.ts";
import { normalizeRelativePath } from "./project-path.ts";

const diffIgnorePath = ".diffignore";

// Appended AFTER the user's rules so this floor cannot be overridden. It covers Git internals,
// our own store, and the dependency / virtual-env / build-cache folders that are pure machine
// data nobody reviews line-by-line — keeping huge trees (node_modules, target, .venv, …) out of
// tracking entirely. The trailing negation keeps the ignore file itself tracked.
const excludeFooter = `
.git/
.inlinediff/
node_modules/
bower_components/
vendor/
Pods/
Carthage/
target/
.venv/
venv/
__pycache__/
.pytest_cache/
.mypy_cache/
.ruff_cache/
.gradle/
.dart_tool/
.terraform/
.next/
.nuxt/
.svelte-kit/
.angular/
.turbo/
.parcel-cache/
.cache/
DerivedData/
.build/
!/.diffignore
`;

const diffIgnoreTemplate = `# Inline Diff ignore — same syntax as .gitignore. Edit freely.
# Dependency, virtual-env, and build-cache folders are always excluded automatically.
# This file covers build outputs and secrets — remove a line to start tracking that path.

# Build output
dist/
build/
out/
bin/
obj/
coverage/

# Secrets — Inline Diff does NOT honor .gitignore, so guard credentials explicitly.
.env
.env.*
!.env.example
!.env.sample
*.pem
*.key
`;

// Writes the template .diffignore on first init; never overwrites an existing one.
export async function ensureDiffIgnore(rootPath: string): Promise<void> {
  try {
    await writeFile(join(resolve(rootPath), diffIgnorePath), diffIgnoreTemplate, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
}

export async function reconcileDiffIgnore(rootPath: string): Promise<void> {
  await withProjectGitLock(rootPath, async () => {
    await syncDiffIgnore(rootPath);
  });
}

export async function syncDiffIgnore(rootPath: string): Promise<void> {
  const resolvedRoot = resolve(rootPath);
  let userContent = "";
  try {
    userContent = await readFile(join(resolvedRoot, diffIgnorePath), "utf8");
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
  }
  // Guarantee a newline between the user's rules and the mandatory floor so the floor keeps its own
  // lines even when the user's .diffignore has no trailing newline, independent of the footer shape.
  const separator = userContent.length === 0 || userContent.endsWith("\n") ? "" : "\n";
  await writeFile(
    join(gitRepositoryPath(resolvedRoot), "info", "exclude"),
    `${userContent}${separator}${excludeFooter}`,
    "utf8",
  );
}

// Untracked files that survive info/exclude (= .diffignore + mandatory floor), WITHOUT honoring the
// project's own .gitignore (no --exclude-standard). Git skips excluded folders natively, so
// node_modules and friends are never walked. Pass pathspecs to scope the query to specific files.
export async function listUntrackedUnignored(
  rootPath: string,
  pathspecs?: readonly string[],
): Promise<Set<string>> {
  if (pathspecs !== undefined && pathspecs.length === 0) {
    return new Set();
  }
  const excludePath = join(gitRepositoryPath(rootPath), "info", "exclude");
  const args = [
    "--literal-pathspecs",
    "ls-files",
    "--others",
    `--exclude-from=${excludePath}`,
    "-z",
  ];
  if (pathspecs !== undefined) {
    args.push("--", ...pathspecs);
  }
  const { stdout } = await runProjectGit(rootPath, args);
  return new Set(
    stdout
      .toString("utf8")
      .split("\0")
      .filter((path) => path.length > 0)
      .map(normalizeRelativePath),
  );
}

// Baseline-tracked files that the current rules now ignore. Reads the index only (--cached), so it
// never walks the working tree — node_modules and other excluded trees are never scanned.
export async function listIgnoredTrackedFiles(rootPath: string): Promise<Set<string>> {
  const excludePath = join(gitRepositoryPath(rootPath), "info", "exclude");
  const { stdout } = await runProjectGit(rootPath, [
    "ls-files",
    "--cached",
    "--ignored",
    `--exclude-from=${excludePath}`,
    "-z",
  ]);
  return new Set(
    stdout
      .toString("utf8")
      .split("\0")
      .filter((path) => path.length > 0)
      .map(normalizeRelativePath),
  );
}

// Drops baseline entries that the current rules now ignore, so they stop occupying the store and
// stop reappearing. Keeps the working file (--force-remove untracks only). Meant for startup /
// regenerate — between cleanups, scans already hide these via listIgnoredTrackedFiles, so a quick
// ignore/un-ignore toggle never untracks a file (it would otherwise resurface as "added").
export async function untrackIgnoredFiles(rootPath: string): Promise<void> {
  await withProjectGitLock(rootPath, async () => {
    await syncDiffIgnore(rootPath);
    const ignored = await listIgnoredTrackedFiles(rootPath);
    if (ignored.size === 0) {
      return;
    }
    await runProjectGit(
      rootPath,
      ["--literal-pathspecs", "update-index", "--force-remove", "-z", "--stdin"],
      { input: Buffer.from(`${[...ignored].join("\0")}\0`) },
    );
  });
}
