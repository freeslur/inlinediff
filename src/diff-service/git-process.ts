import { type ChildProcess, spawn } from "node:child_process";
import { platform } from "node:os";
import { isNoSuchProcessError } from "../errors/fs-errors.ts";

export function killProcessTree(child: ChildProcess): Promise<void> {
  const childPid = child.pid;
  if (platform() === "win32" && childPid !== undefined) {
    return killWindowsProcessTree(child, childPid);
  }
  if (childPid !== undefined && killPosixProcessGroup(childPid)) {
    return Promise.resolve();
  }
  child.kill();
  return Promise.resolve();
}

function killWindowsProcessTree(child: ChildProcess, childPid: number): Promise<void> {
  return new Promise((resolveKill) => {
    const killer = spawn("taskkill", ["/pid", String(childPid), "/t", "/f"], {
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    killer.on("error", () => {
      child.kill();
      resolveKill();
    });
    killer.on("close", () => resolveKill());
  });
}

function killPosixProcessGroup(childPid: number): boolean {
  try {
    process.kill(-childPid);
    return true;
  } catch (error) {
    return isNoSuchProcessError(error);
  }
}
