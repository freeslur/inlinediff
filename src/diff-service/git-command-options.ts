export interface GitOptions {
  readonly allowedExitCodes?: readonly number[];
  readonly cwd?: string;
  readonly input?: Uint8Array;
  readonly maxStderrBytes?: number;
  readonly maxStdoutBytes?: number;
  readonly signal?: AbortSignal;
  readonly timeoutMilliseconds?: number;
}

const mutatingGitCommands = new Set([
  "add",
  "apply",
  "checkout-index",
  "config",
  "hash-object",
  "init",
  "rm",
  "update-index",
]);

export const defaultGitMaxStderrBytes = 256 * 1024;
export const defaultGitMaxStdoutBytes = 8 * 1024 * 1024;
export const defaultReadOnlyGitTimeoutMilliseconds = 5_000;
export const defaultWriteGitTimeoutMilliseconds = 10_000;

export function createGitCommandOptions(
  args: readonly string[],
  options: GitOptions = {},
): GitOptions {
  return {
    ...options,
    maxStderrBytes: options.maxStderrBytes ?? defaultGitMaxStderrBytes,
    maxStdoutBytes: options.maxStdoutBytes ?? defaultGitMaxStdoutBytes,
    timeoutMilliseconds: options.timeoutMilliseconds ?? defaultTimeoutMilliseconds(args),
  };
}

function defaultTimeoutMilliseconds(args: readonly string[]): number {
  return mutatingGitCommands.has(findGitCommand(args))
    ? defaultWriteGitTimeoutMilliseconds
    : defaultReadOnlyGitTimeoutMilliseconds;
}

function findGitCommand(args: readonly string[]): string {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === "-c" || arg === "-C" || arg === "--git-dir" || arg === "--work-tree") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--git-dir=") || arg.startsWith("--work-tree=")) {
      continue;
    }
    if (arg.startsWith("-") && arg !== "--version") {
      continue;
    }
    return arg;
  }
  return "";
}
