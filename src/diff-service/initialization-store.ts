import { mkdir, rm } from "node:fs/promises";
import { isPathExistsError } from "../errors/fs-errors.ts";

export interface InitializationStoreClaim {
  cleanupAfterFailure(): Promise<void>;
}

//
export async function tryClaimInitializationStore(
  storePath: string,
): Promise<InitializationStoreClaim | undefined> {
  try {
    await mkdir(storePath);
  } catch (error) {
    if (isPathExistsError(error)) {
      return undefined;
    }
    throw error;
  }
  return {
    cleanupAfterFailure: () => rm(storePath, { force: true, recursive: true }),
  };
}
