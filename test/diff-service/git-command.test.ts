import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { devNull, platform, tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGitCommandOptions,
  createGitEnvironment,
  defaultGitMaxStderrBytes,
  defaultGitMaxStdoutBytes,
  defaultReadOnlyGitTimeoutMilliseconds,
  defaultWriteGitTimeoutMilliseconds,
  runGitExecutable,
} from "../../src/diff-service/git-command.ts";

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
