import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { devNull, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { readBaselineFile, writeBaselineFile } from "../../src/diff-service/baseline-store.ts";
import {
  collectGarbage,
  createGitCommandOptions,
  createGitEnvironment,
  defaultGitMaxStderrBytes,
  defaultGitMaxStdoutBytes,
  defaultReadOnlyGitTimeoutMilliseconds,
  defaultWriteGitTimeoutMilliseconds,
  runGitExecutable,
  runProjectGit,
} from "../../src/diff-service/git-command.ts";
import { initializeProject } from "../../src/diff-service/project-initializer.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  // On Windows a just-killed Git child can briefly hold the temp dir open, so the
  // cleanup rm races against EBUSY. Retry instead of failing the whole suite.
  await Promise.all(
    temporaryRoots.map((root) =>
      rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
    ),
  );
  temporaryRoots.length = 0;
});

describe("createGitEnvironment", () => {
  test("removes inherited Git overrides and disables external configuration", () => {
    const environment = createGitEnvironment({
      GIT_DIR: "foreign-repository",
      Git_Index_File: "foreign-index",
      PATH: "git-path",
    });

    expect(environment.GIT_DIR).toBeUndefined();
    expect(environment.Git_Index_File).toBeUndefined();
    expect(environment.PATH).toBe("git-path");
    expect(environment.GIT_CONFIG_GLOBAL).toBe(platform() === "win32" ? "NUL" : devNull);
    expect(environment.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(environment.GIT_TERMINAL_PROMPT).toBe("0");
  });
});

describe("runGitExecutable", () => {
  test("uses bounded defaults for read-only Git commands", () => {
    const options = createGitCommandOptions(["--git-dir=repo", "--work-tree=work", "diff"]);

    expect(options.maxStderrBytes).toBe(defaultGitMaxStderrBytes);
    expect(options.maxStdoutBytes).toBe(defaultGitMaxStdoutBytes);
    expect(options.timeoutMilliseconds).toBe(defaultReadOnlyGitTimeoutMilliseconds);
  });

  test("uses a longer bounded timeout for mutating Git commands", () => {
    const options = createGitCommandOptions(["--git-dir=repo", "--work-tree=work", "add"]);
    const removeOptions = createGitCommandOptions(["--git-dir=repo", "--work-tree=work", "rm"]);

    expect(options.maxStderrBytes).toBe(defaultGitMaxStderrBytes);
    expect(options.maxStdoutBytes).toBe(defaultGitMaxStdoutBytes);
    expect(options.timeoutMilliseconds).toBe(defaultWriteGitTimeoutMilliseconds);
    expect(removeOptions.timeoutMilliseconds).toBe(defaultWriteGitTimeoutMilliseconds);
  });

  test("keeps explicit Git command limits", () => {
    const options = createGitCommandOptions(["add"], {
      maxStderrBytes: 2,
      maxStdoutBytes: 1,
      timeoutMilliseconds: 3,
    });

    expect(options.maxStderrBytes).toBe(2);
    expect(options.maxStdoutBytes).toBe(1);
    expect(options.timeoutMilliseconds).toBe(3);
  });

  test("rejects stdout that exceeds maxStdoutBytes", async () => {
    const error = await captureRejection(runGitExecutable(["--version"], { maxStdoutBytes: 1 }));

    expect(error.name).toBe("GitCommandOutputLimitError");
    expect("stream" in error ? error.stream : undefined).toBe("stdout");
    expect("maxBytes" in error ? error.maxBytes : undefined).toBe(1);
  });

  test("rejects stderr that exceeds maxStderrBytes before allowed exit codes resolve", async () => {
    const error = await captureRejection(
      runGitExecutable(["--definitely-not-inlinediff-option"], {
        allowedExitCodes: [129],
        maxStderrBytes: 1,
      }),
    );

    expect(error.name).toBe("GitCommandOutputLimitError");
    expect("stream" in error ? error.stream : undefined).toBe("stderr");
    expect("maxBytes" in error ? error.maxBytes : undefined).toBe(1);
  });

  test("rejects a long-running Git command after timeoutMilliseconds", async () => {
    const root = await createTemporaryRoot();
    const helperPath = join(root, "slow-git-helper.js");
    await writeFile(helperPath, "setTimeout(() => process.exit(0), 5000);\n", "utf8");

    // A generous timeout (vs. the 5s helper) keeps the assertion about timeout behavior while
    // leaving room for Git startup under heavy parallel test load, avoiding a timing race.
    const error = await captureRejection(
      runGitExecutable(
        [
          "-c",
          `alias.inlinediff-wait=!${quoteGitAliasArgument(process.execPath)} ${quoteGitAliasArgument(helperPath)}`,
          "inlinediff-wait",
        ],
        { cwd: root, timeoutMilliseconds: 250 },
      ),
    );

    expect(error.name).toBe("GitCommandTimeoutError");
    expect("timeoutMilliseconds" in error ? error.timeoutMilliseconds : undefined).toBe(250);
  });
});

describe("collectGarbage", () => {
  test("deletes superseded baseline blobs and keeps the current baseline readable", async () => {
    const root = await createTemporaryRoot();
    await initializeProject(root);
    // Each write's old blob becomes unreachable the moment the index moves to the new one.
    for (let index = 0; index < 5; index += 1) {
      await writeBaselineFile(root, "grows.ts", Buffer.from(`content-${index}`));
    }
    const beforeCount = await countLooseObjects(root);

    await collectGarbage(root);

    // The four superseded revisions are gone; everything the index references (including the
    // latest revision) must survive — the index is a reachability root for prune.
    expect(await countLooseObjects(root)).toBe(beforeCount - 4);
    expect(await readBaselineFile(root, "grows.ts")).toEqual(Buffer.from("content-4"));
  });

  test("resolves without throwing when the internal repository is missing", async () => {
    const root = await createTemporaryRoot();

    await collectGarbage(root);
  });
});

async function countLooseObjects(root: string): Promise<number> {
  const { stdout } = await runProjectGit(root, ["count-objects", "-v"]);
  const match = /^count: (\d+)/m.exec(stdout.toString("utf8"));
  if (match?.[1] === undefined) {
    throw new Error(`Unexpected "git count-objects -v" output: ${stdout.toString("utf8")}`);
  }
  return Number(match[1]);
}

async function createTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "inlinediff-git-command-test-"));
  temporaryRoots.push(root);
  return root;
}

async function captureRejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected git command to reject.");
}

function quoteGitAliasArgument(value: string): string {
  const normalized = value.replaceAll("\\", "/").replaceAll('"', '\\"');
  return `"${normalized}"`;
}
