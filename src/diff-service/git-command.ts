import { spawn } from "node:child_process";
import { devNull, platform } from "node:os";
import { join, resolve } from "node:path";
import { isMissingPathError } from "../errors/fs-errors.ts";
import { createGitCommandOptions, type GitOptions } from "./git-command-options.ts";
import { killProcessTree } from "./git-process.ts";

export {
  createGitCommandOptions,
  defaultGitMaxStderrBytes,
  defaultGitMaxStdoutBytes,
  defaultReadOnlyGitTimeoutMilliseconds,
  defaultWriteGitTimeoutMilliseconds,
} from "./git-command-options.ts";

export type GitResult = { readonly stdout: Buffer };

const projectQueues = new Map<string, Promise<void>>();
type GitCommandOutputStream = "stderr" | "stdout";

export class GitCommandError extends Error {
  readonly exitCode: number;
  readonly stderr: string;

  constructor(args: readonly string[], exitCode: number, stderr: Buffer) {
    // Git emits diagnostics as UTF-8. This string is for surfacing/logging the failure, not for
    // byte-exact reproduction, so a rare non-UTF-8 locale message degrading gracefully is fine.
    const message = stderr.toString("utf8").trim();
    super(
      `git ${args.join(" ")} failed with exit code ${exitCode}${message ? `: ${message}` : ""}`,
    );
    this.exitCode = exitCode;
    this.stderr = message;
  }
}

export class GitCommandOutputLimitError extends Error {
  override readonly name = "GitCommandOutputLimitError";

  constructor(
    readonly args: readonly string[],
    readonly stream: GitCommandOutputStream,
    readonly maxBytes: number,
  ) {
    super(`git ${args.join(" ")} exceeded ${stream} limit of ${maxBytes} bytes`);
  }
}

export class GitCommandTimeoutError extends Error {
  override readonly name = "GitCommandTimeoutError";

  constructor(
    readonly args: readonly string[],
    readonly timeoutMilliseconds: number,
  ) {
    super(`git ${args.join(" ")} timed out after ${timeoutMilliseconds}ms`);
  }
}

export function gitRepositoryPath(rootPath: string): string {
  return join(resolve(rootPath), ".inlinediff", "repository");
}

export async function assertGitAvailable(): Promise<void> {
  try {
    await runGitExecutable(["--version"]);
  } catch (error) {
    if (isMissingExecutableError(error)) {
      throw new Error("Git is required. Install Git and ensure git is available in PATH.");
    }
    throw error;
  }
}

export function runProjectGit(
  rootPath: string,
  args: readonly string[],
  options: GitOptions = {},
): Promise<GitResult> {
  return runGitRepository(gitRepositoryPath(rootPath), resolve(rootPath), args, options);
}

export async function withProjectGitLock<T>(
  rootPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const resolvedRoot = resolve(rootPath);
  const key = platform() === "win32" ? resolvedRoot.toLowerCase() : resolvedRoot;
  const previous = projectQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  const tail = current.then(
    () => undefined,
    () => undefined,
  );
  projectQueues.set(key, tail);
  try {
    return await current;
  } finally {
    if (projectQueues.get(key) === tail) {
      projectQueues.delete(key);
    }
  }
}

export function runGitRepository(
  repositoryPath: string,
  workTreePath: string,
  args: readonly string[],
  options: GitOptions = {},
): Promise<GitResult> {
  return runGitExecutable([`--git-dir=${repositoryPath}`, `--work-tree=${workTreePath}`, ...args], {
    ...options,
    cwd: workTreePath,
  });
}

export function runGitExecutable(
  args: readonly string[],
  options: GitOptions = {},
): Promise<GitResult> {
  const gitOptions = createGitCommandOptions(args, options);
  return new Promise((resolvePromise, reject) => {
    const abortSignal = gitOptions.signal;
    if (abortSignal?.aborted === true) {
      reject(createAbortError(abortSignal));
      return;
    }

    const child = spawn("git", args, {
      cwd: gitOptions.cwd,
      detached: platform() !== "win32",
      env: createGitEnvironment(process.env),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let pendingKillError: Error | undefined;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      abortSignal?.removeEventListener("abort", abortCommand);
    };
    const settleRejected = (error: Error) => {
      if (settled) {
        return false;
      }
      settled = true;
      cleanup();
      reject(error);
      return true;
    };
    const settleResolved = (result: GitResult) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolvePromise(result);
    };
    const killAfterRejecting = (error: Error) => {
      if (settled || pendingKillError !== undefined) {
        return;
      }
      pendingKillError = error;
      void killProcessTree(child).finally(() => settleRejected(error));
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (settled || pendingKillError !== undefined) {
        return;
      }
      stdoutBytes += chunk.length;
      if (gitOptions.maxStdoutBytes !== undefined && stdoutBytes > gitOptions.maxStdoutBytes) {
        killAfterRejecting(
          new GitCommandOutputLimitError(args, "stdout", gitOptions.maxStdoutBytes),
        );
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (settled || pendingKillError !== undefined) {
        return;
      }
      stderrBytes += chunk.length;
      if (gitOptions.maxStderrBytes !== undefined && stderrBytes > gitOptions.maxStderrBytes) {
        killAfterRejecting(
          new GitCommandOutputLimitError(args, "stderr", gitOptions.maxStderrBytes),
        );
        return;
      }
      stderr.push(chunk);
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (pendingKillError === undefined && error.code !== "EPIPE") {
        settleRejected(error);
      }
    });
    child.on("error", (error) => {
      if (pendingKillError === undefined) {
        settleRejected(error);
      }
    });
    child.on("close", (exitCode) => {
      if (settled || pendingKillError !== undefined) {
        return;
      }
      const stderrBuffer = Buffer.concat(stderr);
      const resolvedExitCode = exitCode ?? -1;
      if (resolvedExitCode !== 0 && !gitOptions.allowedExitCodes?.includes(resolvedExitCode)) {
        settleRejected(new GitCommandError(args, resolvedExitCode, stderrBuffer));
        return;
      }
      settleResolved({
        stdout: Buffer.concat(stdout),
      });
    });
    function abortCommand() {
      killAfterRejecting(createAbortError(abortSignal));
    }

    abortSignal?.addEventListener("abort", abortCommand, { once: true });
    const timeoutMilliseconds = gitOptions.timeoutMilliseconds;
    if (timeoutMilliseconds !== undefined) {
      timeout = setTimeout(() => {
        killAfterRejecting(new GitCommandTimeoutError(args, timeoutMilliseconds));
      }, timeoutMilliseconds);
    }

    child.stdin.end(gitOptions.input);
  });
}

export function createGitEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (!key.toUpperCase().startsWith("GIT_")) {
      environment[key] = value;
    }
  }
  environment.GIT_CONFIG_GLOBAL = platform() === "win32" ? "NUL" : devNull;
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_TERMINAL_PROMPT = "0";
  // Stop read-only commands (diff/ls-files/status) from opportunistically rewriting the index's
  // stat cache. That write races with a concurrent read of the same index and fails on Windows
  // ("index file open failed: Permission denied"). Explicit writes (update-index) are unaffected.
  environment.GIT_OPTIONAL_LOCKS = "0";
  return environment;
}

function isMissingExecutableError(error: unknown): boolean {
  return isMissingPathError(error);
}

function createAbortError(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }
  return new Error("Git command aborted.");
}
